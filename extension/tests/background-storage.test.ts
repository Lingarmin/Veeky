import { afterEach, describe, expect, it, vi } from "vitest";
import { installBackgroundHandlers } from "../src/background";
import { browserLlmConfigStore, defaultLlmConfig } from "../src/sidepanel/llm";

function chromeStub() {
  const event = () => ({ addListener: vi.fn() });
  const area = () => ({
    setAccessLevel: vi.fn(async () => undefined),
    get: vi.fn(async () => ({})),
    set: vi.fn(async () => undefined),
  });
  return {
    storage: { local: area(), session: area() },
    action: { onClicked: event() },
    runtime: { onMessage: event(), onConnect: event() },
    tabs: { onActivated: event(), onUpdated: event(), onRemoved: event(), query: vi.fn(async () => []) },
    sidePanel: { setPanelBehavior: vi.fn(async () => undefined), open: vi.fn() },
    alarms: { onAlarm: event(), create: vi.fn(), clear: vi.fn(async () => true) },
    webNavigation: { onHistoryStateUpdated: event(), onCommitted: event() },
    webRequest: { onBeforeRequest: event() },
  };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("background credential storage initialization", () => {
  it("starts both access restrictions synchronously without opening the panel", async () => {
    const browser = chromeStub();
    installBackgroundHandlers(browser as unknown as Parameters<typeof installBackgroundHandlers>[0]);
    for (const area of Object.values(browser.storage)) {
      expect(area.setAccessLevel).toHaveBeenCalledExactlyOnceWith({ accessLevel: "TRUSTED_CONTEXTS" });
      expect(area.get).not.toHaveBeenCalled();
    }
    expect(browser.sidePanel.open).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  it.each(["local", "session"] as const)("handles %s restriction failure without exposing or using credentials", async (name) => {
    const browser = chromeStub();
    browser.storage[name].setAccessLevel.mockRejectedValue(new Error("private-key-not-for-logs"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("chrome", browser);
    installBackgroundHandlers(browser as unknown as Parameters<typeof installBackgroundHandlers>[0]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(browserLlmConfigStore.load()).rejects.toThrow();
    await expect(browserLlmConfigStore.save({ ...defaultLlmConfig("kimi"), apiKey: "secret" })).rejects.toThrow();
    for (const area of Object.values(browser.storage)) {
      expect(area.get).not.toHaveBeenCalled();
      expect(area.set).not.toHaveBeenCalled();
    }
    expect(warning).toHaveBeenCalled();
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private-key-not-for-logs");
  });
});
