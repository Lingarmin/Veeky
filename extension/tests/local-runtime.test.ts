import { describe, expect, it, vi } from "vitest";
import { LOCAL_OPERATIONS, localCreateInput, safeRuntimeCode } from "../src/local/runtime";
import { installLocalRuntime, trustedExtensionSender, EXPERIMENTAL_ASR_KEY } from "../src/local/background-runtime";

describe("standalone runtime boundary", () => {
  it("never serializes credentials or expiring media into task commands", () => {
    const input = localCreateInput({ contentRef: { platform: "x", sourceContentId: "123", mediaIndex: 1 }, llmConfig: { provider: "deepseek", apiUrl: "https://api.deepseek.com/v1", apiKey: "fixture-secret", model: "deepseek-chat" }, mediaUrl: "https://video.twimg.com/movie?token=fixture", mediaSessionId: "old-session", force: true });
    expect(input).toMatchObject({ provider: "deepseek", model: "deepseek-chat", force: true });
    expect(JSON.stringify(input)).not.toMatch(/fixture|apiKey|apiUrl|mediaUrl|mediaSessionId/);
  });
  it("requires an exact extension page, not a content script or external page", () => {
    const api = { runtime: { id: "id", getURL: (path: string) => `chrome-extension://id/${path}` } } as Pick<typeof chrome, "runtime">;
    expect(trustedExtensionSender(api, { id: "id", url: "chrome-extension://id/sidepanel.html" }, "sidepanel.html")).toBe(true);
    expect(trustedExtensionSender(api, { id: "id", url: "https://www.youtube.com/watch?v=x", tab: { id: 1 } as chrome.tabs.Tab }, "sidepanel.html")).toBe(false);
    expect(trustedExtensionSender(api, { id: "other", url: "chrome-extension://id/sidepanel.html" }, "sidepanel.html")).toBe(false);
    expect(trustedExtensionSender(api, { id: "id", url: "chrome-extension://id/offscreen.html" }, "sidepanel.html")).toBe(false);
  });
  it("does not serialize provider error bodies or keys into errors", () => {
    expect(safeRuntimeCode(new Error("Authorization: fixture-secret"))).toBe("analysis_failed");
    expect(safeRuntimeCode({ code: "llm_authentication_failed", body: "fixture-secret" })).toBe("llm_authentication_failed");
    expect(safeRuntimeCode({ code: "llm_fixture-secret" })).toBe("analysis_failed");
  });
  it("exposes explicit storage inspection and completed-record cleanup operations", () => {
    expect(LOCAL_OPERATIONS).toContain("getStorageMetadata");
    expect(LOCAL_OPERATIONS).toContain("deleteCompletedAnalysis");
    expect(LOCAL_OPERATIONS).toContain("discardRecoverableTask");
    expect(safeRuntimeCode({ code: "storage_quota_exceeded" })).toBe("storage_quota_exceeded");
  });
  it("blocks X media and inspection before explicit experimental ASR consent", async () => {
    let listener: Parameters<typeof chrome.runtime.onMessage.addListener>[0];
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const resolveMedia = vi.fn();
    const get = vi.fn(async () => ({}));
    const api = {
      runtime: { id: "id", getURL: (path: string) => `chrome-extension://id/${path}`, sendMessage,
        onMessage: { addListener: (value: typeof listener) => { listener = value; } } },
      offscreen: { hasDocument: async () => true }, storage: { local: { get } }, tabs: {}, scripting: {},
    } as unknown as Parameters<typeof installLocalRuntime>[0];
    installLocalRuntime(api, resolveMedia);
    const dispatch = (type: string, operation: string, page: string, input?: unknown) => new Promise((resolve) => {
      listener({ type, operation, input }, { id: "id", url: `chrome-extension://id/${page}` }, resolve);
    });
    await expect(dispatch("VEEKY_LOCAL_COMMAND", "inspect", "sidepanel.html", { url: "https://x.com/a/status/123/video/1" }))
      .resolves.toEqual({ ok: false, code: "local_asr_experimental_disabled" });
    await expect(dispatch("VEEKY_LOCAL_BROKER", "media", "offscreen.html"))
      .resolves.toEqual({ ok: false, code: "local_asr_experimental_disabled" });
    expect(get).toHaveBeenCalledWith(EXPERIMENTAL_ASR_KEY);
    expect(resolveMedia).not.toHaveBeenCalled();
    await expect(dispatch("VEEKY_LOCAL_COMMAND", "getHistory", "offscreen.html"))
      .resolves.toEqual({ ok: false, code: "analysis_unauthorized" });
  });
});
