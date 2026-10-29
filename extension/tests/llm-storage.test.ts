import { afterEach, describe, expect, it, vi } from "vitest";
import { browserLlmConfigStore, defaultLlmConfig } from "../src/sidepanel/llm";

function setup(initial: Record<string, unknown> = {}) {
  function area(values: Record<string, unknown> = {}) {
    const data = structuredClone(values);
    return {
      data,
      setAccessLevel: vi.fn(async () => undefined),
      get: vi.fn(async () => structuredClone(data)),
      set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(data, structuredClone(value)); }),
      remove: vi.fn(async (key: string) => { delete data[key]; }),
    };
  }
  const local = area(initial);
  const session = area();
  vi.stubGlobal("chrome", { storage: { local, session } });
  return { local, session };
}
afterEach(() => vi.unstubAllGlobals());
const config = () => ({ ...defaultLlmConfig("kimi"), apiKey: "test-secret" });

describe("LLM credential retention", () => {
  it("keeps credentials in the session by default and loses them after restart", async () => {
    const { local, session } = setup();
    await browserLlmConfigStore.save(config());
    expect(JSON.stringify(local.data)).not.toContain("test-secret");
    expect(JSON.stringify(session.data)).toContain("test-secret");
    expect((await browserLlmConfigStore.load()).apiKey).toBe("test-secret");
    for (const key of Object.keys(session.data)) delete session.data[key];
    expect((await browserLlmConfigStore.load()).apiKey).toBe("");
  });
  it("persists only when explicitly remembered and removes that copy when deselected", async () => {
    const { local, session } = setup();
    await browserLlmConfigStore.save({ ...config(), rememberOnDevice: true });
    expect(JSON.stringify(local.data)).toContain("test-secret");
    for (const key of Object.keys(session.data)) delete session.data[key];
    expect(await browserLlmConfigStore.load()).toMatchObject({ apiKey: "test-secret", rememberOnDevice: true });
    await browserLlmConfigStore.save({ ...config(), rememberOnDevice: false });
    expect(JSON.stringify(local.data)).not.toContain("test-secret");
    expect(await browserLlmConfigStore.load()).toMatchObject({ apiKey: "test-secret", rememberOnDevice: false });
  });
  it.each(["local", "session"] as const)("restricts %s access before reading or writing credentials", async (name) => {
    const stores = setup();
    await browserLlmConfigStore.save(config());
    await browserLlmConfigStore.load();
    expect(stores[name].setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
    expect(stores[name].setAccessLevel.mock.invocationCallOrder[0]).toBeLessThan(stores.session.set.mock.invocationCallOrder[0]);
  });
  it.each(["local", "session"] as const)("fails closed when %s access restriction fails", async (name) => {
    const stores = setup();
    stores[name].setAccessLevel.mockRejectedValue(new Error("denied"));
    await expect(browserLlmConfigStore.save(config())).rejects.toThrow();
    await expect(browserLlmConfigStore.load()).rejects.toThrow();
    for (const area of Object.values(stores)) {
      expect(area.get).not.toHaveBeenCalled();
      expect(area.set).not.toHaveBeenCalled();
    }
  });
  it.each(["llmConfigs", "kimiLlmConfig"])("quarantines even official legacy keys in %s without deleting the original", async (key) => {
    const initial = { [key]: key === "llmConfigs" ? { kimi: config() } : config(), history: ["keep"] };
    const { local } = setup(initial);
    const loaded = await browserLlmConfigStore.load();
    expect(loaded.apiKey).toBe("");
    expect(loaded.migrationNotice).toMatch(/重新填写/);
    expect(local.data).toEqual(initial);
    await browserLlmConfigStore.save({ ...loaded, apiKey: "replacement-key" });
    expect(local.data[key]).toEqual(initial[key]);
    expect(local.data.history).toEqual(["keep"]);
  });
  it("isolates provider preferences and credentials across overlapping saves", async () => {
    const { local } = setup();
    await Promise.all([
      browserLlmConfigStore.save({ ...config(), rememberOnDevice: true }),
      browserLlmConfigStore.save({ ...defaultLlmConfig("deepseek"), apiKey: "deepseek-session" }),
    ]);
    expect((await browserLlmConfigStore.load("kimi")).apiKey).toBe("test-secret");
    expect((await browserLlmConfigStore.load("deepseek")).apiKey).toBe("deepseek-session");
    expect(JSON.stringify(local.data)).not.toContain("deepseek-session");
  });
});
