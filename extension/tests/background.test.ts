import { describe, expect, it, vi } from "vitest";

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

describe("background tab isolation", () => {
  it("extracts only supported YouTube video URLs", () => {
    expect(parseVideoId("https://www.youtube.com/watch?v=aircAruvnKk")).toBe("aircAruvnKk");
    expect(parseVideoId("https://youtu.be/aircAruvnKk?t=20")).toBe("aircAruvnKk");
    expect(parseVideoId("https://example.com/watch?v=aircAruvnKk")).toBeNull();
  });

  it("opens the panel from the extension action on a YouTube video", async () => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);

    await chrome.events.actionClicked.listeners[0]({ id: 7, url: "https://www.youtube.com/watch?v=aircAruvnKk" });

    expect(chrome.sidePanel.setOptions).toHaveBeenCalledWith({ tabId: 7, path: "sidepanel.html", enabled: true });
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 7 });
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
