import type { ActiveTabContext, AnalyzedTab, ExtensionMessage } from "./shared/types";
import { contentKey, parseContentRef } from "./shared/content";

const STORAGE_KEY = "analyzedTabs";
type AnalyzedTabs = Record<string, Record<string, AnalyzedTab>>;

type ChromeApi = Pick<
  typeof chrome,
  "action" | "runtime" | "sidePanel" | "scripting" | "storage" | "tabs"
>;

export function parseVideoId(url?: string): string | null {
  const ref = parseContentRef(url);
  return ref?.platform === "youtube" ? ref.sourceContentId : null;
}

export function installBackgroundHandlers(chromeApi: ChromeApi): void {
  void chromeApi.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch(reportBackgroundError);
  void configureActiveTab(chromeApi).catch(reportBackgroundError);

  chromeApi.action.onClicked.addListener((tab) => {
    const tabId = tab.id;
    if (tabId === undefined || !parseContentRef(tab.url)) return;
    void chromeApi.sidePanel
      .setOptions({ tabId, path: "sidepanel.html", enabled: true })
      .catch(reportBackgroundError);
    void chromeApi.sidePanel.open({ tabId }).catch(reportBackgroundError);
  });

  chromeApi.tabs.onActivated.addListener(({ tabId }) => {
    void updatePanelForActivatedTab(chromeApi, tabId).catch(reportBackgroundError);
  });

  chromeApi.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!changeInfo.url) return;
    void updatePanelForTab(chromeApi, tabId, tab.url).catch(reportBackgroundError);
  });

  chromeApi.tabs.onRemoved.addListener((tabId) => {
    void removeTabState(chromeApi, tabId).catch(reportBackgroundError);
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

function reportBackgroundError(_error: unknown): void {
  console.warn("Veeky background event failed");
}

async function updatePanelForActivatedTab(chromeApi: ChromeApi, tabId: number): Promise<void> {
  const tab = await chromeApi.tabs.get(tabId);
  await updatePanelForTab(chromeApi, tabId, tab.url);
}

async function removeTabState(chromeApi: ChromeApi, tabId: number): Promise<void> {
  const analyzedTabs = await loadAnalyzedTabs(chromeApi);
  delete analyzedTabs[String(tabId)];
  await chromeApi.storage.session.set({ [STORAGE_KEY]: analyzedTabs });
}

async function handleMessage(chromeApi: ChromeApi, message: ExtensionMessage): Promise<unknown> {
  if (message.type === "REGISTER_ANALYSIS") {
    const analyzedTabs = await loadAnalyzedTabs(chromeApi);
    const ref = "contentRef" in message
      ? message.contentRef
      : { platform: "youtube" as const, sourceContentId: message.videoId, mediaIndex: 1 };
    const tabKey = String(message.tabId);
    analyzedTabs[tabKey] ??= {};
    analyzedTabs[tabKey][contentKey(ref)] = {
      tabId: message.tabId,
      contentRef: ref,
      jobId: message.jobId,
      ...(ref.platform === "youtube" ? { videoId: ref.sourceContentId } : {}),
    };
    await chromeApi.storage.session.set({ [STORAGE_KEY]: analyzedTabs });
    const tab = await chromeApi.tabs.get(message.tabId);
    await updatePanelForTab(chromeApi, message.tabId, tab.url);
    return { ok: true };
  }

  if (message.type === "SEEK_VIDEO") {
    const tab = await chromeApi.tabs.get(message.tabId);
    const seconds = Math.max(0, message.startMs / 1000);
    const ref = parseContentRef(tab.url);
    if (ref?.platform === "youtube" && ref.sourceContentId === message.videoId) {
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
  const contentRef = parseContentRef(tab.url);
  const context: ActiveTabContext = {
    tabId: tab.id,
    url: tab.url ?? "",
    title: tab.title ?? "YouTube video",
    contentRef,
    videoId: contentRef?.platform === "youtube" ? contentRef.sourceContentId : null,
    analysis: contentRef
      ? analyzedTabs[String(tab.id)]?.[contentKey(contentRef)] ?? null
      : null,
  };
  return context;
}

function seekCurrentYouTubePlayer(seconds: number): void {
  const video = document.querySelector<HTMLVideoElement>("video.html5-main-video, video");
  if (!video) throw new Error("YouTube player is not ready");
  video.currentTime = seconds;
  void video.play().catch(() => undefined);
}

async function loadAnalyzedTabs(chromeApi: ChromeApi): Promise<AnalyzedTabs> {
  const value = await chromeApi.storage.session.get(STORAGE_KEY);
  return (value[STORAGE_KEY] as AnalyzedTabs | undefined) ?? {};
}

async function updatePanelForTab(
  chromeApi: ChromeApi,
  tabId: number,
  url?: string,
): Promise<void> {
  const isSupportedVideo = parseContentRef(url) !== null;
  await chromeApi.sidePanel.setOptions(
    isSupportedVideo
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

if (typeof chrome !== "undefined" && chrome.runtime?.id) {
  installBackgroundHandlers(chrome);
}
