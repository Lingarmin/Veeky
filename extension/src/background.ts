import type { ActiveTabContext, AnalyzedTab, ExtensionMessage } from "./shared/types";

const STORAGE_KEY = "analyzedTabs";

type ChromeApi = Pick<
  typeof chrome,
  "action" | "runtime" | "sidePanel" | "scripting" | "storage" | "tabs"
>;

export function parseVideoId(url?: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "youtu.be" || parsed.hostname === "www.youtu.be") {
      return validId(parsed.pathname.split("/").filter(Boolean)[0]);
    }
    if (parsed.hostname === "youtube.com" || parsed.hostname.endsWith(".youtube.com")) {
      if (parsed.pathname === "/watch") return validId(parsed.searchParams.get("v"));
      if (parsed.pathname.startsWith("/shorts/")) return validId(parsed.pathname.split("/")[2]);
    }
  } catch {
    return null;
  }
  return null;
}

export function installBackgroundHandlers(chromeApi: ChromeApi): void {
  chromeApi.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
  void configureActiveTab(chromeApi).catch(() => undefined);

  chromeApi.action.onClicked.addListener((tab) => {
    const tabId = tab.id;
    if (tabId === undefined || !parseVideoId(tab.url)) return;
    void chromeApi.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: true }).catch(() => undefined);
    void chromeApi.sidePanel.open({ tabId }).catch(() => undefined);
  });

  chromeApi.tabs.onActivated.addListener(async ({ tabId }) => {
    const tab = await chromeApi.tabs.get(tabId);
    await updatePanelForTab(chromeApi, tabId, tab.url);
  });

  chromeApi.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (!changeInfo.url) return;
    await updatePanelForTab(chromeApi, tabId, tab.url);
  });

  chromeApi.tabs.onRemoved.addListener(async (tabId) => {
    const analyzedTabs = await loadAnalyzedTabs(chromeApi);
    delete analyzedTabs[String(tabId)];
    await chromeApi.storage.session.set({ [STORAGE_KEY]: analyzedTabs });
  });

  chromeApi.runtime.onMessage.addListener(
    (message: ExtensionMessage, _sender, sendResponse) => {
      handleMessage(chromeApi, message).then(sendResponse).catch((error) => {
        sendResponse({ error: error instanceof Error ? error.message : "Extension error" });
      });
      return true;
    },
  );
}

async function handleMessage(chromeApi: ChromeApi, message: ExtensionMessage): Promise<unknown> {
  if (message.type === "REGISTER_ANALYSIS") {
    const analyzedTabs = await loadAnalyzedTabs(chromeApi);
    analyzedTabs[String(message.tabId)] = {
      tabId: message.tabId,
      videoId: message.videoId,
      jobId: message.jobId,
    };
    await chromeApi.storage.session.set({ [STORAGE_KEY]: analyzedTabs });
    const tab = await chromeApi.tabs.get(message.tabId);
    await updatePanelForTab(chromeApi, message.tabId, tab.url);
    return { ok: true };
  }

  if (message.type === "SEEK_VIDEO") {
    const tab = await chromeApi.tabs.get(message.tabId);
    const seconds = Math.max(0, message.startMs / 1000);
    if (parseVideoId(tab.url) === message.videoId) {
      await chromeApi.scripting.executeScript({
        target: { tabId: message.tabId },
        func: seekCurrentYouTubePlayer,
        args: [seconds],
      });
      return { ok: true };
    }
    await chromeApi.tabs.update(message.tabId, {
      url: `https://www.youtube.com/watch?v=${message.videoId}&t=${seconds}s`,
    });
    return { ok: true };
  }

  const tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (tab?.id === undefined) throw new Error("No active browser tab");
  const analyzedTabs = await loadAnalyzedTabs(chromeApi);
  const context: ActiveTabContext = {
    tabId: tab.id,
    url: tab.url ?? "",
    title: tab.title ?? "YouTube video",
    videoId: parseVideoId(tab.url),
    analysis: analyzedTabs[String(tab.id)] ?? null,
  };
  return context;
}

function seekCurrentYouTubePlayer(seconds: number): void {
  const video = document.querySelector<HTMLVideoElement>("video.html5-main-video, video");
  if (!video) throw new Error("YouTube player is not ready");
  video.currentTime = seconds;
  void video.play().catch(() => undefined);
}

async function loadAnalyzedTabs(chromeApi: ChromeApi): Promise<Record<string, AnalyzedTab>> {
  const value = await chromeApi.storage.session.get(STORAGE_KEY);
  return (value[STORAGE_KEY] as Record<string, AnalyzedTab> | undefined) ?? {};
}

async function updatePanelForTab(
  chromeApi: ChromeApi,
  tabId: number,
  url?: string,
): Promise<void> {
  const isYouTubeVideo = parseVideoId(url) !== null;
  await chromeApi.sidePanel.setOptions(
    isYouTubeVideo
      ? { tabId, path: "sidepanel.html", enabled: true }
      : { tabId, enabled: false },
  );
}

async function configureActiveTab(chromeApi: ChromeApi): Promise<void> {
  const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) {
    await updatePanelForTab(chromeApi, tab.id, tab.url);
  }
}

function validId(candidate: string | null | undefined): string | null {
  return candidate && /^[A-Za-z0-9_-]{11}$/.test(candidate) ? candidate : null;
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) {
  installBackgroundHandlers(chrome);
}
