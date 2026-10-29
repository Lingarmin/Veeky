import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmClientError, completeChat, testLlmConnection } from "../src/local/llm-client";
import type { ChatMessage } from "../src/local/llm-client";
import { defaultLlmConfig } from "../src/sidepanel/llm";

const messages: ChatMessage[] = [{ role: "user", content: "Say hello" }];
const key = "test-secret-token-123";

function completion(content: unknown = "Hello") {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("completeChat", () => {
  it.each([
    ["kimi", "https://api.moonshot.cn/v1/chat/completions"],
    ["deepseek", "https://api.deepseek.com/v1/chat/completions"],
    ["hunyuan", "https://tokenhub.tencentmaas.com/v1/chat/completions"],
    ["qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"],
    ["glm", "https://open.bigmodel.cn/api/paas/v4/chat/completions"],
  ] as const)("calls only %s official endpoint without ambient credentials", async (provider, endpoint) => {
    const fetchMock = vi.fn().mockResolvedValue(completion());
    vi.stubGlobal("fetch", fetchMock);
    const config = { ...defaultLlmConfig(provider), apiKey: key };

    await expect(completeChat(config, messages)).resolves.toBe("Hello");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(endpoint);
    expect(url).not.toContain(key);
    expect(init).toMatchObject({ credentials: "omit", redirect: "error", method: "POST" });
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${key}`);
  });

  it.each([
    "https://relay.example/v1",
    "https://user:pass@api.moonshot.cn/v1",
    "https://api.moonshot.cn/v1?key=leak",
    "http://api.moonshot.cn/v1",
  ])("rejects an unsafe configured destination before fetch: %s", async (apiUrl) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const config = { ...defaultLlmConfig("kimi"), apiUrl, apiKey: key };

    await expect(completeChat(config, messages)).rejects.toMatchObject({ code: "llm_invalid_config" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a transient provider error only within the configured attempt bound", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("upstream unavailable", { status: 503 }))
      .mockResolvedValueOnce(completion("Recovered"));
    vi.stubGlobal("fetch", fetchMock);
    const config = { ...defaultLlmConfig("kimi"), apiKey: key };

    await expect(completeChat(config, messages, { maxAttempts: 10, retryDelayMs: 0 })).resolves.toBe("Recovered");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([429, 503])("marks exhausted HTTP %i as retryable", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("temporary", { status })));
    const config = { ...defaultLlmConfig("kimi"), apiKey: key };

    const error = await completeChat(config, messages, { maxAttempts: 1 }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(LlmClientError);
    expect(error).toMatchObject({ retryable: true, status });
  });

  it("does not retry invalid credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = { ...defaultLlmConfig("kimi"), apiKey: key };

    const error = await completeChat(config, messages, { maxAttempts: 3, retryDelayMs: 0 }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "llm_authentication_failed", retryable: false, status: 401 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("redacts the API key from provider error messages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: `token ${key} was rejected` } }), { status: 400 })));
    const config = { ...defaultLlmConfig("kimi"), apiKey: key };

    const error = await completeChat(config, messages).then(() => undefined, (value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) return;
    expect(error.message).not.toContain(key);
    expect(error.message).toContain("[redacted]");
  });

  it("does not expose secrets echoed by a network exception", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError(`request failed for ${key}`)));
    const config = { ...defaultLlmConfig("kimi"), apiKey: key };

    const error = await completeChat(config, messages, { maxAttempts: 1 }).then(() => undefined, (value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) return;
    expect(error.message).not.toContain(key);
  });

  it("aborts a request that exceeds its bounded timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const config = { ...defaultLlmConfig("kimi"), apiKey: key };
    const pending = completeChat(config, messages, { timeoutMs: 1_000, maxAttempts: 1 });
    const assertion = expect(pending).rejects.toMatchObject({ code: "llm_timeout" });

    await vi.advanceTimersByTimeAsync(1_005);
    await assertion;
  });

  it("parses text parts from a compatible structured content response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion([{ type: "text", text: "one" }, { type: "text", text: " two" }])));
    const config = { ...defaultLlmConfig("kimi"), apiKey: key };

    await expect(completeChat(config, messages)).resolves.toBe("one two");
  });

  it.each([
    ["kimi", "kimi-k2.5", { thinking: { type: "disabled" } }],
    ["hunyuan", "hy3", { thinking: { type: "disabled" } }],
    ["glm", "glm-4.7-flash", { thinking: { type: "disabled" } }],
    ["qwen", "qwen-plus", { enable_thinking: false }],
    ["deepseek", "deepseek-chat", {}],
  ] as const)("uses only the selected %s provider's supported thinking field", async (provider, model, expected) => {
    const fetchMock = vi.fn().mockResolvedValue(completion());
    vi.stubGlobal("fetch", fetchMock);
    const config = { ...defaultLlmConfig(provider), apiKey: key, model };

    await completeChat(config, messages, { thinking: { type: "disabled" } });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject(expected);
  });

  it("probes provider connectivity with a small completion request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion("OK"));
    vi.stubGlobal("fetch", fetchMock);
    const config = { ...defaultLlmConfig("kimi"), apiKey: key };

    await expect(testLlmConnection(config)).resolves.toBeUndefined();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ max_tokens: 32 });
  });

  it("rejects malformed or empty completion payloads", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: " " } }] }), { status: 200 })));
    const config = { ...defaultLlmConfig("kimi"), apiKey: key };

    await expect(completeChat(config, messages)).rejects.toMatchObject({ code: "llm_invalid_response" });
  });
});
