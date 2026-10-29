import { normalizeYouTubeVideoId, parseYouTubeCaptions, type YouTubeCaptionTrack } from "./youtube-captions";
import type { TranscriptSegment } from "../shared/types";

export const MAX_VIDEO_DURATION_MS = 4 * 60 * 60 * 1000;
const MAX_CAPTION_BYTES = 16 * 1024 * 1024;
export interface YouTubeMetadata {
  videoId: string;
  title: string;
  durationMs: number;
  tracks: YouTubeCaptionTrack[];
}

export function localError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

// This function is serialized into MAIN world. Keep it self-contained and return
// only small, explicitly selected fields; never send extension configuration in.
export function readYouTubePageMetadata(expectedId: string): unknown {
  const player = document.getElementById("movie_player") as (HTMLElement & {
    getPlayerResponse?: () => Record<string, any>;
  }) | null;
  const page = window as unknown as { ytInitialPlayerResponse?: Record<string, any> };
  const response = player?.getPlayerResponse?.() ?? page.ytInitialPlayerResponse;
  const details = response?.videoDetails;
  if (!details || details.videoId !== expectedId || details.isLiveContent === true && !Number(details.lengthSeconds)) return null;
  const rows = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  return {
    videoId: String(details.videoId),
    title: typeof details.title === "string" ? details.title.slice(0, 1000) : "YouTube video",
    durationMs: Math.round(Number(details.lengthSeconds) * 1000),
    tracks: Array.isArray(rows) ? rows.slice(0, 100).map((track: any) => ({
      baseUrl: typeof track.baseUrl === "string" ? track.baseUrl.slice(0, 16_384) : "",
      languageCode: typeof track.languageCode === "string" ? track.languageCode.slice(0, 80) : "",
      languageName: typeof track.name?.simpleText === "string" ? track.name.simpleText.slice(0, 200)
        : Array.isArray(track.name?.runs) ? track.name.runs.slice(0, 10).map((run: any) => String(run.text ?? "").slice(0, 200)).join("") : "",
      isGenerated: track.kind === "asr",
      isTranslatable: track.isTranslatable === true,
    })) : [],
  };
}

function captionUrl(value: unknown, videoId: string): URL | null {
  if (typeof value !== "string" || value.length > 16_384 || /[\s\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || !["www.youtube.com", "youtube.com", "m.youtube.com"].includes(url.hostname)
      || url.pathname !== "/api/timedtext" || url.hash
      || url.searchParams.has("v") && url.searchParams.get("v") !== videoId) return null;
    return url;
  } catch { return null; }
}

export function validateYouTubeMetadata(raw: unknown, videoId: string): YouTubeMetadata {
  if (!raw || typeof raw !== "object") throw localError("video_metadata_unavailable");
  const value = raw as Partial<YouTubeMetadata>;
  if (value.videoId !== videoId) throw localError("video_context_changed");
  if (!Number.isSafeInteger(value.durationMs) || value.durationMs! <= 0) throw localError("video_metadata_unavailable");
  if (value.durationMs! > MAX_VIDEO_DURATION_MS) throw localError("video_too_long");
  const tracks = Array.isArray(value.tracks) ? value.tracks.slice(0, 100).filter((track) =>
    track && captionUrl(track.baseUrl, videoId) && typeof track.languageCode === "string" && track.languageCode.length > 0
    && track.languageCode.length < 80,
  ).map((track) => ({
    baseUrl: track.baseUrl, languageCode: track.languageCode,
    languageName: typeof track.languageName === "string" ? track.languageName.slice(0, 200) : track.languageCode,
    isGenerated: track.isGenerated === true, isTranslatable: track.isTranslatable === true,
  })) : [];
  return { videoId, title: typeof value.title === "string" ? value.title.slice(0, 1000) : "YouTube video", durationMs: value.durationMs!, tracks };
}

/** Runs only in an extension context with tabs/scripting access. */
export async function readYouTubeMetadata(url: string, chromeApi: Pick<typeof chrome, "tabs" | "scripting"> = chrome): Promise<YouTubeMetadata> {
  const videoId = normalizeYouTubeVideoId(url);
  if (!videoId) throw localError("invalid_video_url");
  const tabs = await chromeApi.tabs.query({ url: ["https://*.youtube.com/*"] });
  let tab = tabs.find((item) => normalizeYouTubeVideoId(item.url ?? "") === videoId);
  let created = false;
  if (!tab) {
    tab = await chromeApi.tabs.create({ url: `https://www.youtube.com/watch?v=${videoId}`, active: false });
    created = true;
  }
  if (tab.id === undefined) throw localError("video_metadata_unavailable");
  const tabId = tab.id;
  try {
    const deadline = Date.now() + 20_000;
    do {
      const current = await chromeApi.tabs.get(tabId);
      if (current.url && normalizeYouTubeVideoId(current.url) !== videoId) throw localError("video_context_changed");
      if (current.status === "complete") {
        const results = await chromeApi.scripting.executeScript({ target: { tabId }, world: "MAIN", func: readYouTubePageMetadata, args: [videoId] });
        // Re-check after asynchronous page execution to reject SPA navigation.
        const after = await chromeApi.tabs.get(tabId);
        if (normalizeYouTubeVideoId(after.url ?? "") !== videoId) throw localError("video_context_changed");
        if (results[0]?.result) return validateYouTubeMetadata(results[0].result, videoId);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    } while (Date.now() < deadline);
    throw localError("video_metadata_unavailable");
  } finally {
    // Only close the temporary tab we opened, and only if it still shows this video.
    if (created) {
      const current = await chromeApi.tabs.get(tabId).catch(() => null);
      if (current && !current.active && normalizeYouTubeVideoId(current.url ?? "") === videoId) {
        await chromeApi.tabs.remove(tabId).catch(() => undefined);
      }
    }
  }
}

export async function fetchCaptionTranscript(
  track: YouTubeCaptionTrack,
  videoId: string,
  options: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<TranscriptSegment[]> {
  const url = captionUrl(track.baseUrl, videoId);
  if (!url) throw localError("captions_unavailable");
  url.searchParams.set("fmt", "json3");
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 30_000);
  try {
    const response = await (options.fetcher ?? fetch)(url.href, { credentials: "include", redirect: "error", signal: controller.signal });
    if (!response.ok || Number(response.headers.get("Content-Length") ?? 0) > MAX_CAPTION_BYTES || !response.body) throw localError("captions_unavailable");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > MAX_CAPTION_BYTES) throw localError("captions_unavailable");
        text += decoder.decode(item.value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => undefined); }
    const segments = parseYouTubeCaptions(text, videoId);
    if (!segments.length) throw localError("captions_unavailable");
    return segments;
  } catch (error) {
    if (options.signal?.aborted) throw localError("analysis_cancelled");
    if (error instanceof Error && "code" in error) throw error;
    throw localError("captions_unavailable");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
