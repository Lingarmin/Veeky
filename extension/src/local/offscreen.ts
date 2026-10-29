import { LocalAnalysisEngine } from "./analysis";
import { LocalAnalysisRepository } from "./repository";
import { LOCAL_BROKER, LOCAL_EXECUTE, safeRuntimeCode } from "./runtime";
import { fetchCaptionTranscript, localError } from "./youtube-browser";
import { transcribeXVideo } from "./x-asr";

async function broker<T>(input: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw localError("analysis_cancelled");
  const id = crypto.randomUUID();
  const cancel = () => { void chrome.runtime.sendMessage({ type: LOCAL_BROKER, operation: "cancel", id }).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  // Only while a broker operation is in flight. Fetches may outlive the worker's idle timeout.
  const heartbeat = setInterval(() => { void chrome.runtime.sendMessage({ type: LOCAL_BROKER, operation: "heartbeat" }).catch(() => {}); }, 20_000);
  try {
    const response = await chrome.runtime.sendMessage({ type: LOCAL_BROKER, ...input, id });
    if (signal?.aborted) throw localError("analysis_cancelled");
    if (!response?.ok) throw localError(response?.code ?? "analysis_interrupted");
    return response.value as T;
  } finally { clearInterval(heartbeat); signal?.removeEventListener("abort", cancel); }
}

const repository = new LocalAnalysisRepository();
const engine = new LocalAnalysisEngine({
  repository,
  readYouTubeMetadata: (url, signal) => broker({ operation: "metadata", url }, signal),
  fetchCaptionTranscript,
  completeChat: (messages, provider, model, signal) => broker({ operation: "complete", messages, provider, model }, signal),
  transcribe: async (request, options) => {
    const media = await broker<{ url: string }>({ operation: "media", contentRef: request.contentRef }, options.signal);
    return transcribeXVideo(request, options, media.url);
  },
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== LOCAL_EXECUTE) return false;
  if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL("background.js")) {
    respond({ ok: false, code: "analysis_unauthorized" }); return false;
  }
  void (async () => {
    switch (message.operation) {
      case "ping": return null;
      case "inspect": {
        const result = await engine.inspect(message.input);
        return result.contentRef.platform === "x" && result.durationMs > 0 ? { ...result, sourceStatus: "ready" } : result;
      }
      case "createAnalysis": return engine.createAnalysis(message.input);
      case "getHistory": return engine.getHistory(message.input);
      case "getStatus": return engine.getStatus(message.input);
      case "getResult": return engine.getResult(message.input);
      case "cancel": return engine.cancel(message.input);
      case "resume": return engine.resume(message.input);
      case "getRecoverableTasks": return engine.getRecoverableTasks();
      case "getStorageMetadata": return repository.getStorageMetadata();
      case "deleteCompletedAnalysis": return repository.deleteCompletedAnalysis(message.input);
      case "discardRecoverableTask": return repository.discardRecoverableTask(message.input);
      default: throw localError("analysis_invalid_request");
    }
  })().then((value) => respond({ ok: true, value }), (error) => respond({ ok: false, code: safeRuntimeCode(error) }));
  return true;
});
