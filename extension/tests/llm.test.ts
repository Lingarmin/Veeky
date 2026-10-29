import { afterEach, describe, expect, it, vi } from "vitest";
import { browserLlmConfigStore, defaultLlmConfig, isLlmConfigured, LLM_PROVIDER_OPTIONS } from "../src/sidepanel/llm";
import type { LlmConfig } from "../src/sidepanel/llm";

const providers = [
  ["kimi", "Kimi", "https://api.moonshot.cn/v1", "kimi-k2.5"],
  ["deepseek", "DeepSeek", "https://api.deepseek.com/v1", "deepseek-chat"],
  ["hunyuan", "腾讯混元", "https://tokenhub.tencentmaas.com/v1", "hy3"],
  ["qwen", "通义千问", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"],
  ["glm", "智谱 GLM", "https://open.bigmodel.cn/api/paas/v4", "glm-4.7-flash"],
] as const;

function storage(initial: Record<string, unknown> = {}) {
  const data = structuredClone(initial);
  const local = {
    setAccessLevel: vi.fn(async () => undefined),
    get: vi.fn(async () => structuredClone(data)),
    set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(data, structuredClone(values)); }),
    remove: vi.fn(async (key: string) => { delete data[key]; }),
  };
  const sessionData: Record<string, unknown> = {};
  const session = {
    setAccessLevel: vi.fn(async () => undefined),
    get: vi.fn(async () => structuredClone(sessionData)),
    set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(sessionData, structuredClone(values)); }),
  };
  vi.stubGlobal("chrome", { storage: { local, session } });
  return { data, ...local };
}
afterEach(() => vi.unstubAllGlobals());

describe("official LLM configuration", () => {
  it("offers exactly five official providers and defaults", () => {
    expect(LLM_PROVIDER_OPTIONS).toEqual(providers.map(([provider, label, defaultUrl, defaultModel]) => ({ provider, label, defaultUrl, defaultModel })));
    for (const [provider, , apiUrl, model] of providers) expect(defaultLlmConfig(provider)).toEqual({ provider, apiUrl, model, apiKey: "" });
  });
  it.each(providers)("accepts and canonicalizes official %s URL variants", async (provider, _label, base) => {
    for (const apiUrl of [new URL(base).origin, `${new URL(base).origin}/`, base, `${base}/`, `${base}/chat/completions`, `${base}/chat/completions/`, base.replace(new URL(base).hostname, `${new URL(base).hostname}:443`)]) {
      const config = { ...defaultLlmConfig(provider), apiUrl, apiKey: "official-test-key", model: "editable-model", rememberOnDevice: true };
      expect(isLlmConfigured(config)).toBe(true);
      const store = storage({ [`llmRememberedConfigV2:${provider}`]: config });
      expect(await browserLlmConfigStore.load(provider)).toEqual({ ...config, apiUrl: base });
      expect(store.set).not.toHaveBeenCalled();
    }
  });
  it.each([
    "", "https://relay.example/v1", "http://api.moonshot.cn/v1", "https://api.deepseek.com/v1",
    "https://api.moonshot.cn:444/v1", "https://api.moonshot.cn:0443/v1", "https://127.0.0.1/v1",
    "https://api.moonshot.cn.evil.example/v1", "https://api.moonshot.cn@evil.example/v1",
    "https://user@api.moonshot.cn/v1", "https://:pass@api.moonshot.cn/v1",
    "https://api.moonshot.cn./v1", "https://%61pi.moonshot.cn/v1",
    "https://api.moonshot.cn/v1?", "https://api.moonshot.cn/v1#",
    "https://api.moonshot.cn/v1?x=y", "https://api.moonshot.cn/v1#x",
    " https://api.moonshot.cn/v1", "https://api.moonshot.cn/v1 ",
    "https://api.moonshot.cn/\tv1", "https://api.moonshot.cn/v1\n", "https://api.moonshot.cn/v1\u007f",
    "https://api.moonshot.cn\\v1", "https:\\api.moonshot.cn/v1",
    "https://api.moonshot.cn/other/../v1", "https://api.moonshot.cn/%76%31", "https://api.moonshot.cn//v1",
    "https://api.moonshot.cn/chat/completions", "https://api.moonshot.cn/v1/chat/completions/extra",
  ])("rejects unsafe or ambiguous URL %j", (apiUrl) => {
    expect(isLlmConfigured({ ...defaultLlmConfig("kimi"), apiUrl, apiKey: "dummy" })).toBe(false);
  });
  it("requires a known provider, nonempty model and key with valid types", () => {
    for (const patch of [{ provider: "custom" }, { apiKey: " " }, { model: "" }, { model: 7 }, { apiKey: {} }, { apiUrl: null }]) {
      expect(isLlmConfigured({ ...defaultLlmConfig("kimi"), apiKey: "dummy", ...patch } as LlmConfig)).toBe(false);
    }
  });
  it("loads independent provider keys without rewriting any stored data", async () => {
    const configs = Object.fromEntries(providers.map(([provider]) => [`llmRememberedConfigV2:${provider}`, { ...defaultLlmConfig(provider), apiKey: `${provider}-key`, rememberOnDevice: true }]));
    const store = storage({ ...configs, identity: "untouched", history: ["untouched"] });
    for (const [provider] of providers) expect((await browserLlmConfigStore.load(provider)).apiKey).toBe(`${provider}-key`);
    expect(store.data).toEqual({ ...configs, identity: "untouched", history: ["untouched"] });
    expect(store.set).not.toHaveBeenCalled();
  });
  it("isolates a valid legacy official Kimi key without a migration write", async () => {
    const legacy = { apiUrl: "https://api.moonshot.cn/v1/chat/completions/", apiKey: "legacy-official", model: "old-model" };
    const store = storage({ kimiLlmConfig: legacy });
    expect(await browserLlmConfigStore.load()).toMatchObject({ provider: "kimi", apiKey: "", model: "old-model", apiUrl: "https://api.moonshot.cn/v1", migrationNotice: expect.stringContaining("重新填写") });
    expect(store.data).toEqual({ kimiLlmConfig: legacy });
    expect(store.set).not.toHaveBeenCalled();
  });
  it.each([
    { raw: "malformed" },
    { raw: [{ ...defaultLlmConfig("qwen"), apiKey: "ambiguous-key" }] },
    { raw: null },
    { raw: 42 },
    { raw: false },
  ])("quarantines malformed configuration roots without changing raw storage %#", async ({ raw }) => {
    const original = { llmConfigs: raw, selectedLlmProvider: "qwen", history: [1], identity: "original", unrelated: "untouched" };
    const store = storage(original);
    const loaded = await browserLlmConfigStore.load();
    expect(loaded).toMatchObject(defaultLlmConfig("qwen"));
    expect(loaded.migrationNotice).toMatch(/格式.*隔离.*官方 API Key/);
    expect(loaded.migrationNotice).toMatch(/原始配置保留不变/);
    expect(loaded.migrationNotice).toMatch(/不影响历史记录.*身份数据.*其他设置/);
    expect(isLlmConfigured(loaded)).toBe(false);
    expect(store.data).toEqual(original);
    expect(store.set).not.toHaveBeenCalled();
  });
  it("does not reuse a legacy key when the current configuration root is malformed", async () => {
    const original = { llmConfigs: "malformed", kimiLlmConfig: { ...defaultLlmConfig("kimi"), apiKey: "legacy-official" } };
    const store = storage(original);
    const loaded = await browserLlmConfigStore.load("kimi");
    expect(loaded).toMatchObject(defaultLlmConfig("kimi"));
    expect(loaded.migrationNotice).toMatch(/格式.*隔离/);
    expect(store.data).toEqual(original);
    expect(store.set).not.toHaveBeenCalled();
  });
  it("retains TokenHub migration guidance when the Hunyuan configuration root is malformed", async () => {
    const store = storage({ llmConfigs: [], selectedLlmProvider: "hunyuan" });
    const loaded = await browserLlmConfigStore.load();
    expect(loaded).toMatchObject(defaultLlmConfig("hunyuan"));
    expect(loaded.migrationNotice).toMatch(/格式.*隔离/);
    expect(loaded.migrationNotice).toMatch(/2026-09-30.*TokenHub/);
    expect(store.set).not.toHaveBeenCalled();
  });
  it("uses new session storage on explicit save without modifying a malformed legacy root", async () => {
    const original = {
      llmConfigs: [{ apiKey: "ambiguous-key" }], selectedLlmProvider: "qwen",
      kimiLlmConfig: { apiKey: "untouched-legacy-key" }, history: [1], identity: "original", unrelated: "untouched",
    };
    const store = storage(original);
    const loaded = await browserLlmConfigStore.load();
    expect(loaded.migrationNotice).toMatch(/原始配置保留不变/);
    await expect(browserLlmConfigStore.save(loaded)).rejects.toThrow("llm_config_invalid");
    expect(store.data).toEqual(original);
    expect(store.set).not.toHaveBeenCalled();
    const official = { ...defaultLlmConfig("qwen"), apiKey: "new-official-key" };
    await browserLlmConfigStore.save({ ...loaded, apiKey: official.apiKey });
    expect(store.data).toEqual(original);
    expect(store.set).toHaveBeenCalledExactlyOnceWith({ selectedLlmProvider: "qwen" });
    expect(await browserLlmConfigStore.load()).toEqual({ ...official, rememberOnDevice: false });
  });
  it.each([
    { apiUrl: "https://relay.example/v1", apiKey: "relay-secret", model: "relay-model" },
    { apiUrl: "https://api.deepseek.com/v1", apiKey: "wrong-secret", model: "wrong-model" },
    { provider: "deepseek", apiUrl: "https://api.moonshot.cn/v1", apiKey: "wrong-secret", model: "wrong-model" },
    { apiKey: "ambiguous-secret", model: "old-model" },
    { apiUrl: "https://api.moonshot.cn/v1", apiKey: 123, model: "old-model" },
    "malformed", null,
  ])("quarantines malformed or unsafe stored config without touching raw storage %#", async (legacy) => {
    const original = { llmConfigs: { kimi: legacy }, kimiLlmConfig: { apiUrl: "https://relay.example", apiKey: "old-key" }, history: [1], identity: "original" };
    const store = storage(original);
    const loaded = await browserLlmConfigStore.load();
    expect(loaded).toMatchObject({ provider: "kimi", apiUrl: "https://api.moonshot.cn/v1", apiKey: "" });
    expect(loaded.migrationNotice).toMatch(/官方/);
    expect(isLlmConfigured(loaded)).toBe(false);
    expect(store.data).toEqual(original);
    expect(store.set).not.toHaveBeenCalled();
  });
  it("quarantines retired Hunyuan credentials and explains the new TokenHub key", async () => {
    const store = storage({ llmConfigs: { hunyuan: { provider: "hunyuan", apiUrl: "https://api.hunyuan.cloud.tencent.com/v1", apiKey: "retired-key", model: "old-model" } } });
    const loaded = await browserLlmConfigStore.load("hunyuan");
    expect(loaded).toMatchObject({ ...defaultLlmConfig("hunyuan"), apiKey: "", model: "old-model" });
    expect(loaded.migrationNotice).toMatch(/2026-09-30.*TokenHub/);
    expect(store.set).not.toHaveBeenCalled();
  });
  it("only replaces the explicitly saved provider and persists the selection", async () => {
    const rawKimi = { apiUrl: "https://relay.example", apiKey: "preserved-relay-key" };
    const legacy = { apiKey: "preserved-legacy-key" };
    const store = storage({ llmConfigs: { kimi: rawKimi }, kimiLlmConfig: legacy, history: [1], identity: "original" });
    const official = { ...defaultLlmConfig("qwen"), apiKey: "new-official-key", model: "custom-model" };
    await browserLlmConfigStore.save(official);
    expect(store.data).toEqual({ llmConfigs: { kimi: rawKimi }, kimiLlmConfig: legacy, history: [1], identity: "original", selectedLlmProvider: "qwen" });
    expect(await browserLlmConfigStore.load()).toEqual({ ...official, rememberOnDevice: false });
    expect((await browserLlmConfigStore.load("glm")).apiKey).toBe("");
  });
  it("permits a quarantined profile only after explicitly supplying a new official key", async () => {
    storage({ kimiLlmConfig: { apiUrl: "https://relay.example", apiKey: "relay-key", model: "custom-model" } });
    const loaded = await browserLlmConfigStore.load();
    await expect(browserLlmConfigStore.save(loaded)).rejects.toThrow("llm_config_invalid");
    await browserLlmConfigStore.save({ ...loaded, apiKey: "new-official-key" });
    expect(await browserLlmConfigStore.load()).toEqual({ ...defaultLlmConfig("kimi"), apiKey: "new-official-key", model: "custom-model", rememberOnDevice: false });
  });
  it("does not persist invalid destination configs", async () => {
    const store = storage();
    await expect(browserLlmConfigStore.save({ ...defaultLlmConfig("kimi"), apiUrl: "https://relay.example", apiKey: "dummy" })).rejects.toThrow("llm_config_invalid");
    expect(store.set).not.toHaveBeenCalled();
  });
  it("does not lose independent provider credentials when saves overlap", async () => {
    storage();
    await Promise.all(providers.map(([provider]) => browserLlmConfigStore.save({ ...defaultLlmConfig(provider), apiKey: `${provider}-key` })));
    for (const [provider] of providers) expect((await browserLlmConfigStore.load(provider)).apiKey).toBe(`${provider}-key`);
  });
  it("rejects storage failures without replacing an existing profile", async () => {
    const store = storage({ "llmRememberedConfigV2:kimi": { ...defaultLlmConfig("kimi"), apiKey: "old-key", rememberOnDevice: true } });
    store.set.mockRejectedValueOnce(new Error("storage-failure"));
    await expect(browserLlmConfigStore.save({ ...defaultLlmConfig("kimi"), apiKey: "new-key", rememberOnDevice: true })).rejects.toThrow();
    expect((await browserLlmConfigStore.load("kimi")).apiKey).toBe("old-key");
  });
});
