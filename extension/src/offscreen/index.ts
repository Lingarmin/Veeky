import type {
  ContentRef,
  MediaApiRequest,
  MediaApiResponse,
  MediaUploadProgressMessage,
  StartMediaUploadMessage,
} from "../shared/types";
import { OFFSCREEN_MEDIA_PORT } from "../shared/types";
import type { MediaSession, MediaUploadApi as VeekyMediaUploadApi } from "../sidepanel/api";

const MEDIA_PART_BYTES = 8 * 1024 * 1024;
const MAX_PART_ATTEMPTS = 3;
const DEFAULT_MAX_MEDIA_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;

export type MediaUploadApi = VeekyMediaUploadApi;

type FetchMedia = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface MediaPartSpool {
  write(partNumber: number, bytes: Uint8Array): Promise<void>;
  read(partNumber: number): Promise<Uint8Array>;
  dispose(): Promise<void>;
}

interface UploadDependencies {
  fetchMedia: FetchMedia;
  api: MediaUploadApi;
  reportProgress: (message: MediaUploadProgressMessage) => Promise<void>;
  createPartSpool?: () => Promise<MediaPartSpool>;
  cleanupPartSpools?: () => Promise<void>;
  limits?: {
    maxMediaBytes: number;
    maxPlaylistBytes: number;
  };
}

interface MediaPort {
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
  postMessage(message: unknown): void;
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
  const createPartSpool = dependencies.createPartSpool ?? createOpfsPartSpool;
  const limits = dependencies.limits ?? {
    maxMediaBytes: DEFAULT_MAX_MEDIA_BYTES,
    maxPlaylistBytes: DEFAULT_MAX_PLAYLIST_BYTES,
  };
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
      createPartSpool,
      limits.maxMediaBytes,
    );
  }
  return uploadHls(
    message.jobId,
    inspection.contentId,
    mediaUrl,
    fetchMedia,
    api,
    reportProgress,
    createPartSpool,
    limits,
  );
}

async function uploadMp4(
  jobId: string,
  contentId: string,
  mediaUrl: URL,
  fetchMedia: FetchMedia,
  api: MediaUploadApi,
  reportProgress: UploadDependencies["reportProgress"],
  createPartSpool: () => Promise<MediaPartSpool>,
  maxMediaBytes: number,
): Promise<string> {
  const { response } = await fetchWithBrowserCredentials(fetchMedia, mediaUrl);
  const declaredBytes = contentLength(response.headers.get("Content-Length"));
  if (declaredBytes !== null && declaredBytes > maxMediaBytes) {
    throw new UploadError("media_too_large", "The selected media exceeds the 4 GiB upload limit");
  }
  await reportProgress({
    type: "MEDIA_UPLOAD_PROGRESS",
    jobId,
    uploadedBytes: 0,
    totalBytes: declaredBytes,
  });

  if (declaredBytes === null) {
    return spoolAndUpload(
      jobId,
      contentId,
      "mp4",
      responseChunks(response),
      api,
      reportProgress,
      createPartSpool,
      maxMediaBytes,
    );
  }

  const partCount = Math.ceil(declaredBytes / MEDIA_PART_BYTES);
  const session = await createSession(api, contentId, "mp4", declaredBytes, partCount);
  try {
    let uploadedBytes = 0;
    let uploadedParts = 0;
    for await (const part of fixedSizeParts(response, MEDIA_PART_BYTES)) {
      if (uploadedBytes + part.byteLength > maxMediaBytes) {
        throw new UploadError("media_too_large", "The selected media exceeds the 4 GiB upload limit");
      }
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
  } catch (error) {
    await api.cancelMediaSession(session.sessionId).catch(() => undefined);
    throw error;
  }
}

async function uploadHls(
  jobId: string,
  contentId: string,
  playlistUrl: URL,
  fetchMedia: FetchMedia,
  api: MediaUploadApi,
  reportProgress: UploadDependencies["reportProgress"],
  createPartSpool: () => Promise<MediaPartSpool>,
  limits: NonNullable<UploadDependencies["limits"]>,
): Promise<string> {
  const master = await fetchText(fetchMedia, playlistUrl, limits.maxPlaylistBytes);
  validatePlaylistReferences(master.body, master.url);
  validateSupportedPlaylist(master.body);
  const variants = parseVariants(master.body, master.url);
  let mediaPlaylistUrl = master.url;
  let mediaPlaylist = master.body;
  if (variants.length > 0) {
    const selected = variants
      .filter((variant) => variant.height <= 1080)
      .sort((left, right) => right.bandwidth - left.bandwidth)[0];
    if (!selected) {
      throw new UploadError("unsupported_hls_variant", "The playlist has no variant at or below 1080p");
    }
    mediaPlaylistUrl = selected.url;
    const selectedPlaylist = await fetchText(fetchMedia, mediaPlaylistUrl, limits.maxPlaylistBytes);
    mediaPlaylistUrl = selectedPlaylist.url;
    mediaPlaylist = selectedPlaylist.body;
    validatePlaylistReferences(mediaPlaylist, mediaPlaylistUrl);
    validateSupportedPlaylist(mediaPlaylist);
    if (parseVariants(mediaPlaylist, mediaPlaylistUrl).length > 0) {
      throw new UploadError("unsupported_hls_playlist", "Nested HLS master playlists are not supported");
    }
  }

  const resourceUrls = parseMediaResources(mediaPlaylist, mediaPlaylistUrl);
  return spoolAndUpload(
    jobId,
    contentId,
    "hls",
    hlsChunks(resourceUrls, fetchMedia),
    api,
    reportProgress,
    createPartSpool,
    limits.maxMediaBytes,
  );
}

async function spoolAndUpload(
  jobId: string,
  contentId: string,
  kind: "mp4" | "hls",
  chunks: AsyncIterable<Uint8Array>,
  api: MediaUploadApi,
  reportProgress: UploadDependencies["reportProgress"],
  createPartSpool: () => Promise<MediaPartSpool>,
  maxMediaBytes: number,
): Promise<string> {
  const spool = await createPartSpool();
  let sessionId: string | null = null;
  let partCount = 0;
  let totalBytes = 0;
  try {
    try {
      for await (const part of toFixedChunks(limitMediaChunks(chunks, maxMediaBytes), MEDIA_PART_BYTES)) {
        await spool.write(partCount, part);
        partCount += 1;
        totalBytes += part.byteLength;
      }
      if (totalBytes <= 0 || partCount === 0) {
        throw new UploadError("empty_media", "The selected media is empty");
      }
      await reportProgress({
        type: "MEDIA_UPLOAD_PROGRESS",
        jobId,
        uploadedBytes: 0,
        totalBytes,
      });
      const session = await createSession(api, contentId, kind, totalBytes, partCount);
      sessionId = session.sessionId;
      let uploadedBytes = 0;
      for (let partNumber = 0; partNumber < partCount; partNumber += 1) {
        const part = await spool.read(partNumber);
        await uploadPartWithResume(api, sessionId, partNumber, part);
        uploadedBytes += part.byteLength;
        await reportProgress({
          type: "MEDIA_UPLOAD_PROGRESS",
          jobId,
          uploadedBytes,
          totalBytes,
        });
      }
      await api.completeMediaSession(sessionId, {
        kind,
        partCount,
        totalBytes,
        ...(kind === "hls" ? {
          manifest: { parts: Array.from({ length: partCount }, (_, index) => index) },
        } : {}),
      });
      return sessionId;
    } finally {
      await spool.dispose();
    }
  } catch (error) {
    if (sessionId) await api.cancelMediaSession(sessionId).catch(() => undefined);
    throw error;
  }
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
    await api.cancelMediaSession(session.sessionId).catch(() => undefined);
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

async function fetchWithBrowserCredentials(
  fetchMedia: FetchMedia,
  url: URL,
): Promise<{ response: Response; url: URL }> {
  const response = await fetchMedia(url.href, { credentials: "include", redirect: "error" });
  const finalUrl = response.url ? safeMediaUrl(response.url) : url;
  if (!response.ok) {
    throw new UploadError("media_fetch_failed", `Media request failed with status ${response.status}`);
  }
  return { response, url: finalUrl };
}

async function fetchText(
  fetchMedia: FetchMedia,
  url: URL,
  maxBytes: number,
): Promise<{ body: string; url: URL }> {
  const fetched = await fetchWithBrowserCredentials(fetchMedia, url);
  const { response } = fetched;
  const declaredBytes = contentLength(response.headers.get("Content-Length"));
  if (declaredBytes !== null && declaredBytes > maxBytes) {
    throw new UploadError("hls_playlist_too_large", "The HLS playlist exceeds the 2 MiB limit");
  }
  const decoder = new TextDecoder();
  let body = "";
  let bytesRead = 0;
  for await (const chunk of responseChunks(response)) {
    bytesRead += chunk.byteLength;
    if (bytesRead > maxBytes) {
      throw new UploadError("hls_playlist_too_large", "The HLS playlist exceeds the 2 MiB limit");
    }
    body += decoder.decode(chunk, { stream: true });
  }
  body += decoder.decode();
  if (!body.trimStart().startsWith("#EXTM3U")) {
    throw new UploadError("invalid_hls_playlist", "The media response is not an HLS playlist");
  }
  return { body, url: fetched.url };
}

async function* hlsChunks(urls: URL[], fetchMedia: FetchMedia): AsyncGenerator<Uint8Array> {
  for (const url of urls) {
    const { response } = await fetchWithBrowserCredentials(fetchMedia, url);
    for await (const chunk of responseChunks(response)) yield chunk;
  }
}

async function* fixedSizeParts(response: Response, partSize: number): AsyncGenerator<Uint8Array> {
  yield* toFixedChunks(responseChunks(response), partSize);
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
    throw new UploadError("media_stream_unavailable", "The media response has no readable stream");
  }
  const reader = response.body.getReader();
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      if (value.byteLength > 0) yield value;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function* limitMediaChunks(
  chunks: AsyncIterable<Uint8Array>,
  maxBytes: number,
): AsyncGenerator<Uint8Array> {
  let totalBytes = 0;
  for await (const chunk of chunks) {
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) {
      throw new UploadError("media_too_large", "The selected media exceeds the 4 GiB upload limit");
    }
    yield chunk;
  }
}

function validatePlaylistReferences(playlist: string, baseUrl: URL): void {
  for (const line of playlist.split(/\r?\n/).map((value) => value.trim())) {
    if (!line.startsWith("#EXT") || !line.includes(":")) continue;
    const attributes = parseAttributeList(line.slice(line.indexOf(":") + 1));
    for (const [name, value] of attributes) {
      if (!name.endsWith("URI")) continue;
      if (!value) {
        throw new UploadError("invalid_hls_playlist", `The ${name} attribute is empty`);
      }
      resolveMediaUrl(value, baseUrl);
    }
  }
}

function validateSupportedPlaylist(playlist: string): void {
  const lines = playlist.split(/\r?\n/).map((line) => line.trim().toUpperCase());
  if (lines.filter((line) => line.startsWith("#EXT-X-MAP:")).length > 1) {
    throw new UploadError("unsupported_hls_playlist", "Multiple HLS init-map transitions are not supported");
  }
  const unsupportedTags = [
    "#EXT-X-BYTERANGE:",
    "#EXT-X-PART:",
    "#EXT-X-PART-INF:",
    "#EXT-X-PRELOAD-HINT:",
    "#EXT-X-SKIP:",
    "#EXT-X-RENDITION-REPORT:",
    "#EXT-X-SERVER-CONTROL:",
    "#EXT-X-DISCONTINUITY",
    "#EXT-X-GAP",
    "#EXT-X-I-FRAMES-ONLY",
    "#EXT-X-I-FRAME-STREAM-INF:",
    "#EXT-X-MEDIA:",
    "#EXT-X-CONTENT-STEERING:",
    "#EXT-X-DEFINE:",
  ];
  for (const line of lines) {
    if (unsupportedTags.some((tag) => line.startsWith(tag))) {
      throw new UploadError("unsupported_hls_playlist", "The HLS playlist requires unsupported assembly features");
    }
    if (line.startsWith("#EXT-X-MAP:") && /(?:^|,)BYTERANGE=/i.test(line.slice(line.indexOf(":") + 1))) {
      throw new UploadError("unsupported_hls_playlist", "Byte-ranged HLS init segments are not supported");
    }
    if (line.startsWith("#EXT-X-KEY:") || line.startsWith("#EXT-X-SESSION-KEY:")) {
      const method = new Map(parseAttributeList(line.slice(line.indexOf(":") + 1))).get("METHOD");
      if (method?.toUpperCase() !== "NONE") {
        throw new UploadError("unsupported_hls_playlist", "Encrypted HLS playlists are not supported");
      }
    }
  }
}

function parseAttributeList(value: string): Array<[string, string]> {
  const attributes: Array<[string, string]> = [];
  let offset = 0;
  while (offset < value.length) {
    while (offset < value.length && (value[offset] === "," || /\s/.test(value[offset]))) offset += 1;
    const nameStart = offset;
    while (offset < value.length && /[A-Za-z0-9-]/.test(value[offset])) offset += 1;
    const name = value.slice(nameStart, offset).toUpperCase();
    while (offset < value.length && /\s/.test(value[offset])) offset += 1;
    if (!name || value[offset] !== "=") {
      while (offset < value.length && value[offset] !== ",") offset += 1;
      continue;
    }
    offset += 1;
    while (offset < value.length && /\s/.test(value[offset])) offset += 1;
    let attributeValue: string;
    if (value[offset] === "\"") {
      offset += 1;
      const valueStart = offset;
      while (offset < value.length && value[offset] !== "\"") offset += 1;
      attributeValue = value.slice(valueStart, offset);
      if (value[offset] === "\"") offset += 1;
    } else {
      const valueStart = offset;
      while (offset < value.length && value[offset] !== ",") offset += 1;
      attributeValue = value.slice(valueStart, offset).trim();
    }
    attributes.push([name, attributeValue]);
    while (offset < value.length && value[offset] !== ",") offset += 1;
  }
  return attributes;
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
    const parsedAttributes = new Map(parseAttributeList(attributes));
    const bandwidthValue = parsedAttributes.get("BANDWIDTH") ?? "";
    const resolution = /^(\d+)x(\d+)$/i.exec(parsedAttributes.get("RESOLUTION") ?? "");
    const bandwidth = /^\d+$/.test(bandwidthValue) ? Number(bandwidthValue) : Number.NaN;
    const width = Number(resolution?.[1]);
    const height = Number(resolution?.[2]);
    if (
      !Number.isSafeInteger(bandwidth)
      || bandwidth <= 0
      || !Number.isSafeInteger(width)
      || width <= 0
      || !Number.isSafeInteger(height)
      || height <= 0
    ) {
      throw new UploadError("unsupported_hls_playlist", "Every HLS master variant needs valid bandwidth and resolution");
    }
    let uri = "";
    for (let next = index + 1; next < lines.length; next += 1) {
      if (!lines[next]) continue;
      if (lines[next].startsWith("#")) break;
      uri = lines[next];
      break;
    }
    if (!uri) {
      throw new UploadError("unsupported_hls_playlist", "Every HLS master variant needs a media playlist URI");
    }
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

async function createOpfsPartSpool(): Promise<MediaPartSpool> {
  const storage = navigator.storage as StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
  };
  if (!storage?.getDirectory) {
    throw new UploadError("media_spool_unavailable", "Browser media storage is unavailable");
  }
  const root = await storage.getDirectory();
  const directoryName = `veeky-media-${crypto.randomUUID()}`;
  const directory = await root.getDirectoryHandle(directoryName, { create: true });
  const filename = (partNumber: number) => `part-${String(partNumber).padStart(8, "0")}.bin`;

  return {
    async write(partNumber, bytes) {
      const handle = await directory.getFileHandle(filename(partNumber), { create: true });
      const writable = await handle.createWritable();
      const body = new Uint8Array(bytes.byteLength);
      body.set(bytes);
      try {
        await writable.write(body.buffer);
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => undefined);
        throw error;
      }
    },
    async read(partNumber) {
      const handle = await directory.getFileHandle(filename(partNumber));
      // Each OPFS file is capped at one media part, so this allocation cannot grow with the full video.
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    },
    async dispose() {
      await root.removeEntry(directoryName, { recursive: true });
    },
  };
}

async function cleanupOpfsPartSpools(): Promise<void> {
  const storage = navigator.storage as StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
  };
  if (!storage?.getDirectory) return;
  const root = await storage.getDirectory();
  const entries = (root as FileSystemDirectoryHandle & {
    entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
  }).entries();
  for await (const [name, handle] of entries) {
    if (handle.kind === "directory" && name.startsWith("veeky-media-")) {
      await root.removeEntry(name, { recursive: true });
    }
  }
}

export function createReconnectingMediaPort(
  runtime: Pick<typeof chrome.runtime, "connect">,
): MediaPort {
  const messageListeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  let currentPort: chrome.runtime.Port | null = null;
  let reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  const connect = () => {
    if (reconnectTimer !== null) {
      globalThis.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    let port: chrome.runtime.Port;
    try {
      port = runtime.connect({ name: OFFSCREEN_MEDIA_PORT });
    } catch {
      reconnectTimer = globalThis.setTimeout(connect, 250);
      return;
    }
    currentPort = port;
    port.onMessage.addListener((message: unknown) => {
      for (const listener of messageListeners) listener(message);
    });
    port.onDisconnect.addListener(() => {
      if (currentPort !== port) return;
      currentPort = null;
      connect();
      for (const listener of disconnectListeners) listener();
    });
  };
  connect();

  return {
    onMessage: {
      addListener(listener) { messageListeners.add(listener); },
    },
    onDisconnect: {
      addListener(listener) { disconnectListeners.add(listener); },
    },
    postMessage(message) {
      if (!currentPort) throw new Error("Offscreen media port is disconnected");
      currentPort.postMessage(message);
    },
  };
}

function createPortMediaApi(port: MediaPort): MediaUploadApi {
  const pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  port.onMessage.addListener((message: unknown) => {
    if (!isMediaApiResponse(message)) return;
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId);
    if (message.ok) {
      request.resolve(message.result);
      return;
    }
    const error = new Error(message.error?.message ?? "Media API request failed") as Error & { code?: string };
    error.code = message.error?.code ?? "media_api_failed";
    request.reject(error);
  });
  port.onDisconnect.addListener(() => {
    for (const request of pending.values()) request.reject(new Error("Media API port disconnected"));
    pending.clear();
  });

  const request = <T>(operation: MediaApiRequest["operation"], args: unknown[]): Promise<T> => {
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        port.postMessage({ type: "MEDIA_API_REQUEST", requestId, operation, args } satisfies MediaApiRequest);
      } catch (error) {
        pending.delete(requestId);
        reject(error);
      }
    });
  };

  return {
    inspect: (input) => request("inspect", [input]),
    createMediaSession: (input) => request("createMediaSession", [input]),
    getMediaSession: (sessionId) => request("getMediaSession", [sessionId]),
    uploadPart: (sessionId, partNumber, bytes, sha256) => request(
      "uploadPart",
      [sessionId, partNumber, bytes, sha256],
    ),
    completeMediaSession: (sessionId, input) => request("completeMediaSession", [sessionId, input]),
    cancelMediaSession: (sessionId) => request("cancelMediaSession", [sessionId]),
  };
}

export function installOffscreenHandlers(
  port: MediaPort,
  provided: Partial<UploadDependencies> = {},
): () => string | null {
  const dependencies: UploadDependencies = {
    fetchMedia: provided.fetchMedia ?? globalThis.fetch.bind(globalThis),
    api: provided.api ?? createPortMediaApi(port),
    reportProgress: provided.reportProgress ?? (async (message) => { port.postMessage(message); }),
    createPartSpool: provided.createPartSpool ?? createOpfsPartSpool,
    cleanupPartSpools: provided.cleanupPartSpools ?? cleanupOpfsPartSpools,
    limits: provided.limits ?? {
      maxMediaBytes: DEFAULT_MAX_MEDIA_BYTES,
      maxPlaylistBytes: DEFAULT_MAX_PLAYLIST_BYTES,
    },
  };
  let activeJobId: string | null = null;
  const cleanup = dependencies.cleanupPartSpools?.().catch(() => undefined) ?? Promise.resolve();
  port.onMessage.addListener((message: unknown) => {
    if (!isStartMediaUploadMessage(message)) return;
    if (activeJobId === message.jobId) return;
    if (activeJobId !== null) {
      port.postMessage({
        type: "MEDIA_UPLOAD_FAILED",
        jobId: message.jobId,
        code: "media_upload_in_progress",
      });
      return;
    }
    activeJobId = message.jobId;
    void cleanup.then(() => uploadMediaCandidate(message, dependencies))
      .then((mediaSessionId) => port.postMessage({
        type: "MEDIA_UPLOAD_COMPLETE",
        jobId: message.jobId,
        mediaSessionId,
      }))
      .catch((error) => port.postMessage({
        type: "MEDIA_UPLOAD_FAILED",
        jobId: message.jobId,
        code: errorCode(error),
      }))
      .finally(() => {
        if (activeJobId === message.jobId) activeJobId = null;
      });
  });
  return () => activeJobId;
}

function isStartMediaUploadMessage(message: unknown): message is StartMediaUploadMessage {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as Partial<StartMediaUploadMessage>;
  return candidate.type === "START_MEDIA_UPLOAD"
    && Number.isInteger(candidate.tabId)
    && typeof candidate.jobId === "string"
    && typeof candidate.contentRef === "object"
    && candidate.contentRef !== null
    && typeof candidate.candidate === "object"
    && candidate.candidate !== null;
}

function isMediaApiResponse(message: unknown): message is MediaApiResponse {
  if (typeof message !== "object" || message === null) return false;
  const response = message as Partial<MediaApiResponse>;
  return response.type === "MEDIA_API_RESPONSE"
    && typeof response.requestId === "string"
    && typeof response.ok === "boolean";
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "media_upload_failed";
}

if (typeof chrome !== "undefined") {
  const port = createReconnectingMediaPort(chrome.runtime);
  const activeJobId = installOffscreenHandlers(port);
  globalThis.setInterval(() => {
    try {
      port.postMessage({ type: "MEDIA_UPLOAD_HEARTBEAT", jobId: activeJobId() });
    } catch {
      // The reconnect loop will restore the channel.
    }
  }, 20_000);
}
