import { describe, expect, it, vi } from "vitest";

import manifest from "../manifest.json";
import { installBackgroundHandlers, parseVideoId } from "../src/background";

class FakeEvent {
  listeners: Array<(...args: any[]) => any> = [];
  addListener = (listener: (...args: any[]) => any) => this.listeners.push(listener);
}

function createChrome() {
  const actionClicked = new FakeEvent();
  const tabActivated = new FakeEvent();
  const tabUpdated = new FakeEvent();
  const tabRemoved = new FakeEvent();
  const message = new FakeEvent();
  let stored: Record<string, unknown> = {};

  return {
    action: { onClicked: actionClicked },
    tabs: {
      onActivated: tabActivated,
      onUpdated: tabUpdated,
      onRemoved: tabRemoved,
      get: vi.fn(async (tabId: number) => ({ id: tabId, url: "https://www.youtube.com/watch?v=aircAruvnKk" })),
      update: vi.fn(async () => undefined),
      query: vi.fn(async () => [{ id: 7, url: "https://www.youtube.com/watch?v=aircAruvnKk", title: "Neural networks" }]),
    },
    scripting: {
      executeScript: vi.fn(async () => undefined),
    },
    runtime: { onMessage: message },
    sidePanel: {
      setOptions: vi.fn(async () => undefined),
      open: vi.fn(async () => undefined),
      setPanelBehavior: vi.fn(async () => undefined),
    },
    storage: {
      session: {
        get: vi.fn(async () => stored),
        set: vi.fn(async (value: Record<string, unknown>) => { stored = { ...stored, ...value }; }),
      },
    },
    events: { actionClicked, tabActivated, tabUpdated, tabRemoved, message },
  };
}

function dispatchMessage(chrome: ReturnType<typeof createChrome>, message: object) {
  return new Promise((resolve) => {
    chrome.events.message.listeners[0](message, {}, resolve);
  });
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("background tab isolation", () => {
  it("extracts only supported YouTube video URLs", () => {
    expect(parseVideoId("https://www.youtube.com/watch?v=aircAruvnKk")).toBe("aircAruvnKk");
    expect(parseVideoId("https://youtu.be/aircAruvnKk?t=20")).toBe("aircAruvnKk");
    expect(parseVideoId("https://example.com/watch?v=aircAruvnKk")).toBeNull();
  });

  it("declares a default side panel page", () => {
    expect(manifest.side_panel?.default_path).toBe("sidepanel.html");
  });

  it("declares the Veeky brand and toolbar icons", () => {
    expect(manifest.name).toBe("Veeky - AI Agent：YouTube Video Translate & Summarize");
    expect(manifest.action.default_title).toBe("打开 Veeky");
    expect(manifest.icons).toEqual({
      "16": "icons/veeky-16.png",
      "32": "icons/veeky-32.png",
      "48": "icons/veeky-48.png",
      "128": "icons/veeky-128.png",
    });
    expect(manifest.action.default_icon).toEqual(manifest.icons);
  });

  it("prepares the active YouTube tab for the side panel", async () => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await flushMicrotasks();

    expect(chrome.sidePanel.setOptions).toHaveBeenCalledWith({ tabId: 7, path: "sidepanel.html", enabled: true });
  });

  it("opens the panel before asynchronous tab configuration completes", () => {
    const chrome = createChrome();
    let resolveOptions: ((value: undefined) => void) | undefined;
    chrome.sidePanel.setOptions.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => { resolveOptions = resolve; }),
    );
    installBackgroundHandlers(chrome as never);

    chrome.events.actionClicked.listeners[0]({ id: 7, url: "https://www.youtube.com/watch?v=aircAruvnKk" });

    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 7 });
    resolveOptions?.(undefined);
  });

  it("hides the panel on other tabs and restores the analyzed tab", async () => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await dispatchMessage(
      chrome,
      { type: "REGISTER_ANALYSIS", tabId: 7, videoId: "aircAruvnKk", jobId: "job-1" },
    );

    chrome.tabs.get.mockResolvedValueOnce({ id: 8, url: "https://example.com" });
    await chrome.events.tabActivated.listeners[0]({ tabId: 8 });
    expect(chrome.sidePanel.setOptions).toHaveBeenLastCalledWith({ tabId: 8, enabled: false });

    await chrome.events.tabActivated.listeners[0]({ tabId: 7 });
    expect(chrome.sidePanel.setOptions).toHaveBeenLastCalledWith({ tabId: 7, path: "sidepanel.html", enabled: true });
  });

  it("hides the panel if the analyzed tab navigates away from its video", async () => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await dispatchMessage(
      chrome,
      { type: "REGISTER_ANALYSIS", tabId: 7, videoId: "aircAruvnKk", jobId: "job-1" },
    );

    await chrome.events.tabUpdated.listeners[0](7, { url: "https://example.com" }, { id: 7, url: "https://example.com" });
    expect(chrome.sidePanel.setOptions).toHaveBeenLastCalledWith({ tabId: 7, enabled: false });

    await chrome.events.tabUpdated.listeners[0](
      7,
      { url: "https://www.youtube.com/watch?v=aircAruvnKk" },
      { id: 7, url: "https://www.youtube.com/watch?v=aircAruvnKk" },
    );
    expect(chrome.sidePanel.setOptions).toHaveBeenLastCalledWith({ tabId: 7, path: "sidepanel.html", enabled: true });
  });

  it("seeks the current YouTube player without navigating the tab", async () => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);

    await dispatchMessage(
      chrome,
      { type: "SEEK_VIDEO", tabId: 7, videoId: "aircAruvnKk", startMs: 72_500 },
    );

    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7 }, args: [72.5] }),
    );
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it("navigates only when seeking a different video", async () => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);

    await dispatchMessage(
      chrome,
      { type: "SEEK_VIDEO", tabId: 7, videoId: "BpOsHF5Oj_I", startMs: 0 },
    );

    expect(chrome.tabs.update).toHaveBeenCalledWith(7, {
      url: "https://www.youtube.com/watch?v=BpOsHF5Oj_I&t=0s",
    });
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("removes stored analysis state when the tab closes", async () => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await dispatchMessage(
      chrome,
      { type: "REGISTER_ANALYSIS", tabId: 7, videoId: "aircAruvnKk", jobId: "job-1" },
    );

    await chrome.events.tabRemoved.listeners[0](7);
    expect(chrome.storage.session.set).toHaveBeenLastCalledWith({ analyzedTabs: {} });
  });
});
