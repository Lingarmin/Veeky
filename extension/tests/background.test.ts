import { describe, expect, it, vi } from "vitest";

import manifest from "../manifest.json";
import { installBackgroundHandlers, parseVideoId } from "../src/background";

class FakeEvent {
  listeners: Array<(...args: any[]) => any> = [];
  registrations: any[][] = [];
  addListener = (...args: any[]) => {
    this.listeners.push(args[0]);
    this.registrations.push(args);
  };
}

function createChrome() {
  const actionClicked = new FakeEvent();
  const tabActivated = new FakeEvent();
  const tabUpdated = new FakeEvent();
  const tabRemoved = new FakeEvent();
  const message = new FakeEvent();
  const beforeRequest = new FakeEvent();
  const alarm = new FakeEvent();
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
    alarms: {
      onAlarm: alarm,
      create: vi.fn(),
      clear: vi.fn(async () => true),
    },
    webRequest: { onBeforeRequest: beforeRequest },
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
    events: { actionClicked, tabActivated, tabUpdated, tabRemoved, message, beforeRequest, alarm },
    getStored: () => stored,
  };
}

function dispatchMessage(chrome: ReturnType<typeof createChrome>, message: object, sender: object = {}) {
  return new Promise((resolve) => {
    chrome.events.message.listeners[0](message, sender, resolve);
  });
}

async function flushMicrotasks() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
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
    expect(manifest.permissions).toEqual(expect.arrayContaining(["webRequest", "offscreen", "alarms"]));
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

  it("keeps the panel disabled on X pages without an explicit video route", async () => {
    const chrome = createChrome();
    installBackgroundHandlers(chrome as never);
    await flushMicrotasks();

    const url = "https://x.com/viktoroddy/status/2075545587093807111";
    chrome.events.tabUpdated.listeners[0](7, { url }, { id: 7, url });
    await flushMicrotasks();
    expect(chrome.sidePanel.setOptions).toHaveBeenLastCalledWith({ tabId: 7, enabled: false });

    chrome.events.actionClicked.listeners[0]({ id: 7, url });
    expect(chrome.sidePanel.open).not.toHaveBeenCalled();
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
