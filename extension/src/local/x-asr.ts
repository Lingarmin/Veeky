import type { TranscriptSegment } from "../shared/types";
import type { TranscriptionOptions, TranscriptionRequest } from "./analysis";
import { decodeAudioWindows } from "./x-audio";
import { ensureWhisperModel } from "./x-model";
import { localError } from "./youtube-browser";

export function parseWhisperSegments(result: unknown, sequence: number, startMs: number, durationMs: number): TranscriptSegment[] {
  const chunks = (result as { chunks?: unknown } | null)?.chunks;
  if (!Array.isArray(chunks)) throw localError("local_asr_failed");
  const segments: TranscriptSegment[] = [];
  for (const chunk of chunks) {
    if (!chunk || typeof chunk.text !== "string" || !Array.isArray(chunk.timestamp)) throw localError("local_asr_failed");
    const [start, end] = chunk.timestamp;
    if (typeof start !== "number" || !Number.isFinite(start) || start < 0
      || end !== null && (typeof end !== "number" || !Number.isFinite(end) || end <= start)) throw localError("local_asr_failed");
    const text = chunk.text.trim();
    const offset = Math.round(start * 1000);
    const stop = Math.min(durationMs, end === null ? durationMs : Math.round(end * 1000));
    if (!text || offset >= durationMs || stop <= offset) continue;
    segments.push({ id: `x:${sequence}:${segments.length}`, startMs: startMs + offset, durationMs: stop - offset, original: text, translated: null });
  }
  return segments;
}

function workerRequest(worker: Worker, message: unknown, expectedType: string, signal: AbortSignal, transfer: Transferable[] = []): Promise<any> {
  return new Promise((resolve, reject) => {
    const clean = () => {
      clearTimeout(timeout); signal.removeEventListener("abort", abort);
      worker.removeEventListener("message", receive); worker.removeEventListener("error", failure);
    };
    const abort = () => { clean(); worker.terminate(); reject(localError("analysis_cancelled")); };
    const failure = () => { clean(); worker.terminate(); reject(localError("local_asr_failed")); };
    const receive = (event: MessageEvent) => {
      if (event.data?.type === "error") { failure(); return; }
      if (event.data?.type === expectedType) { clean(); resolve(event.data); }
    };
    const timeout = setTimeout(failure, 20 * 60_000);
    worker.addEventListener("message", receive); worker.addEventListener("error", failure);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    worker.postMessage(message, transfer);
  });
}

/** A separate worker makes CPU inference cancellable without freezing the side panel. */
export async function transcribeXVideo(request: TranscriptionRequest, options: TranscriptionOptions, mediaUrl: string): Promise<TranscriptSegment[]> {
  const { signal, onCheckpoint, onProgress } = options;
  await onProgress("downloading_model", 0, null);
  const manifest = await ensureWhisperModel(signal, ({ completed, total }) => {
    void onProgress("downloading_model", completed, total).catch(() => undefined);
  });
  signal.throwIfAborted();
  const worker = new Worker(new URL("./x-asr-worker.ts", import.meta.url), { type: "module" });
  const segments = [...options.checkpointSegments];
  // Only complete windows are checkpointed. Empty windows may be repeated safely after restart.
  const sequences = segments.map((segment) => /^x:(\d+):/u.exec(segment.id)).filter((match) => match !== null).map((match) => Number(match![1]));
  const startSequence = sequences.length ? Math.max(...sequences) + 1 : 0;
  try {
    await workerRequest(worker, { type: "initialize", manifest, runtimeUrl: chrome.runtime.getURL("wasm/") }, "ready", signal);
    for await (const window of decodeAudioWindows(mediaUrl, request.durationMs, signal, startSequence)) {
      await onProgress("transcribing", window.startMs, request.durationMs);
      const response = await workerRequest(worker, { type: "recognize", samples: window.samples,
        language: request.sourceLanguage }, "result", signal, [window.samples.buffer]);
      const chunk = parseWhisperSegments(response.result, window.sequence, window.startMs, window.durationMs);
      await onCheckpoint(window.sequence, chunk);
      segments.push(...chunk);
      await onProgress("transcribing", window.startMs + window.durationMs, request.durationMs);
    }
    return segments;
  } finally { worker.terminate(); }
}
