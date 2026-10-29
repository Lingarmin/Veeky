import { localError, MAX_VIDEO_DURATION_MS } from "./youtube-browser";

const SAMPLE_RATE = 16_000;
export const AUDIO_WINDOW_SECONDS = 30;
const MAX_MEDIA_BYTES = 4 * 1024 ** 3;

export function validateMediaUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw localError("unsupported_media_candidate"); }
  if (url.protocol !== "https:" || url.hostname !== "video.twimg.com" || url.username || url.password
    || url.port || url.hash || /[\\\s]/u.test(value) || value.length > 16_384) {
    throw localError("unsupported_media_candidate");
  }
  return url;
}

/** The same guard is applied to MP4 ranges, child HLS playlists and all segments. */
export function createMediaFetcher(signal: AbortSignal, fetcher: typeof fetch = fetch, maxBytes = MAX_MEDIA_BYTES): typeof fetch {
  let received = 0;
  return async (input, init) => {
    signal.throwIfAborted();
    const url = validateMediaUrl(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers();
    const range = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("range");
    if (range && /^bytes=\d+-\d*$/u.test(range)) headers.set("Range", range);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    init?.signal?.addEventListener("abort", abort, { once: true });
    let timeout = setTimeout(abort, 30_000);
    const release = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      init?.signal?.removeEventListener("abort", abort);
    };
    try {
      const response = await fetcher(url.href, { headers: Object.fromEntries(headers.entries()), credentials: "omit", redirect: "error", signal: controller.signal });
      if (!response.ok || !response.body) throw localError(response.status === 403 ? "media_url_expired" : "media_fetch_failed");
      const reader = response.body.getReader();
      const stream = new ReadableStream<Uint8Array>({
        async pull(destination) {
          try {
            clearTimeout(timeout);
            timeout = setTimeout(abort, 30_000);
            const item = await reader.read();
            if (item.done) { release(); destination.close(); return; }
            received += item.value.byteLength;
            if (received > maxBytes) throw localError("media_too_large");
            destination.enqueue(item.value);
          } catch (error) {
            release(); controller.abort(); await reader.cancel().catch(() => undefined); destination.error(error);
          }
        },
        async cancel() { release(); controller.abort(); await reader.cancel().catch(() => undefined); },
      });
      return new Response(stream, { status: response.status, headers: response.headers });
    } catch (error) { release(); throw error; }
  };
}

/** Mediabunny reports attempt=1 for every body-stream failure, so keep our own shared budget. */
export function createMediaRetryPolicy(signal: AbortSignal): (attempt: number, error: unknown) => number | null {
  let retries = 0;
  return (attempt, error) => {
    // Local media errors are terminal (including the aggregate byte cap and expired URLs).
    if (signal.aborted || error && typeof error === "object" && "code" in error && typeof error.code === "string"
      || attempt > 2 || retries >= 2) return null;
    return 0.5 * 2 ** retries++;
  };
}

/** Resample a decoder buffer into one 30-second mono window; never allocate whole-video PCM. */
export function mixAudioWindow(output: Float32Array, windowStart: number, part: { buffer: AudioBuffer; timestamp: number; duration: number }): void {
  const { buffer, timestamp } = part;
  if (buffer.numberOfChannels < 1 || buffer.numberOfChannels > 32 || buffer.sampleRate <= 0) throw localError("audio_decode_failed");
  const first = Math.max(0, Math.ceil((timestamp - windowStart) * SAMPLE_RATE));
  const end = Math.min(output.length, Math.ceil((timestamp + buffer.length / buffer.sampleRate - windowStart) * SAMPLE_RATE));
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
  for (let index = first; index < end; index += 1) {
    const position = (windowStart + index / SAMPLE_RATE - timestamp) * buffer.sampleRate;
    const left = Math.max(0, Math.floor(position));
    const right = Math.min(buffer.length - 1, left + 1);
    const fraction = position - left;
    let sample = 0;
    for (const channel of channels) sample += channel[left] * (1 - fraction) + channel[right] * fraction;
    output[index] = sample / channels.length;
  }
}

export interface AudioWindow { sequence: number; startMs: number; durationMs: number; samples: Float32Array }

export async function* decodeAudioWindows(url: string, durationMs: number, signal: AbortSignal, startSequence = 0): AsyncGenerator<AudioWindow> {
  validateMediaUrl(url);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw localError("video_metadata_unavailable");
  if (durationMs > MAX_VIDEO_DURATION_MS) throw localError("video_too_long");
  const { Input, UrlSource, ALL_FORMATS, AudioBufferSink } = await import("mediabunny");
  const input = new Input({
    source: new UrlSource(url, { fetchFn: createMediaFetcher(signal), maxCacheSize: 16 * 1024 ** 2,
      parallelism: 1, getRetryDelay: createMediaRetryPolicy(signal) }),
    formats: ALL_FORMATS, formatOptions: { hls: { offsetTimestampsByDateTime: false } },
  });
  const abort = () => input.dispose();
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw localError("audio_track_missing");
    if (!await track.canDecode()) throw localError("audio_codec_unsupported");
    const actualDuration = await input.getDurationFromMetadata([track], { skipLiveWait: true });
    if (actualDuration !== null && actualDuration * 1000 > MAX_VIDEO_DURATION_MS) throw localError("video_too_long");
    if (actualDuration !== null && Math.abs(actualDuration * 1000 - durationMs) > 5_000) throw localError("video_context_changed");
    const sink = new AudioBufferSink(track);
    for (let sequence = startSequence; sequence * AUDIO_WINDOW_SECONDS * 1000 < durationMs; sequence += 1) {
      signal.throwIfAborted();
      const start = sequence * AUDIO_WINDOW_SECONDS;
      const end = Math.min(start + AUDIO_WINDOW_SECONDS, durationMs / 1000);
      const samples = new Float32Array(Math.ceil((end - start) * SAMPLE_RATE));
      for await (const part of sink.buffers(start, end)) { signal.throwIfAborted(); mixAudioWindow(samples, start, part); }
      yield { sequence, startMs: start * 1000, durationMs: (end - start) * 1000, samples };
    }
  } finally { signal.removeEventListener("abort", abort); input.dispose(); }
}
