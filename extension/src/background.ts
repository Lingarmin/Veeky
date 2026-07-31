import type { ActiveTabContext, AnalyzedTab, ExtensionMessage } from "./shared/types";

const STORAGE_KEY = "analyzedTabs";

type ChromeApi = Pick<typeof chrome, "action" | "runtime" | "sidePanel" | "storage" | "tabs">;

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

  chromeApi.action.onClicked.addListener(async (tab) => {
    const tabId = tab.id;
    if (tabId === undefined || !parseVideoId(tab.url)) return;
    await chromeApi.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: true });
    await chromeApi.sidePanel.open({ tabId });
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
    const seconds = Math.max(0, Math.floor(message.startMs / 1000));
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

async function loadAnalyzedTabs(chromeApi: ChromeApi): Promise<Record<string, AnalyzedTab>> {
  const value = await chromeApi.storage.session.get(STORAGE_KEY);
  return (value[STORAGE_KEY] as Record<string, AnalyzedTab> | undefined) ?? {};
}

async function updatePanelForTab(
  chromeApi: ChromeApi,
  tabId: number,
  url?: string,
): Promise<void> {
  const analyzedTabs = await loadAnalyzedTabs(chromeApi);
  const analysis = analyzedTabs[String(tabId)];
  const isAnalyzedVideo = analysis?.videoId === parseVideoId(url);
  await chromeApi.sidePanel.setOptions(
    isAnalyzedVideo
      ? { tabId, path: "sidepanel.html", enabled: true }
      : { tabId, enabled: false },
  );
}

function validId(candidate: string | null | undefined): string | null {
  return candidate && /^[A-Za-z0-9_-]{11}$/.test(candidate) ? candidate : null;
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) {
  installBackgroundHandlers(chrome);
}
