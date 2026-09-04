import type {
  ContentRef,
  ExtensionMessage,
  MediaUploadProgressMessage,
  StartMediaUploadMessage,
} from "../shared/types";
import {
  createApi,
  type MediaSession,
  type MediaUploadApi as VeekyMediaUploadApi,
} from "../sidepanel/api";

const MEDIA_PART_BYTES = 8 * 1024 * 1024;
const MAX_PART_ATTEMPTS = 3;

export type MediaUploadApi = VeekyMediaUploadApi;

type FetchMedia = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface UploadDependencies {
  fetchMedia: FetchMedia;
  api: MediaUploadApi;
  reportProgress: (message: MediaUploadProgressMessage) => Promise<void>;
}

class UploadError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UploadError";
  }
}

export async function uploadMediaCandidate(
  message: StartMediaUploadMessage,
  dependencies: UploadDependencies,
): Promise<string> {
  const { fetchMedia, api, reportProgress } = dependencies;
  const mediaUrl = safeMediaUrl(message.candidate.url);
  if (message.candidate.kind !== "mp4" && message.candidate.kind !== "hls") {
    throw new UploadError("unsupported_media_candidate", "The selected media is not an MP4 or HLS playlist");
  }

  const inspection = await api.inspect({
    url: contentUrl(message.contentRef),
    activeMediaIndex: message.contentRef.mediaIndex,
  });
  if (!sameContentRef(inspection.contentRef, message.contentRef)) {
    throw new UploadError("content_mismatch", "The media does not match the selected X video");
  }

  if (message.candidate.kind === "mp4") {
    return uploadMp4(
      message.jobId,
      inspection.contentId,
      mediaUrl,
      fetchMedia,
      api,
      reportProgress,
    );
  }
  return uploadHls(
    message.jobId,
    inspection.contentId,
    mediaUrl,
    fetchMedia,
    api,
    reportProgress,
  );
}

async function uploadMp4(
  jobId: string,
  contentId: string,
  mediaUrl: URL,
  fetchMedia: FetchMedia,
  api: MediaUploadApi,
  reportProgress: UploadDependencies["reportProgress"],
): Promise<string> {
  const response = await fetchWithBrowserCredentials(fetchMedia, mediaUrl);
  const declaredBytes = contentLength(response.headers.get("Content-Length"));
  await reportProgress({
    type: "MEDIA_UPLOAD_PROGRESS",
    jobId,
    uploadedBytes: 0,
    totalBytes: declaredBytes,
  });

  if (declaredBytes === null) {
    const parts = await collectParts(response, MEDIA_PART_BYTES);
    const totalBytes = parts.reduce((total, part) => total + part.byteLength, 0);
    return uploadParts(jobId, contentId, "mp4", parts, totalBytes, api, reportProgress);
  }

  const partCount = Math.ceil(declaredBytes / MEDIA_PART_BYTES);
  const session = await createSession(api, contentId, "mp4", declaredBytes, partCount);
  let uploadedBytes = 0;
  let uploadedParts = 0;
  for await (const part of fixedSizeParts(response, MEDIA_PART_BYTES)) {
    if (uploadedBytes + part.byteLength > declaredBytes || uploadedParts >= partCount) {
      throw new UploadError("media_size_mismatch", "The MP4 exceeded its declared Content-Length");
    }
    await uploadPartWithResume(api, session.sessionId, uploadedParts, part);
    uploadedParts += 1;
    uploadedBytes += part.byteLength;
    await reportProgress({
      type: "MEDIA_UPLOAD_PROGRESS",
      jobId,
      uploadedBytes,
      totalBytes: declaredBytes,
    });
  }
  if (uploadedBytes !== declaredBytes || uploadedParts !== partCount) {
    throw new UploadError("media_size_mismatch", "The MP4 did not match its declared Content-Length");
  }
  await api.completeMediaSession(session.sessionId, {
    kind: "mp4",
    partCount,
    totalBytes: uploadedBytes,
  });
  return session.sessionId;
}

async function uploadHls(
  jobId: string,
  contentId: string,
  playlistUrl: URL,
  fetchMedia: FetchMedia,
  api: MediaUploadApi,
  reportProgress: UploadDependencies["reportProgress"],
): Promise<string> {
  const master = await fetchText(fetchMedia, playlistUrl);
  const variants = parseVariants(master, playlistUrl);
  let mediaPlaylistUrl = playlistUrl;
  let mediaPlaylist = master;
  if (variants.length > 0) {
    const selected = variants
      .filter((variant) => variant.height <= 1080)
      .sort((left, right) => right.bandwidth - left.bandwidth)[0];
    if (!selected) {
      throw new UploadError("unsupported_hls_variant", "The playlist has no variant at or below 1080p");
    }
    mediaPlaylistUrl = selected.url;
    mediaPlaylist = await fetchText(fetchMedia, mediaPlaylistUrl);
  }

  const resourceUrls = parseMediaResources(mediaPlaylist, mediaPlaylistUrl);
  const parts = await collectHlsParts(resourceUrls, fetchMedia);
  const totalBytes = parts.reduce((total, part) => total + part.byteLength, 0);
  await reportProgress({
    type: "MEDIA_UPLOAD_PROGRESS",
    jobId,
    uploadedBytes: 0,
    totalBytes,
  });
  return uploadParts(jobId, contentId, "hls", parts, totalBytes, api, reportProgress);
}

async function uploadParts(
  jobId: string,
  contentId: string,
  kind: "mp4" | "hls",
  parts: Uint8Array[],
  totalBytes: number,
  api: MediaUploadApi,
  reportProgress: UploadDependencies["reportProgress"],
): Promise<string> {
  if (totalBytes <= 0 || parts.length === 0) {
    throw new UploadError("empty_media", "The selected media is empty");
  }
  const session = await createSession(api, contentId, kind, totalBytes, parts.length);
  let uploadedBytes = 0;
  for (const [partNumber, part] of parts.entries()) {
    await uploadPartWithResume(api, session.sessionId, partNumber, part);
    uploadedBytes += part.byteLength;
    await reportProgress({
      type: "MEDIA_UPLOAD_PROGRESS",
      jobId,
      uploadedBytes,
      totalBytes,
    });
  }
  await api.completeMediaSession(session.sessionId, {
    kind,
    partCount: parts.length,
    totalBytes,
    ...(kind === "hls" ? { manifest: { parts: parts.map((_, index) => index) } } : {}),
  });
  return session.sessionId;
}

async function createSession(
  api: MediaUploadApi,
  contentId: string,
  kind: "mp4" | "hls",
  expectedBytes: number,
  partCount: number,
): Promise<MediaSession> {
  if (expectedBytes <= 0 || partCount <= 0) {
    throw new UploadError("empty_media", "The selected media is empty");
  }
  const session = await api.createMediaSession({ contentId, kind, expectedBytes, partCount });
  if (session.partSizeBytes !== MEDIA_PART_BYTES) {
    throw new UploadError("incompatible_part_size", "The server requires a different media part size");
  }
  return session;
}

async function uploadPartWithResume(
  api: MediaUploadApi,
  sessionId: string,
  partNumber: number,
  part: Uint8Array,
): Promise<void> {
  const sha256 = await sha256Hex(part);
  for (let attempt = 0; attempt < MAX_PART_ATTEMPTS; attempt += 1) {
    try {
      await api.uploadPart(sessionId, partNumber, part, sha256);
      return;
    } catch (error) {
      if (attempt === MAX_PART_ATTEMPTS - 1) throw error;
      const status = await api.getMediaSession(sessionId);
      if (status.uploadedParts.includes(partNumber)) return;
    }
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchWithBrowserCredentials(fetchMedia: FetchMedia, url: URL): Promise<Response> {
  const response = await fetchMedia(url.href, { credentials: "include" });
  if (!response.ok) {
    throw new UploadError("media_fetch_failed", `Media request failed with status ${response.status}`);
  }
  return response;
}

async function fetchText(fetchMedia: FetchMedia, url: URL): Promise<string> {
  const response = await fetchWithBrowserCredentials(fetchMedia, url);
  const body = await response.text();
  if (!body.trimStart().startsWith("#EXTM3U")) {
    throw new UploadError("invalid_hls_playlist", "The media response is not an HLS playlist");
  }
  return body;
}

async function collectParts(response: Response, partSize: number): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [];
  for await (const part of fixedSizeParts(response, partSize)) parts.push(part);
  return parts;
}

async function collectHlsParts(urls: URL[], fetchMedia: FetchMedia): Promise<Uint8Array[]> {
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for (const url of urls) {
      const response = await fetchWithBrowserCredentials(fetchMedia, url);
      for await (const chunk of responseChunks(response)) yield chunk;
    }
  }
  return collectFixedChunks(chunks(), MEDIA_PART_BYTES);
}

async function* fixedSizeParts(response: Response, partSize: number): AsyncGenerator<Uint8Array> {
  yield* toFixedChunks(responseChunks(response), partSize);
}

async function collectFixedChunks(
  chunks: AsyncIterable<Uint8Array>,
  partSize: number,
): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [];
  for await (const part of toFixedChunks(chunks, partSize)) parts.push(part);
  return parts;
}

async function* toFixedChunks(
  chunks: AsyncIterable<Uint8Array>,
  partSize: number,
): AsyncGenerator<Uint8Array> {
  let part = new Uint8Array(partSize);
  let used = 0;
  for await (const chunk of chunks) {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const copied = Math.min(partSize - used, chunk.byteLength - offset);
      part.set(chunk.subarray(offset, offset + copied), used);
      used += copied;
      offset += copied;
      if (used === partSize) {
        yield part;
        part = new Uint8Array(partSize);
        used = 0;
      }
    }
  }
  if (used > 0) yield part.slice(0, used);
}

async function* responseChunks(response: Response): AsyncGenerator<Uint8Array> {
  if (!response.body) {
    yield new Uint8Array(await response.arrayBuffer());
    return;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value.byteLength > 0) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseVariants(playlist: string, baseUrl: URL): Array<{
  url: URL;
  bandwidth: number;
  height: number;
}> {
  const lines = playlist.split(/\r?\n/).map((line) => line.trim());
  const variants: Array<{ url: URL; bandwidth: number; height: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.toUpperCase().startsWith("#EXT-X-STREAM-INF:")) continue;
    const attributes = line.slice(line.indexOf(":") + 1);
    const bandwidth = Number(/(?:^|,)BANDWIDTH=(\d+)/i.exec(attributes)?.[1]);
    const height = Number(/(?:^|,)RESOLUTION=\d+x(\d+)/i.exec(attributes)?.[1]);
    let uri = "";
    for (let next = index + 1; next < lines.length; next += 1) {
      if (!lines[next] || lines[next].startsWith("#")) continue;
      uri = lines[next];
      break;
    }
    if (!uri || !Number.isSafeInteger(bandwidth) || !Number.isSafeInteger(height)) continue;
    variants.push({ url: resolveMediaUrl(uri, baseUrl), bandwidth, height });
  }
  return variants;
}

function parseMediaResources(playlist: string, baseUrl: URL): URL[] {
  const lines = playlist.split(/\r?\n/).map((line) => line.trim());
  const resources: URL[] = [];
  const mapLine = lines.find((line) => line.toUpperCase().startsWith("#EXT-X-MAP:"));
  if (mapLine) {
    const match = /(?:^|,)URI=(?:"([^"]+)"|([^,\s]+))/i.exec(mapLine.slice(mapLine.indexOf(":") + 1));
    const uri = match?.[1] ?? match?.[2];
    if (!uri) throw new UploadError("invalid_hls_playlist", "The HLS init segment URI is invalid");
    resources.push(resolveMediaUrl(uri, baseUrl));
  }
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    resources.push(resolveMediaUrl(line, baseUrl));
  }
  if (resources.length === 0) {
    throw new UploadError("invalid_hls_playlist", "The HLS playlist has no media segments");
  }
  return resources;
}

function resolveMediaUrl(reference: string, baseUrl: URL): URL {
  let resolved: URL;
  try {
    resolved = new URL(reference, baseUrl);
  } catch (error) {
    throw new UploadError("invalid_media_url", "The playlist contains an invalid URL", { cause: error });
  }
  return safeMediaUrl(resolved.href);
}

function safeMediaUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new UploadError("invalid_media_url", "The media URL is invalid", { cause: error });
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== "video.twimg.com"
    || url.port
    || url.username
    || url.password
    || url.hash
  ) {
    throw new UploadError("invalid_media_url", "Media URLs must use HTTPS on video.twimg.com");
  }
  return url;
}

function contentLength(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) && length > 0 ? length : null;
}

function contentUrl(contentRef: ContentRef): string {
  return `https://x.com/i/status/${contentRef.sourceContentId}/video/${contentRef.mediaIndex}`;
}

function sameContentRef(left: ContentRef, right: ContentRef): boolean {
  return left.platform === right.platform
    && left.sourceContentId === right.sourceContentId
    && left.mediaIndex === right.mediaIndex;
}

export function installOffscreenHandlers(
  chromeApi: Pick<typeof chrome, "runtime">,
  dependencies: UploadDependencies = {
    fetchMedia: globalThis.fetch.bind(globalThis),
    api: createApi(),
    reportProgress: (message) => chromeApi.runtime.sendMessage(message).then(() => undefined),
  },
): void {
  const uploads = new Map<string, Promise<void>>();
  chromeApi.runtime.onMessage.addListener((message: ExtensionMessage) => {
    if (message.type !== "START_MEDIA_UPLOAD" || uploads.has(message.jobId)) return;
    const upload = uploadMediaCandidate(message, dependencies)
      .then((mediaSessionId) => chromeApi.runtime.sendMessage({
        type: "MEDIA_UPLOAD_COMPLETE",
        jobId: message.jobId,
        mediaSessionId,
      }))
      .catch((error) => chromeApi.runtime.sendMessage({
        type: "MEDIA_UPLOAD_FAILED",
        jobId: message.jobId,
        code: errorCode(error),
      }))
      .then(() => undefined)
      .finally(() => uploads.delete(message.jobId));
    uploads.set(message.jobId, upload);
  });
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "media_upload_failed";
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  installOffscreenHandlers(chrome);
}
