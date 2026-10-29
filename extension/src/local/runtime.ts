import type { AnalysisApi, AnalysisCreateInput } from "../sidepanel/api";
import { ApiError } from "../sidepanel/api";
import { completeChat } from "./llm-client";
import type { LlmConfig } from "../sidepanel/llm";
import type { LocalAnalysisStatus } from "./analysis";
import type { LocalAnalysisTask } from "./repository";
import type { LocalStorageMetadata } from "./storage";

export const LOCAL_COMMAND = "VEEKY_LOCAL_COMMAND";
export const LOCAL_EXECUTE = "VEEKY_LOCAL_EXECUTE";
export const LOCAL_BROKER = "VEEKY_LOCAL_BROKER";
export type LocalOperation = "inspect" | "createAnalysis" | "getHistory" | "getStatus" | "getResult" | "cancel" | "resume" | "getRecoverableTasks" | "getStorageMetadata" | "deleteCompletedAnalysis" | "discardRecoverableTask";
export const LOCAL_OPERATIONS: readonly LocalOperation[] = ["inspect", "createAnalysis", "getHistory", "getStatus", "getResult", "cancel", "resume", "getRecoverableTasks", "getStorageMetadata", "deleteCompletedAnalysis", "discardRecoverableTask"];

export interface LocalApi extends AnalysisApi {
  getStatus(jobId: string): Promise<LocalAnalysisStatus>;
  cancel(jobId: string): Promise<void>;
  resume(jobId: string): ReturnType<AnalysisApi["createAnalysis"]>;
  getRecoverableTasks(): Promise<LocalAnalysisTask[]>;
  getStorageMetadata(): Promise<LocalStorageMetadata>;
  deleteCompletedAnalysis(jobId: string): Promise<void>;
  discardRecoverableTask(jobId: string): Promise<void>;
}

export function safeRuntimeCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^(?:analysis|llm|video|captions|transcript|translation|local_asr|audio|model|media|storage|unsupported_media)_[a-z_]{1,60}$/.test(code) ? code : "analysis_failed";
}

export async function localRequest<T>(operation: LocalOperation, input?: unknown): Promise<T> {
  let response;
  try { response = await chrome.runtime.sendMessage({ type: LOCAL_COMMAND, operation, input }); }
  catch { throw new ApiError("local_engine_unavailable", "本地任务引擎未启动，请重新打开插件。", 0); }
  if (!response?.ok) throw new ApiError(response?.code ?? "local_engine_unavailable", "本地任务未完成", 0);
  return response.value as T;
}

/** Deliberately serialize only non-secret task configuration. Keys never cross runtime messages. */
export function localCreateInput(input: AnalysisCreateInput) {
  const ref = input.contentRef ?? (input.videoId ? { platform: "youtube", sourceContentId: input.videoId, mediaIndex: 1 } : undefined);
  if (!ref) throw new ApiError("invalid_video_url", "请重新检查视频链接", 0);
  return { contentRef: ref, sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage,
    title: input.title, provider: input.llmConfig.provider, model: input.llmConfig.model, force: input.force };
}

export function createLocalApi(): LocalApi {
  return {
    async testLlm(config) {
      await completeChat(config as LlmConfig, [{ role: "user", content: 'Reply with the JSON object {"ok":true} only.' }], { maxTokens: 256, maxAttempts: 1, thinking: { type: "disabled" } });
      return { ok: true, message: "已连接官方 LLM 服务" };
    },
    inspect: (input) => localRequest("inspect", typeof input === "string" ? { url: input } : { url: input.url, preferredLanguages: input.preferredLanguages, activeMediaIndex: input.activeMediaIndex }),
    createAnalysis: (input) => localRequest("createAnalysis", localCreateInput(input)),
    getHistory: (input = {}) => localRequest("getHistory", input),
    getStatus: (jobId) => localRequest("getStatus", jobId),
    getResult: (jobId) => localRequest("getResult", jobId),
    cancel: (jobId) => localRequest("cancel", jobId),
    resume: (jobId) => localRequest("resume", jobId),
    getRecoverableTasks: () => localRequest("getRecoverableTasks"),
    getStorageMetadata: () => localRequest("getStorageMetadata"),
    deleteCompletedAnalysis: (jobId) => localRequest("deleteCompletedAnalysis", jobId),
    discardRecoverableTask: (jobId) => localRequest("discardRecoverableTask", jobId),
  };
}
