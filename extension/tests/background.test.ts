import { describe, expect, it, vi } from "vitest";

import manifest from "../manifest.json";
import { installBackgroundHandlers, parseVideoId } from "../src/background";
import { contentKey } from "../src/shared/content";
import type { MediaCandidate } from "../src/shared/types";

class FakeEvent {
  listeners: Array<(...args: any[]) => any> = [];
  registrations: any[][] = [];
  addListener = (...args: any[]) => {
    this.listeners.push(args[0]);
    this.registrations.push(args);
  };
}

function createChrome(initialStored: Record<string, unknown> = {}) {
  const actionClicked = new FakeEvent();
  const tabActivated = new FakeEvent();
  const tabUpdated = new FakeEvent();
  const tabRemoved = new FakeEvent();
  const message = new FakeEvent();
  const beforeRequest = new FakeEvent();
  const alarm = new FakeEvent();
  const historyStateUpdated = new FakeEvent();
  const navigationCommitted = new FakeEvent();
  let stored: Record<string, unknown> = structuredClone(initialStored);

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
    alarms: {
      onAlarm: alarm,
      create: vi.fn(),
      clear: vi.fn(async () => true),
    },
    webRequest: { onBeforeRequest: beforeRequest },
    webNavigation: {
      onHistoryStateUpdated: historyStateUpdated,
      onCommitted: navigationCommitted,
    },
    sidePanel: {
      setOptions: vi.fn(async () => undefined),
      open: vi.fn(async () => undefined),
      setPanelBehavior: vi.fn(async () => undefined),
    },
    storage: {
      session: {
        get: vi.fn(async () => structuredClone(stored)),
        set: vi.fn(async (value: Record<string, unknown>) => { stored = { ...stored, ...value }; }),
      },
    },
    events: {
      actionClicked,
      tabActivated,
      tabUpdated,
      tabRemoved,
      message,
      beforeRequest,
      alarm,
      historyStateUpdated,
      navigationCommitted,
    },
    getStored: () => stored,
  };
}

function dispatchMessage(chrome: ReturnType<typeof createChrome>, message: object, sender: object = {}) {
  return new Promise((resolve) => {
    chrome.events.message.listeners[0](message, sender, resolve);
  });
}

async function flushMicrotasks() {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
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

  it("declares X content-script and media-capture access", () => {
    expect(manifest.permissions).toEqual(expect.arrayContaining([
      "webRequest",
      "webNavigation",
      "offscreen",
      "alarms",
    ]));
    expect(manifest.host_permissions).toEqual(expect.arrayContaining([
      "https://*.youtube.com/*",
      "https://youtu.be/*",
      "https://www.youtu.be/*",
      "https://*.x.com/*",
      "https://video.twimg.com/*",
    ]));
    expect(manifest.content_scripts).toEqual([{
      matches: ["https://x.com/*", "https://www.x.com/*"],
      js: ["content.js"],
      run_at: "document_idle",
    }]);
  });

  it("tracks SPA and full-document navigation", () => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);

    expect(chrome.events.historyStateUpdated.listeners).toHaveLength(1);
    expect(chrome.events.navigationCommitted.listeners).toHaveLength(1);
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

  it("enables and opens the panel for an explicit X video route", async () => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await flushMicrotasks();

    const url = "https://x.com/viktoroddy/status/2075545587093807111/video/1";
    chrome.events.tabUpdated.listeners[0](7, { url }, { id: 7, url });
    await flushMicrotasks();
    expect(chrome.sidePanel.setOptions).toHaveBeenLastCalledWith({
      tabId: 7,
      path: "sidepanel.html",
      enabled: true,
    });

    chrome.events.actionClicked.listeners[0]({ id: 7, url });
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 7 });
  });

  it("opens a bare X status synchronously even before a player is detected", async () => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await flushMicrotasks();

    const url = "https://x.com/viktoroddy/status/2075545587093807111";
    chrome.events.tabUpdated.listeners[0](7, { url }, { id: 7, url });
    await flushMicrotasks();
    expect(chrome.sidePanel.setOptions).toHaveBeenLastCalledWith({
      tabId: 7,
      path: "sidepanel.html",
      enabled: true,
    });

    const clicked = chrome.events.actionClicked.listeners[0]({ id: 7, url });
    expect(clicked).toBeUndefined();
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 7 });
  });

  it("contains rejected async tab event work", async () => {
    const chrome = createChrome();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installBackgroundHandlers(chrome as never);
    await flushMicrotasks();

    chrome.sidePanel.setOptions.mockRejectedValueOnce(new Error("tab closed"));
    const updated = chrome.events.tabUpdated.listeners[0](
      7,
      { url: "https://x.com/u/status/2075545587093807111/video/1" },
      { id: 7, url: "https://x.com/u/status/2075545587093807111/video/1" },
    );
    if (updated instanceof Promise) await updated.catch(() => undefined);
    expect(updated).toBeUndefined();

    chrome.tabs.get.mockRejectedValueOnce(new Error("tab removed"));
    const activated = chrome.events.tabActivated.listeners[0]({ tabId: 7 });
    if (activated instanceof Promise) await activated.catch(() => undefined);
    expect(activated).toBeUndefined();

    await flushMicrotasks();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, "Veeky background event failed");
    expect(warn).toHaveBeenNthCalledWith(2, "Veeky background event failed");
    warn.mockRestore();
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
    chrome.events.tabActivated.listeners[0]({ tabId: 8 });
    await flushMicrotasks();
    expect(chrome.sidePanel.setOptions).toHaveBeenLastCalledWith({ tabId: 8, enabled: false });

    chrome.events.tabActivated.listeners[0]({ tabId: 7 });
    await flushMicrotasks();
    expect(chrome.sidePanel.setOptions).toHaveBeenLastCalledWith({ tabId: 7, path: "sidepanel.html", enabled: true });
  });

  it("hides the panel if the analyzed tab navigates away from its video", async () => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await dispatchMessage(
      chrome,
      { type: "REGISTER_ANALYSIS", tabId: 7, videoId: "aircAruvnKk", jobId: "job-1" },
    );

    chrome.events.tabUpdated.listeners[0](7, { url: "https://example.com" }, { id: 7, url: "https://example.com" });
    await flushMicrotasks();
    expect(chrome.sidePanel.setOptions).toHaveBeenLastCalledWith({ tabId: 7, enabled: false });

    chrome.events.tabUpdated.listeners[0](
      7,
      { url: "https://www.youtube.com/watch?v=aircAruvnKk" },
      { id: 7, url: "https://www.youtube.com/watch?v=aircAruvnKk" },
    );
    await flushMicrotasks();
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

    chrome.events.tabRemoved.listeners[0](7);
    await flushMicrotasks();
    expect(chrome.storage.session.set).toHaveBeenLastCalledWith({ analyzedTabs: {} });
  });

  it("restores each analysis when switching between media items in the same tab", async () => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    const mediaOne = {
      platform: "x" as const,
      sourceContentId: "2075545587093807111",
      mediaIndex: 1,
    };
    const mediaTwo = { ...mediaOne, mediaIndex: 2 };
    await dispatchMessage(
      chrome,
      {
        type: "REGISTER_ANALYSIS",
        tabId: 7,
        contentRef: mediaOne,
        jobId: "job-1",
      },
    );
    await dispatchMessage(
      chrome,
      { type: "REGISTER_ANALYSIS", tabId: 7, contentRef: mediaTwo, jobId: "job-2" },
    );

    chrome.tabs.query.mockResolvedValueOnce([{
      id: 7,
      url: "https://x.com/viktoroddy/status/2075545587093807111/video/1",
      title: "X video",
    }]);
    const firstContext = await dispatchMessage(chrome, { type: "GET_ACTIVE_TAB_CONTEXT" });
    expect(firstContext).toEqual(expect.objectContaining({
      contentRef: mediaOne,
      analysis: expect.objectContaining({ contentRef: mediaOne, jobId: "job-1" }),
    }));

    chrome.tabs.query.mockResolvedValueOnce([{
      id: 7,
      url: "https://x.com/viktoroddy/status/2075545587093807111/video/2",
      title: "X video",
    }]);
    const secondContext = await dispatchMessage(chrome, { type: "GET_ACTIVE_TAB_CONTEXT" });
    expect(secondContext).toEqual(expect.objectContaining({
      contentRef: mediaTwo,
      analysis: expect.objectContaining({ contentRef: mediaTwo, jobId: "job-2" }),
    }));

    chrome.tabs.query.mockResolvedValueOnce([{
      id: 7,
      url: "https://x.com/viktoroddy/status/2075545587093807111/video/1",
      title: "X video",
    }]);
    const restoredContext = await dispatchMessage(chrome, { type: "GET_ACTIVE_TAB_CONTEXT" });
    expect(restoredContext).toEqual(expect.objectContaining({
      contentRef: mediaOne,
      analysis: expect.objectContaining({ contentRef: mediaOne, jobId: "job-1" }),
    }));
  });
});

describe("X media candidate capture", () => {
  const contentRef = {
    platform: "x" as const,
    sourceContentId: "2075545587093807111",
    mediaIndex: 1,
  };
  const statusUrl = "https://x.com/owner/status/2075545587093807111/video/1";

  function contentSender(tabId = 7, url = statusUrl) {
    return { tab: { id: tabId, url }, url };
  }

  function observeStatusRoute(
    chrome: ReturnType<typeof createChrome>,
    tabId = 7,
    url = statusUrl,
  ) {
    chrome.events.historyStateUpdated.listeners[0]({ tabId, frameId: 0, url });
  }

  async function capture(
    chrome: ReturnType<typeof createChrome>,
    url: string,
    options: { tabId?: number; type?: string; timeStamp?: number } = {},
  ) {
    return chrome.events.beforeRequest.listeners[0]({
      tabId: options.tabId ?? 7,
      url,
      type: options.type ?? "media",
      timeStamp: options.timeStamp ?? Date.now(),
    });
  }

  it("registers the narrowest practical video request listener", () => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);

    expect(chrome.events.beforeRequest.registrations[0].slice(1)).toEqual([{
      urls: ["https://video.twimg.com/*"],
      types: ["media", "xmlhttprequest"],
    }]);
  });

  it("captures classified candidates only during the active 15-second window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE",
      contentRef,
      durationMs: 30_000,
    }, contentSender());

    const urls = [
      "https://video.twimg.com/amplify_video/123/vid/avc1/file.mp4?tag=14",
      "https://video.twimg.com/amplify_video/123/pl/master.m3u8?token=opaque",
      "https://video.twimg.com/amplify_video/123/chunk/1.ts?token=opaque",
    ];
    await capture(chrome, urls[0]);
    await capture(chrome, urls[1], { type: "xmlhttprequest" });
    await capture(chrome, urls[2], { timeStamp: Date.now() + 1 });

    const response = await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES",
      tabId: 7,
      contentRef,
    }, contentSender());
    expect(response).toEqual({ candidates: [
      { url: urls[0], kind: "mp4", capturedAt: Date.now() },
      { url: urls[1], kind: "hls", capturedAt: Date.now() },
      { url: urls[2], kind: "segment", capturedAt: Date.now() + 1 },
    ] });

    vi.advanceTimersByTime(15_001);
    await capture(chrome, "https://video.twimg.com/amplify_video/123/vid/avc1/late.mp4");
    const afterWindow = await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES",
      tabId: 7,
      contentRef,
    }, contentSender());
    expect(afterWindow).toEqual(response);
    vi.useRealTimers();
  });

  it("does not lose the first request racing the active-player signal", async () => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    const active = dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0,
    }, contentSender());
    await capture(chrome, "https://video.twimg.com/path/first.mp4");
    await active;

    expect(await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef,
    }, contentSender())).toEqual({ candidates: [expect.objectContaining({
      url: "https://video.twimg.com/path/first.mp4",
      kind: "mp4",
    })] });
  });

  it("preserves a player route observed before stale startup tab initialization completes", async () => {
    const chrome = createChrome();
    let resolveActiveTab: ((tabs: Array<{ id: number; url: string; title: string }>) => void) | undefined;
    chrome.tabs.query.mockImplementation(() => new Promise((resolve) => { resolveActiveTab = resolve; }));
    installBackgroundHandlers(chrome as never);
    await flushMicrotasks();

    const active = dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0,
    }, contentSender());
    resolveActiveTab?.([{
      id: 7,
      url: "https://www.youtube.com/watch?v=aircAruvnKk",
      title: "Stale active tab",
    }]);
    await active;

    await capture(chrome, "https://video.twimg.com/path/after-startup.mp4");
    expect(await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef,
    }, contentSender())).toEqual({ candidates: [expect.objectContaining({
      url: "https://video.twimg.com/path/after-startup.mp4",
    })] });
  });

  it("claims a recent request that arrives just before the active-player signal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await flushMicrotasks();
    observeStatusRoute(chrome);
    await capture(chrome, "https://video.twimg.com/path/pre-active.m3u8");
    await capture(chrome, "https://video.twimg.com/path/pre-active.mp4");
    vi.advanceTimersByTime(100);

    await dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0,
    }, contentSender());

    expect(await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef,
    }, contentSender())).toEqual({ candidates: [
      expect.objectContaining({ url: "https://video.twimg.com/path/pre-active.mp4", kind: "mp4" }),
      expect.objectContaining({ url: "https://video.twimg.com/path/pre-active.m3u8", kind: "hls" }),
    ] });
    vi.useRealTimers();
  });

  it("does not claim stale or another tab's buffered requests", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await flushMicrotasks();
    observeStatusRoute(chrome);
    await capture(chrome, "https://video.twimg.com/path/stale.mp4");
    vi.advanceTimersByTime(2_001);
    observeStatusRoute(chrome, 8);
    await capture(chrome, "https://video.twimg.com/path/other-tab.mp4", { tabId: 8 });

    await dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0,
    }, contentSender());

    expect(await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef,
    }, contentSender())).toEqual({ candidates: [] });
    vi.useRealTimers();
  });

  it("retains a claimed segment as segment-only evidence", async () => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await flushMicrotasks();
    observeStatusRoute(chrome);
    await capture(chrome, "https://video.twimg.com/path/pre-active.ts");

    await dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0,
    }, contentSender());

    expect(await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef,
    }, contentSender())).toEqual({ candidates: [expect.objectContaining({ kind: "segment" })] });
  });

  it("claims a new-status request that precedes both onUpdated and the active signal", async () => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await flushMicrotasks();
    chrome.events.historyStateUpdated.listeners[0]({
      tabId: 7,
      frameId: 0,
      url: statusUrl,
    });
    await dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0,
    }, contentSender());
    await dispatchMessage(chrome, {
      type: "X_PLAYER_INACTIVE", contentRef,
    }, contentSender());

    void capture(chrome, "https://video.twimg.com/path/old-status.mp4");
    const candidateUrl = "https://video.twimg.com/path/new-status.mp4";
    const nextRef = { ...contentRef, sourceContentId: "2075545587093807222" };
    const nextUrl = "https://x.com/owner/status/2075545587093807222/video/1";
    chrome.events.historyStateUpdated.listeners[0]({
      tabId: 7,
      frameId: 0,
      url: nextUrl,
    });
    void capture(chrome, candidateUrl);
    chrome.events.tabUpdated.listeners[0](7, { url: nextUrl }, { id: 7, url: nextUrl });
    await flushMicrotasks();

    await dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE", contentRef: nextRef, durationMs: 0,
    }, contentSender(7, nextUrl));

    expect(await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef: nextRef,
    }, contentSender(7, nextUrl))).toEqual({ candidates: [expect.objectContaining({
      url: candidateUrl,
      kind: "mp4",
    })] });
  });

  it("does not claim an old-status request after a full navigation", async () => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await flushMicrotasks();
    chrome.events.navigationCommitted.listeners[0]({
      tabId: 7,
      frameId: 0,
      url: statusUrl,
    });
    void capture(chrome, "https://video.twimg.com/path/old-navigation.mp4");

    const nextRef = { ...contentRef, sourceContentId: "2075545587093807222" };
    const nextUrl = "https://x.com/owner/status/2075545587093807222/video/1";
    chrome.events.navigationCommitted.listeners[0]({
      tabId: 7,
      frameId: 0,
      url: nextUrl,
    });
    await dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE", contentRef: nextRef, durationMs: 0,
    }, contentSender(7, nextUrl));

    expect(await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef: nextRef,
    }, contentSender(7, nextUrl))).toEqual({ candidates: [] });
  });

  it("bounds the recent request ring by count and URL bytes", async () => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await flushMicrotasks();
    observeStatusRoute(chrome);
    for (let index = 0; index < 20; index += 1) {
      await capture(chrome, `https://video.twimg.com/path/recent-${index}.mp4`);
    }
    for (let index = 0; index < 4; index += 1) {
      await capture(chrome, `https://video.twimg.com/path/long-${index}.mp4?token=${"x".repeat(8_000)}`);
    }

    await dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0,
    }, contentSender());
    const response = await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef,
    }, contentSender()) as { candidates: Array<{ url: string }> };

    expect(response.candidates.length).toBeLessThanOrEqual(12);
    expect(response.candidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "https://video.twimg.com/path/recent-0.mp4" }),
    ]));
    expect(response.candidates.reduce((total, item) => total + item.url.length * 2, 0))
      .toBeLessThanOrEqual(32_000);
  });

  it("expires the recent request buffer on a timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await flushMicrotasks();
    observeStatusRoute(chrome);

    await capture(chrome, "https://video.twimg.com/path/timed.mp4");
    await flushMicrotasks();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_501);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("caps recent requests across tabs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await flushMicrotasks();
    for (let tabId = 7; tabId <= 11; tabId += 1) {
      observeStatusRoute(chrome, tabId);
      for (let index = 0; index < 12; index += 1) {
        vi.advanceTimersByTime(1);
        await capture(chrome, `https://video.twimg.com/path/recent-${tabId}-${index}.mp4`, { tabId });
      }
    }

    let total = 0;
    for (let tabId = 7; tabId <= 11; tabId += 1) {
      await dispatchMessage(chrome, {
        type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0,
      }, contentSender(tabId));
      const response = await dispatchMessage(chrome, {
        type: "GET_MEDIA_CANDIDATES", tabId, contentRef,
      }, contentSender(tabId)) as { candidates: MediaCandidate[] };
      total += response.candidates.length;
    }

    expect(total).toBe(48);
    vi.useRealTimers();
  });

  it("caps recent request URL bytes across tabs", async () => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await flushMicrotasks();
    for (let tabId = 7; tabId <= 11; tabId += 1) {
      observeStatusRoute(chrome, tabId);
      await capture(
        chrome,
        `https://video.twimg.com/path/recent-${tabId}.mp4?token=${"x".repeat(8_000)}`,
        { tabId },
      );
    }

    let totalBytes = 0;
    for (let tabId = 7; tabId <= 11; tabId += 1) {
      await dispatchMessage(chrome, {
        type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0,
      }, contentSender(tabId));
      const response = await dispatchMessage(chrome, {
        type: "GET_MEDIA_CANDIDATES", tabId, contentRef,
      }, contentSender(tabId)) as { candidates: MediaCandidate[] };
      totalBytes += response.candidates.reduce((total, candidate) => total + candidate.url.length * 2, 0);
    }

    expect(totalBytes).toBeGreaterThan(0);
    expect(totalBytes).toBeLessThanOrEqual(64_000);
  });

  it("uses request time when queued capture work runs after the window closes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0,
    }, contentSender());

    void capture(chrome, "https://video.twimg.com/path/in-window.mp4", {
      timeStamp: Date.now() + 14_000,
    });
    vi.advanceTimersByTime(16_000);

    expect(await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef,
    }, contentSender())).toEqual({ candidates: [expect.objectContaining({
      url: "https://video.twimg.com/path/in-window.mp4",
    })] });
    vi.useRealTimers();
  });

  it("does not extend the capture window for a same-player metadata update", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0,
    }, contentSender());
    vi.advanceTimersByTime(10_000);
    await dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE", contentRef, durationMs: 30_000,
    }, contentSender());
    vi.advanceTimersByTime(10_000);
    await capture(chrome, "https://video.twimg.com/path/too-late.mp4");

    expect(await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef,
    }, contentSender())).toEqual({ candidates: [] });
    vi.useRealTimers();
  });

  it.each([
    ["http://video.twimg.com/path/file.mp4", "media"],
    ["https://video.twimg.com:444/path/file.mp4", "media"],
    ["https://user@video.twimg.com/path/file.mp4", "media"],
    ["https://video.twimg.com/path/file.mp4#fragment", "media"],
    ["https://video.twimg.com.evil.example/path/file.mp4", "media"],
    ["https://pbs.twimg.com/path/file.mp4", "media"],
    ["https://video.twimg.com/path/image.jpg", "media"],
    ["https://video.twimg.com/path/file.mp4", "image"],
  ])("rejects unsafe or unrelated request %s (%s)", async (url, type) => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await dispatchMessage(chrome, { type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0 }, contentSender());
    await capture(chrome, url, { type });

    expect(await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef,
    }, contentSender())).toEqual({ candidates: [] });
  });

  it("does not trust a player signal or query for another status or tab", async () => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE",
      contentRef,
      durationMs: 0,
    }, contentSender(7, "https://x.com/owner/status/2075545587093807222/video/1"));
    await capture(chrome, "https://video.twimg.com/path/file.mp4");
    expect(await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 8, contentRef,
    }, contentSender())).toEqual({ candidates: [] });
  });

  it("accepts a current SPA frame URL while the tab URL still reports the prior status", async () => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    const priorUrl = "https://x.com/owner/status/2075545587093807222/video/1";
    await dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0,
    }, { url: statusUrl, tab: { id: 7, url: priorUrl } });
    await capture(chrome, "https://video.twimg.com/path/current.mp4");

    expect(await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef,
    }, contentSender())).toEqual({ candidates: [expect.objectContaining({
      url: "https://video.twimg.com/path/current.mp4",
    })] });
  });

  it("uses the current frame URL when an inactive signal races a stale tab URL", async () => {
    const bareUrl = "https://x.com/owner/status/2075545587093807111";
    const priorUrl = "https://x.com/owner/status/2075545587093807222";
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    const sender = { url: bareUrl, tab: { id: 7, url: priorUrl } };
    await dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0,
    }, sender);
    await dispatchMessage(chrome, { type: "X_PLAYER_INACTIVE", contentRef }, sender);

    chrome.tabs.query.mockResolvedValue([{ id: 7, url: bareUrl, title: "X status" }]);
    expect(await dispatchMessage(chrome, { type: "GET_ACTIVE_TAB_CONTEXT" })).toEqual(
      expect.objectContaining({ contentRef, videoId: null }),
    );
    expect(chrome.sidePanel.setOptions).toHaveBeenLastCalledWith({
      tabId: 7, path: "sidepanel.html", enabled: true,
    });
  });

  it("makes a bare status usable after a real active-player signal", async () => {
    const bareUrl = "https://x.com/owner/status/2075545587093807111";
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0,
    }, contentSender(7, bareUrl));

    chrome.tabs.query.mockResolvedValueOnce([{ id: 7, url: bareUrl, title: "X status" }]);
    expect(await dispatchMessage(chrome, { type: "GET_ACTIVE_TAB_CONTEXT" })).toEqual(
      expect.objectContaining({ contentRef, videoId: null }),
    );
    expect(chrome.sidePanel.setOptions).toHaveBeenLastCalledWith({
      tabId: 7, path: "sidepanel.html", enabled: true,
    });
  });

  it("restores a signaled bare status when its tab becomes active again", async () => {
    const bareUrl = "https://x.com/owner/status/2075545587093807111";
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0,
    }, contentSender(7, bareUrl));
    chrome.tabs.get.mockResolvedValueOnce({ id: 7, url: bareUrl });

    chrome.events.tabActivated.listeners[0]({ tabId: 7 });
    await flushMicrotasks();

    expect(chrome.sidePanel.setOptions).toHaveBeenLastCalledWith({
      tabId: 7, path: "sidepanel.html", enabled: true,
    });
  });

  it("keeps a bare status usable after the player becomes inactive", async () => {
    const bareUrl = "https://x.com/owner/status/2075545587093807111";
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0,
    }, contentSender(7, bareUrl));
    await dispatchMessage(chrome, {
      type: "X_PLAYER_INACTIVE", contentRef,
    }, contentSender(7, bareUrl));

    chrome.tabs.query.mockResolvedValue([{ id: 7, url: bareUrl, title: "X status" }]);
    expect(await dispatchMessage(chrome, { type: "GET_ACTIVE_TAB_CONTEXT" })).toEqual(
      expect.objectContaining({ contentRef, videoId: null }),
    );
    chrome.events.actionClicked.listeners[0]({ id: 7, url: bareUrl });
    await flushMicrotasks();
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 7 });

    await capture(chrome, "https://video.twimg.com/path/after-pause.mp4");
    expect(await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef,
    }, contentSender(7, bareUrl))).toEqual({ candidates: [] });
  });

  it("restores a paused bare status after a service worker restart without reopening capture", async () => {
    const bareUrl = "https://x.com/owner/status/2075545587093807111";
    const original = createChrome();
    installBackgroundHandlers(original as never);
    await dispatchMessage(original, {
      type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0,
    }, contentSender(7, bareUrl));
    await dispatchMessage(original, {
      type: "X_PLAYER_INACTIVE", contentRef,
    }, contentSender(7, bareUrl));
    expect(original.getStored()).toEqual(expect.objectContaining({
      xLastDetectedContent: {
        "7": { contentRef, canonicalStatusId: contentRef.sourceContentId },
      },
    }));

    const restarted = createChrome(original.getStored());
    restarted.tabs.query.mockResolvedValue([{ id: 7, url: bareUrl, title: "X status" }]);
    installBackgroundHandlers(restarted as never);
    await flushMicrotasks();
    const clicked = restarted.events.actionClicked.listeners[0]({ id: 7, url: bareUrl });
    if (clicked instanceof Promise) await clicked;

    expect(restarted.sidePanel.open).toHaveBeenCalledWith({ tabId: 7 });
    expect(await dispatchMessage(restarted, { type: "GET_ACTIVE_TAB_CONTEXT" })).toEqual(
      expect.objectContaining({ contentRef, videoId: null }),
    );
    await capture(restarted, "https://video.twimg.com/path/after-restart.mp4");
    expect(await dispatchMessage(restarted, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef,
    }, contentSender(7, bareUrl))).toEqual({ candidates: [] });
  });

  it("hydrates the restarted worker before a bare-status toolbar click", async () => {
    const bareUrl = "https://x.com/owner/status/2075545587093807111";
    const original = createChrome();
    installBackgroundHandlers(original as never);
    await dispatchMessage(original, {
      type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0,
    }, contentSender(7, bareUrl));
    await dispatchMessage(original, {
      type: "X_PLAYER_INACTIVE", contentRef,
    }, contentSender(7, bareUrl));

    const restarted = createChrome(original.getStored());
    restarted.tabs.query.mockResolvedValue([{ id: 7, url: bareUrl, title: "X status" }]);
    installBackgroundHandlers(restarted as never);
    await flushMicrotasks();
    restarted.storage.session.get.mockImplementation(() => new Promise(() => undefined));

    const clicked = restarted.events.actionClicked.listeners[0]({ id: 7, url: bareUrl });

    expect(clicked).toBeUndefined();
    expect(restarted.sidePanel.open).toHaveBeenCalledWith({ tabId: 7 });
  });

  it("opens a cold-start bare status before the first microtask", async () => {
    const bareUrl = "https://x.com/owner/status/2075545587093807111";
    const chrome = createChrome({
      xLastDetectedContent: {
        "7": { contentRef, canonicalStatusId: contentRef.sourceContentId },
      },
    });
    let resolveActiveTab: ((tabs: Array<{ id: number; url: string; title: string }>) => void) | undefined;
    chrome.tabs.query.mockImplementation(() => new Promise((resolve) => { resolveActiveTab = resolve; }));
    installBackgroundHandlers(chrome as never);

    const clicked = chrome.events.actionClicked.listeners[0]({ id: 7, url: bareUrl });
    expect(clicked).toBeUndefined();
    expect(chrome.sidePanel.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: false });
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 7 });

    await Promise.resolve();
    expect(chrome.sidePanel.open).toHaveBeenCalledTimes(1);
    resolveActiveTab?.([{ id: 7, url: bareUrl, title: "X status" }]);
  });

  it("closes a persisted active capture window when the service worker restarts", async () => {
    const bareUrl = "https://x.com/owner/status/2075545587093807111";
    const original = createChrome();
    installBackgroundHandlers(original as never);
    await dispatchMessage(original, {
      type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0,
    }, contentSender(7, bareUrl));

    const restarted = createChrome(original.getStored());
    restarted.tabs.query.mockResolvedValue([{ id: 7, url: bareUrl, title: "X status" }]);
    installBackgroundHandlers(restarted as never);
    await capture(restarted, "https://video.twimg.com/path/restarted-active.mp4");

    expect(await dispatchMessage(restarted, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef,
    }, contentSender(7, bareUrl))).toEqual({ candidates: [] });
    expect(await dispatchMessage(restarted, { type: "GET_ACTIVE_TAB_CONTEXT" })).toEqual(
      expect.objectContaining({ contentRef, videoId: null }),
    );
  });

  it("rejects and clears a persisted bare-status ref after navigation to another status", async () => {
    const bareUrl = "https://x.com/owner/status/2075545587093807111";
    const original = createChrome();
    installBackgroundHandlers(original as never);
    await dispatchMessage(original, {
      type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0,
    }, contentSender(7, bareUrl));

    const restarted = createChrome(original.getStored());
    const otherStatusUrl = "https://x.com/owner/status/2075545587093807222";
    restarted.tabs.query.mockResolvedValue([{ id: 7, url: otherStatusUrl, title: "Other status" }]);
    installBackgroundHandlers(restarted as never);
    await flushMicrotasks();

    expect(await dispatchMessage(restarted, { type: "GET_ACTIVE_TAB_CONTEXT" })).toEqual(
      expect.objectContaining({ contentRef: null, videoId: null }),
    );
    expect(restarted.getStored()).toEqual(expect.objectContaining({ xLastDetectedContent: {} }));
    restarted.events.actionClicked.listeners[0]({ id: 7, url: otherStatusUrl });
    await flushMicrotasks();
    expect(restarted.sidePanel.open).toHaveBeenCalledWith({ tabId: 7 });
  });

  it("does not let stale panel cleanup overwrite another tab's detected content", async () => {
    const staleRef = { ...contentRef, sourceContentId: "2075545587093807222" };
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await flushMicrotasks();
    await chrome.storage.session.set({
      xLastDetectedContent: {
        "8": { contentRef: staleRef, canonicalStatusId: staleRef.sourceContentId },
      },
    });

    const writeStored = chrome.storage.session.set.getMockImplementation()!;
    chrome.storage.session.set.mockImplementation(async (value: Record<string, unknown>) => {
      if (Object.keys(value).length === 1 && "xLastDetectedContent" in value) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await writeStored(value);
    });
    chrome.tabs.get.mockResolvedValueOnce({ id: 8, url: "https://x.com/owner/status/2075545587093807333" });
    chrome.events.tabActivated.listeners[0]({ tabId: 8 });
    await flushMicrotasks();

    await dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0,
    }, contentSender());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chrome.getStored()).toEqual(expect.objectContaining({
      xLastDetectedContent: expect.objectContaining({
        "7": { contentRef, canonicalStatusId: contentRef.sourceContentId },
      }),
    }));
  });

  it("deletes the persisted bare-status ref when the tab closes", async () => {
    const bareUrl = "https://x.com/owner/status/2075545587093807111";
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0,
    }, contentSender(7, bareUrl));

    const removed = chrome.events.tabRemoved.listeners[0](7);
    if (removed instanceof Promise) await removed;

    expect(chrome.getStored()).toEqual(expect.objectContaining({ xLastDetectedContent: {} }));
  });

  it("deduplicates, caps candidates at 50, and isolates tab/content keys", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await dispatchMessage(chrome, { type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0 }, contentSender());
    const duplicate = "https://video.twimg.com/path/file-0.mp4";
    await capture(chrome, duplicate);
    await capture(chrome, duplicate, { timeStamp: Date.now() + 2 });
    for (let index = 1; index <= 55; index += 1) {
      await capture(chrome, `https://video.twimg.com/path/file-${index}.mp4`, {
        timeStamp: Date.now() + index,
      });
    }

    const response = await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef,
    }, contentSender()) as { candidates: Array<{ url: string }> };
    expect(response.candidates).toHaveLength(50);
    expect(new Set(response.candidates.map(({ url }) => url)).size).toBe(50);

    expect(await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 8, contentRef,
    }, contentSender(8))).toEqual({ candidates: [] });
    vi.useRealTimers();
  });

  it("keeps captured candidates after the player becomes inactive", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await dispatchMessage(chrome, { type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0 }, contentSender());
    await capture(chrome, "https://video.twimg.com/path/file.mp4");
    vi.advanceTimersByTime(2_000);
    await dispatchMessage(chrome, { type: "X_PLAYER_INACTIVE", contentRef }, contentSender());
    await capture(chrome, "https://video.twimg.com/path/after-pause.mp4");
    expect(await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef,
    }, contentSender())).toEqual({ candidates: [expect.objectContaining({
      url: "https://video.twimg.com/path/file.mp4",
    })] });
    vi.useRealTimers();
  });

  it("purges cached candidates after 10 minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await dispatchMessage(chrome, { type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0 }, contentSender());
    await capture(chrome, "https://video.twimg.com/path/next.mp4");
    vi.advanceTimersByTime(10 * 60_000 + 1);
    expect(await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef,
    }, contentSender())).toEqual({ candidates: [] });
    vi.useRealTimers();
  });

  it("removes expired inactive caches when the persistent cleanup alarm fires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await dispatchMessage(chrome, { type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0 }, contentSender());
    await capture(chrome, "https://video.twimg.com/path/expiring.mp4");
    await dispatchMessage(chrome, { type: "X_PLAYER_INACTIVE", contentRef }, contentSender());
    expect(chrome.alarms.create).toHaveBeenCalled();
    const alarmName = chrome.alarms.create.mock.calls.at(-1)?.[0];

    vi.advanceTimersByTime(10 * 60_000 + 1);
    chrome.events.alarm.listeners[0]({ name: alarmName });
    await flushMicrotasks();

    expect(chrome.getStored()).toEqual(expect.objectContaining({ xMediaCapture: {} }));
    vi.useRealTimers();
  });

  it("clears an expired active marker even when it has no candidates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0,
    }, contentSender());
    const alarmName = chrome.alarms.create.mock.calls.at(-1)?.[0];

    vi.advanceTimersByTime(15_001);
    chrome.events.alarm.listeners[0]({ name: alarmName });
    await flushMicrotasks();

    expect(chrome.getStored()).toEqual(expect.objectContaining({ xMediaCapture: {} }));
    vi.useRealTimers();
  });

  it("reschedules cleanup from active expiry to candidate expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0,
    }, contentSender());
    await capture(chrome, "https://video.twimg.com/path/lifecycle.mp4");
    await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef,
    }, contentSender());
    const firstWhen = chrome.alarms.create.mock.calls.at(-1)?.[1]?.when;

    vi.advanceTimersByTime(15_001);
    chrome.events.alarm.listeners[0]({ name: "xMediaCandidateCleanup" });
    await flushMicrotasks();
    const secondWhen = chrome.alarms.create.mock.calls.at(-1)?.[1]?.when;

    expect(firstWhen).toBe(new Date("2026-09-05T00:00:00Z").getTime() + 15_000);
    expect(secondWhen).toBe(new Date("2026-09-05T00:00:00Z").getTime() + 10 * 60_000);
    expect(chrome.getStored().xMediaCapture).toEqual(expect.objectContaining({
      "7": expect.objectContaining({ active: null }),
    }));
    vi.useRealTimers();
  });

  it("caps cached candidates across content keys and evicts the oldest deterministically", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    for (let mediaIndex = 1; mediaIndex <= 5; mediaIndex += 1) {
      const ref = { ...contentRef, mediaIndex };
      const url = `https://x.com/owner/status/${contentRef.sourceContentId}/video/${mediaIndex}`;
      await dispatchMessage(chrome, {
        type: "X_PLAYER_ACTIVE", contentRef: ref, durationMs: 0,
      }, contentSender(7, url));
      for (let index = 0; index < 50; index += 1) {
        vi.advanceTimersByTime(1);
        await capture(chrome, `https://video.twimg.com/path/${mediaIndex}-${index}.mp4`);
      }
    }
    const lastRef = { ...contentRef, mediaIndex: 5 };
    const lastUrl = `https://x.com/owner/status/${contentRef.sourceContentId}/video/5`;
    await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef: lastRef,
    }, contentSender(7, lastUrl));

    const captureState = chrome.getStored().xMediaCapture as Record<
      string,
      { candidates: Record<string, Array<{ url: string }>> }
    >;
    const urls = Object.values(captureState["7"].candidates).flat().map(({ url }) => url);
    expect(urls.length).toBeLessThanOrEqual(200);
    expect(urls).not.toContain("https://video.twimg.com/path/1-0.mp4");
    expect(captureState["7"].candidates[`x:${contentRef.sourceContentId}:5`]).toEqual(
      expect.arrayContaining([expect.objectContaining({
        url: "https://video.twimg.com/path/5-49.mp4",
      })]),
    );
    vi.useRealTimers();
  });

  it("caps aggregate candidate URL bytes", async () => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0,
    }, contentSender());
    for (let index = 0; index < 10; index += 1) {
      await capture(chrome, `https://video.twimg.com/path/${index}.mp4?token=${"x".repeat(20_000)}`);
    }
    await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef,
    }, contentSender());

    const captureState = chrome.getStored().xMediaCapture as Record<
      string,
      { candidates: Record<string, Array<{ url: string }>> }
    >;
    const urls = Object.values(captureState["7"].candidates).flat().map(({ url }) => url);
    expect(urls.reduce((total, url) => total + url.length * 2, 0)).toBeLessThanOrEqual(128_000);
  });

  it("applies the aggregate candidate cap across tabs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const candidate = (tabId: number, index: number) => ({
      url: `https://video.twimg.com/path/${tabId}-${index}.mp4`,
      kind: "mp4" as const,
      capturedAt: 1_000 + tabId * 1_000 + index,
    });
    const chrome = createChrome({
      xMediaCapture: {
        "7": { active: null, candidates: { "x:2075545587093807111:1": Array.from(
          { length: 120 }, (_, index) => candidate(7, index),
        ) } },
        "8": { active: null, candidates: { "x:2075545587093807222:1": Array.from(
          { length: 120 }, (_, index) => candidate(8, index),
        ) } },
      },
    });
    installBackgroundHandlers(chrome as never);
    await flushMicrotasks();

    const captureState = chrome.getStored().xMediaCapture as Record<
      string,
      { candidates: Record<string, Array<{ url: string }>> }
    >;
    const urls = Object.values(captureState).flatMap((tabState) => (
      Object.values(tabState.candidates).flat().map(({ url }) => url)
    ));
    expect(urls.length).toBeLessThanOrEqual(200);
    expect(urls).not.toContain("https://video.twimg.com/path/7-0.mp4");
    expect(urls).toContain("https://video.twimg.com/path/8-119.mp4");
    vi.useRealTimers();
  });

  it("removes an inactive tab emptied by aggregate eviction and reschedules cleanup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const candidate = (tabId: number, capturedAt: number) => ({
      url: `https://video.twimg.com/path/${tabId}.mp4?token=${"x".repeat(40_000)}`,
      kind: "mp4" as const,
      capturedAt,
    });
    const chrome = createChrome({
      xMediaCapture: {
        "7": { active: null, candidates: { "x:2075545587093807111:1": [candidate(7, 1_000)] } },
        "8": { active: null, candidates: { "x:2075545587093807222:1": [candidate(8, 2_000)] } },
      },
    });

    installBackgroundHandlers(chrome as never);
    await flushMicrotasks();

    expect(chrome.getStored().xMediaCapture).toEqual({
      "8": expect.objectContaining({
        active: null,
        candidates: expect.any(Object),
      }),
    });
    expect(chrome.alarms.create).toHaveBeenLastCalledWith(
      "xMediaCandidateCleanup",
      { when: 2_000 + 10 * 60_000 },
    );
    vi.useRealTimers();
  });

  it("restores no more than 50 candidates for one content key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const candidates = Array.from({ length: 80 }, (_, index) => ({
      url: `https://video.twimg.com/path/restored-${index}.mp4`,
      kind: "mp4" as const,
      capturedAt: 1_000 + index,
    }));
    const chrome = createChrome({
      xMediaCapture: {
        "7": { active: null, candidates: { [contentKey(contentRef)]: candidates } },
      },
    });
    installBackgroundHandlers(chrome as never);
    await flushMicrotasks();

    const captureState = chrome.getStored().xMediaCapture as Record<
      string,
      { candidates: Record<string, Array<{ url: string }>> }
    >;
    expect(captureState["7"].candidates[contentKey(contentRef)]).toHaveLength(50);
    expect(captureState["7"].candidates[contentKey(contentRef)][0].url)
      .toBe("https://video.twimg.com/path/restored-79.mp4");
    vi.useRealTimers();
  });

  it("keeps candidates for two media refs in the same tab", async () => {
    const mediaTwo = { ...contentRef, mediaIndex: 2 };
    const mediaTwoUrl = "https://x.com/owner/status/2075545587093807111/video/2";
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await dispatchMessage(chrome, { type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0 }, contentSender());
    await capture(chrome, "https://video.twimg.com/path/media-one.mp4");
    await dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE", contentRef: mediaTwo, durationMs: 0,
    }, contentSender(7, mediaTwoUrl));
    await capture(chrome, "https://video.twimg.com/path/media-two.mp4");

    expect(await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef,
    }, contentSender())).toEqual({ candidates: [expect.objectContaining({
      url: "https://video.twimg.com/path/media-one.mp4",
    })] });
    expect(await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef: mediaTwo,
    }, contentSender(7, mediaTwoUrl))).toEqual({ candidates: [expect.objectContaining({
      url: "https://video.twimg.com/path/media-two.mp4",
    })] });
  });

  it("closes the capture window on an X SPA route change without deleting candidates", async () => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await dispatchMessage(chrome, { type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0 }, contentSender());
    await capture(chrome, "https://video.twimg.com/path/file.mp4");
    const nextUrl = "https://x.com/owner/status/2075545587093807222/video/1";

    chrome.events.tabUpdated.listeners[0](7, { url: nextUrl }, { id: 7, url: nextUrl });
    await flushMicrotasks();
    await capture(chrome, "https://video.twimg.com/path/after-route.mp4");

    expect(await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef,
    }, contentSender())).toEqual({ candidates: [expect.objectContaining({
      url: "https://video.twimg.com/path/file.mp4",
    })] });
  });

  it("keeps a new capture window when its player signal beats the route update", async () => {
    const priorUrl = "https://x.com/owner/status/2075545587093807111/video/1";
    const nextRef = { ...contentRef, sourceContentId: "2075545587093807222" };
    const nextUrl = "https://x.com/owner/status/2075545587093807222/video/1";
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await dispatchMessage(chrome, {
      type: "X_PLAYER_ACTIVE", contentRef: nextRef, durationMs: 0,
    }, { url: nextUrl, tab: { id: 7, url: priorUrl } });

    chrome.events.tabUpdated.listeners[0](7, { url: nextUrl }, { id: 7, url: nextUrl });
    await flushMicrotasks();
    await capture(chrome, "https://video.twimg.com/path/new-route.mp4");

    expect(await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef: nextRef,
    }, contentSender(7, nextUrl))).toEqual({ candidates: [expect.objectContaining({
      url: "https://video.twimg.com/path/new-route.mp4",
    })] });
  });

  it("deletes cached candidates when the tab closes", async () => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await dispatchMessage(chrome, { type: "X_PLAYER_ACTIVE", contentRef, durationMs: 0 }, contentSender());
    await capture(chrome, "https://video.twimg.com/path/file.mp4");

    chrome.events.tabRemoved.listeners[0](7);
    await flushMicrotasks();

    expect(await dispatchMessage(chrome, {
      type: "GET_MEDIA_CANDIDATES", tabId: 7, contentRef,
    }, contentSender())).toEqual({ candidates: [] });
  });
});
