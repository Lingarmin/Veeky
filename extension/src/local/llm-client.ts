import { LLM_PROVIDER_OPTIONS } from "../sidepanel/llm";
import type { LlmConfig, LlmProvider } from "../sidepanel/llm";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface CompleteChatOptions {
  /** Per-attempt timeout. The value is clamped to the supported range. */
  timeoutMs?: number;
  /** Total attempts, including the first request. Transient failures are capped at three. */
  maxAttempts?: number;
  /** Base retry delay; Retry-After is honored up to five seconds. */
  retryDelayMs?: number;
  /** Abort a request when the user cancels its local analysis task. */
  signal?: AbortSignal;
  maxTokens?: number;
  responseFormat?: { type: "json_object" };
  thinking?: { type: "enabled" | "disabled" };
}

export type LlmClientErrorCode =
  | "llm_invalid_config"
  | "llm_invalid_request"
  | "llm_cancelled"
  | "llm_timeout"
  | "llm_unavailable"
  | "llm_authentication_failed"
  | "llm_model_unavailable"
  | "llm_quota_exhausted"
  | "llm_rate_limited"
  | "llm_request_rejected"
  | "llm_invalid_response";

export class LlmClientError extends Error {
  readonly code: LlmClientErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(code: LlmClientErrorCode, message: string, options: { retryable?: boolean; status?: number } = {}) {
    super(message);
    this.name = "LlmClientError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_TIMEOUT_MS = 180_000;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 5_000;

/**
 * Calls the selected official provider from a trusted extension page.
 * The configured URL is validated but never used as a destination; the
 * endpoint is always reconstructed from the immutable provider registry.
 */
export async function completeChat(
  config: LlmConfig,
  messages: readonly ChatMessage[],
  options: CompleteChatOptions = {},
): Promise<string> {
  const provider = providerConfig(config);
  const validatedMessages = validateMessages(messages);
  const model = typeof config.model === "string" ? config.model.trim() : "";
  if (!model || (options.maxTokens !== undefined && (!Number.isInteger(options.maxTokens) || options.maxTokens <= 0))) {
    throw new LlmClientError("llm_invalid_config", "请检查 LLM 模型配置后重试。");
  }
  const apiKey = config.apiKey.trim();
  if (!apiKey || /[\r\n\u0000]/u.test(apiKey)) {
    throw new LlmClientError("llm_invalid_config", "请填写有效的官方 LLM API Key。");
  }

  const timeoutMs = clampInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS);
  const maxAttempts = clampInteger(options.maxAttempts, MAX_ATTEMPTS, 1, MAX_ATTEMPTS);
  const retryDelayMs = clampInteger(options.retryDelayMs, 400, 0, MAX_RETRY_DELAY_MS);
  const payload: Record<string, unknown> = { model, messages: validatedMessages };
  if (options.maxTokens !== undefined) payload.max_tokens = options.maxTokens;
  if (options.responseFormat) payload.response_format = options.responseFormat;
  addThinkingOption(payload, provider.provider, model, options.thinking);

  let lastError: LlmClientError | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await requestCompletion(provider.endpoint, apiKey, payload, timeoutMs, options.signal);
      if (response.ok) return parseCompletion(response.bodyText, provider.label);
      const error = responseError(response, provider.label, apiKey);
      if (!error.retryable || attempt + 1 >= maxAttempts) throw error;
      lastError = error;
      await delay(retryDelayFor(response, retryDelayMs * (2 ** attempt)), options.signal);
    } catch (cause) {
      if (cause instanceof LlmClientError) {
        if (!cause.retryable || attempt + 1 >= maxAttempts) throw cause;
        lastError = cause;
        await delay(retryDelayMs * (2 ** attempt), options.signal);
        continue;
      }
      if (options.signal?.aborted) {
        throw new LlmClientError("llm_cancelled", "LLM 请求已取消。");
      }
      const error = new LlmClientError("llm_unavailable", `${provider.label} 暂时无法连接，请稍后重试。`, { retryable: true });
      if (attempt + 1 >= maxAttempts) throw error;
      lastError = error;
      await delay(retryDelayMs * (2 ** attempt), options.signal);
    }
  }
  throw lastError ?? new LlmClientError("llm_unavailable", `${provider.label} 暂时无法连接，请稍后重试。`, { retryable: true });
}

/** A lightweight provider probe: a successful non-empty completion proves connectivity and key validity. */
export async function testLlmConnection(
  config: LlmConfig,
  options: Omit<CompleteChatOptions, "maxTokens" | "responseFormat" | "thinking"> = {},
): Promise<void> {
  await completeChat(config, [{ role: "user", content: "Reply with the single word: OK" }], {
    ...options,
    maxTokens: 32,
  });
}

function providerConfig(config: LlmConfig): { provider: LlmProvider; label: string; endpoint: string } {
  if (!config || typeof config !== "object") {
    throw new LlmClientError("llm_invalid_config", "LLM 服务商配置无效。");
  }
  const option = LLM_PROVIDER_OPTIONS.find((item) => item.provider === config.provider);
  if (!option || !isOfficialConfiguredUrl(option.defaultUrl, config.apiUrl)) {
    throw new LlmClientError("llm_invalid_config", "仅支持所选服务商的官方 HTTPS API 地址。");
  }
  return { provider: option.provider, label: option.label, endpoint: `${option.defaultUrl}/chat/completions` };
}

function isOfficialConfiguredUrl(defaultUrl: string, suppliedUrl: unknown): boolean {
  if (typeof suppliedUrl !== "string" || /[\s\u0000-\u001f\u007f\\?#]/u.test(suppliedUrl)) return false;
  const match = /^https:\/\/([^/]+)(\/.*)?$/i.exec(suppliedUrl);
  if (!match) return false;
  const expected = new URL(defaultUrl);
  if (![expected.hostname, `${expected.hostname}:443`].includes(match[1].toLowerCase())) return false;
  const path = match[2] ?? "";
  return ["", "/", expected.pathname, `${expected.pathname}/`, `${expected.pathname}/chat/completions`, `${expected.pathname}/chat/completions/`].includes(path);
}

function validateMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 100) {
    throw new LlmClientError("llm_invalid_request", "LLM 请求消息为空或超出数量限制。");
  }
  const result: ChatMessage[] = [];
  for (const message of messages) {
    if (!message || !["system", "user", "assistant"].includes(message.role) || typeof message.content !== "string") {
      throw new LlmClientError("llm_invalid_request", "LLM 请求消息格式无效。");
    }
    result.push({ role: message.role, content: message.content });
  }
  return result;
}

function addThinkingOption(payload: Record<string, unknown>, provider: LlmProvider, model: string, thinking?: CompleteChatOptions["thinking"]): void {
  if (!thinking) return;
  const modelLower = model.toLowerCase();
  if (provider === "kimi" || (provider === "hunyuan" && modelLower === "hy3")
    || (provider === "glm" && ["glm-4.5", "glm-4.6", "glm-4.7"].some((prefix) => modelLower.startsWith(prefix)))) {
    payload.thinking = thinking;
  } else if (provider === "qwen") {
    payload.enable_thinking = thinking.type !== "disabled";
  }
}

interface CompletionHttpResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  bodyText: string;
}

async function requestCompletion(endpoint: string, apiKey: string, payload: Record<string, unknown>, timeoutMs: number, externalSignal?: AbortSignal): Promise<CompletionHttpResponse> {
  if (externalSignal?.aborted) throw new LlmClientError("llm_cancelled", "LLM 请求已取消。");
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    return { ok: response.ok, status: response.status, headers: response.headers, bodyText: await response.text() };
  } catch {
    if (externalSignal?.aborted) throw new LlmClientError("llm_cancelled", "LLM 请求已取消。");
    if (timedOut) throw new LlmClientError("llm_timeout", "LLM 服务响应超时，请稍后重试。", { retryable: true });
    throw new LlmClientError("llm_unavailable", "LLM 服务暂时无法连接，请稍后重试。", { retryable: true });
  } finally {
    globalThis.clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
}

function responseError(response: CompletionHttpResponse, provider: string, apiKey: string): LlmClientError {
  const detail = redact(readErrorDetail(response.bodyText), apiKey).slice(0, 240);
  const suffix = detail ? `：${detail}` : "。";
  const status = response.status;
  if (status === 401 || status === 403) {
    return new LlmClientError("llm_authentication_failed", `${provider} API Key 无效或无权调用此模型。`, { status });
  }
  if (status === 404 || ((status === 400 || status === 422) && /model.{0,30}(not found|unavailable|does not exist)|模型.{0,10}(不存在|不可用)/iu.test(detail))) {
    return new LlmClientError("llm_model_unavailable", `${provider} 模型不存在或不可用${suffix}`, { status });
  }
  if (status === 429 && /insufficient balance|please recharge|余额不足|账户余额/iu.test(detail)) {
    return new LlmClientError("llm_quota_exhausted", `${provider} 账户额度不足，请检查账户余额或更换可用的官方 Key。`, { status });
  }
  if (status === 429) {
    return new LlmClientError("llm_rate_limited", `${provider} 请求过于频繁，请稍后重试${suffix}`, { retryable: true, status });
  }
  if (status >= 500) {
    return new LlmClientError("llm_unavailable", `${provider} 服务暂时不可用，请稍后重试${suffix}`, { retryable: true, status });
  }
  return new LlmClientError("llm_request_rejected", `${provider} 拒绝了请求，请检查模型和请求参数${suffix}`, { status });
}

function readErrorDetail(text: string): string {
  try {
    if (!text) return "";
    try {
      const body: unknown = JSON.parse(text);
      if (isRecord(body)) {
        const error = body.error;
        const detail = isRecord(error) ? error.message ?? error.code : body.message ?? body.detail;
        if (typeof detail === "string") return detail.replace(/[\r\n]+/gu, " ").trim();
      }
    } catch {
      // Use short plain-text provider errors when the body is not JSON.
    }
    return text.replace(/[\r\n]+/gu, " ").trim();
  } catch {
    return "";
  }
}

function parseCompletion(bodyText: string, provider: string): string {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new LlmClientError("llm_invalid_response", `${provider} 返回格式无效，请重试。`);
  }
  if (!isRecord(body) || !Array.isArray(body.choices) || !body.choices.length || !isRecord(body.choices[0]) || !isRecord(body.choices[0].message)) {
    throw new LlmClientError("llm_invalid_response", `${provider} 返回格式无效，请重试。`);
  }
  const message = body.choices[0].message;
  let content = "";
  if (typeof message.content === "string") content = message.content;
  else if (Array.isArray(message.content)) {
    content = message.content.map((part) => typeof part === "string" ? part : isRecord(part) && typeof part.text === "string" ? part.text : "").join("");
  }
  if (!content.trim()) throw new LlmClientError("llm_invalid_response", `${provider} 返回内容为空，请重试。`);
  return content.trim();
}

function retryDelayFor(response: Pick<CompletionHttpResponse, "headers">, fallbackMs: number): number {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter && /^\d+(?:\.\d+)?$/u.test(retryAfter.trim())) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, Math.round(Number(retryAfter) * 1_000)));
  }
  return Math.min(MAX_RETRY_DELAY_MS, fallbackMs);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new LlmClientError("llm_cancelled", "LLM 请求已取消。"));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      globalThis.clearTimeout(timer);
      reject(new LlmClientError("llm_cancelled", "LLM 请求已取消。"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function redact(value: string, apiKey: string): string {
  return apiKey ? value.split(apiKey).join("[redacted]") : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
