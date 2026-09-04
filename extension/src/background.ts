import type {
  ActiveTabContext,
  AnalyzedTab,
  ContentRef,
  ExtensionMessage,
  MediaCandidate,
} from "./shared/types";
import { contentKey, parseContentRef } from "./shared/content";

const STORAGE_KEY = "analyzedTabs";
const MEDIA_STORAGE_KEY = "xMediaCapture";
const LAST_DETECTED_STORAGE_KEY = "xLastDetectedContent";
const MEDIA_CLEANUP_ALARM = "xMediaCandidateCleanup";
const CAPTURE_WINDOW_MS = 15_000;
const CANDIDATE_TTL_MS = 10 * 60_000;
const MAX_CANDIDATES = 50;
const X_STATUS_PATH = /^\/[^/]+\/status\/([0-9]+)(?:\/video\/([1-9][0-9]*))?\/?$/;
type AnalyzedTabs = Record<string, Record<string, AnalyzedTab>>;

interface CaptureTabState {
  active: { contentRef: ContentRef; expiresAt: number } | null;
  candidates: Record<string, MediaCandidate[]>;
}

type MediaCaptureState = Record<string, CaptureTabState>;

interface LastDetectedContent {
  contentRef: ContentRef;
  canonicalStatusId: string;
}

type LastDetectedContentState = Record<string, LastDetectedContent>;

interface BackgroundState {
  lastDetectedContentByTab: Map<number, ContentRef>;
  runCaptureTask: <T>(task: () => Promise<T>) => Promise<T>;
}

type ChromeApi = Pick<
  typeof chrome,
  "action" | "alarms" | "runtime" | "sidePanel" | "scripting" | "storage" | "tabs" | "webRequest"
>;

export function parseVideoId(url?: string): string | null {
  const ref = parseContentRef(url);
  return ref?.platform === "youtube" ? ref.sourceContentId : null;
}

export function installBackgroundHandlers(chromeApi: ChromeApi): void {
  const lastDetectedContentByTab = new Map<number, ContentRef>();
  let captureQueue: Promise<void> = Promise.resolve();
  const runCaptureTask = <T>(task: () => Promise<T>): Promise<T> => {
    const result = captureQueue.then(task);
    captureQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  const state: BackgroundState = {
    lastDetectedContentByTab,
    runCaptureTask,
  };
  void chromeApi.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(reportBackgroundError);
  void runCaptureTask(async () => {
    await initializeMediaCapture(chromeApi);
    await configureActiveTab(chromeApi, lastDetectedContentByTab);
  }).catch(reportBackgroundError);

  chromeApi.action.onClicked.addListener((tab) => {
    const tabId = tab.id;
    if (tabId === undefined) return;
    const explicitRef = parseContentRef(tab.url);
    const rememberedRef = lastDetectedContentByTab.get(tabId);
    if (explicitRef || activeContentMatchesUrl(rememberedRef, tab.url)) {
      openPanelForTab(chromeApi, tabId);
      return;
    }
    void runCaptureTask(() => resolveLastDetectedContent(chromeApi, tabId, tab.url))
      .then((restoredRef) => {
        if (!restoredRef) return;
        lastDetectedContentByTab.set(tabId, restoredRef);
        return chromeApi.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: true });
      })
      .catch(reportBackgroundError);
  });

  chromeApi.tabs.onActivated.addListener(({ tabId }) => {
    void runCaptureTask(() => updatePanelForActivatedTab(
      chromeApi,
      tabId,
      lastDetectedContentByTab,
    ))
      .catch(reportBackgroundError);
  });

  chromeApi.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!changeInfo.url) return;
    const explicitRef = parseContentRef(tab.url);
    const rememberedRef = lastDetectedContentByTab.get(tabId);
    const rememberedRefStillMatches = activeContentMatchesUrl(rememberedRef, tab.url);
    if (!rememberedRefStillMatches) lastDetectedContentByTab.delete(tabId);
    void chromeApi.sidePanel.setOptions(
      explicitRef || rememberedRefStillMatches
        ? { tabId, path: "sidepanel.html", enabled: true }
        : { tabId, enabled: false },
    ).catch(reportBackgroundError);
    const cleared = runCaptureTask(async () => {
      await closeCaptureForTab(chromeApi, tabId, tab.url);
      const restoredRef = await resolveLastDetectedContent(chromeApi, tabId, tab.url);
      if (restoredRef) lastDetectedContentByTab.set(tabId, restoredRef);
      return restoredRef;
    });
    if (!explicitRef && !rememberedRefStillMatches) {
      void cleared.then((restoredRef) => {
        if (restoredRef) {
          return chromeApi.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: true });
        }
      }).catch(reportBackgroundError);
    } else {
      void cleared.catch(reportBackgroundError);
    }
  });

  chromeApi.tabs.onRemoved.addListener((tabId) => {
    lastDetectedContentByTab.delete(tabId);
    return runCaptureTask(() => removeAllTabState(chromeApi, tabId))
      .catch(reportBackgroundError);
  });

  chromeApi.webRequest.onBeforeRequest.addListener(
    (details) => {
      void runCaptureTask(() => captureMediaCandidate(chromeApi, details)).catch(reportBackgroundError);
    },
    { urls: ["https://video.twimg.com/*"], types: ["media", "xmlhttprequest"] },
  );

  chromeApi.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== MEDIA_CLEANUP_ALARM) return;
    void runCaptureTask(() => cleanupExpiredMedia(chromeApi)).catch(reportBackgroundError);
  });

  chromeApi.runtime.onMessage.addListener(
    (message: ExtensionMessage, sender, sendResponse) => {
      handleMessage(chromeApi, message, sender, state).then(sendResponse).catch((error) => {
        sendResponse({ error: error instanceof Error ? error.message : "Extension error" });
      });
      return true;
    },
  );
}

function reportBackgroundError(_error: unknown): void {
  console.warn("Veeky background event failed");
}

async function updatePanelForActivatedTab(
  chromeApi: ChromeApi,
  tabId: number,
  lastDetectedContentByTab: Map<number, ContentRef>,
): Promise<void> {
  const tab = await chromeApi.tabs.get(tabId);
  const rememberedRef = await updatePanelForTab(chromeApi, tabId, tab.url);
  if (rememberedRef) lastDetectedContentByTab.set(tabId, rememberedRef);
  else if (!activeContentMatchesUrl(lastDetectedContentByTab.get(tabId), tab.url)) {
    lastDetectedContentByTab.delete(tabId);
  }
}

async function handleMessage(
  chromeApi: ChromeApi,
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
  state: BackgroundState,
): Promise<unknown> {
  if (message.type === "X_PLAYER_ACTIVE") {
    const tabId = sender.tab?.id;
    if (tabId === undefined || !isValidXContentRef(message.contentRef) || !senderMatchesRef(sender, message.contentRef)) {
      return { ok: false };
    }
    const signalAt = Date.now();
    return state.runCaptureTask(async () => {
      const mediaState = await loadMediaCaptureState(chromeApi);
      const tabKey = String(tabId);
      const prior = mediaState[tabKey];
      const samePlayer = Boolean(
        prior?.active && sameContentRef(prior.active.contentRef, message.contentRef),
      );
      mediaState[tabKey] = {
        active: {
          contentRef: message.contentRef,
          expiresAt: samePlayer ? prior.active!.expiresAt : signalAt + CAPTURE_WINDOW_MS,
        },
        candidates: pruneCandidateMap(prior?.candidates ?? {}, Date.now()),
      };
      const lastDetectedState = await loadLastDetectedContentState(chromeApi);
      lastDetectedState[tabKey] = {
        contentRef: message.contentRef,
        canonicalStatusId: message.contentRef.sourceContentId,
      };
      state.lastDetectedContentByTab.set(tabId, message.contentRef);
      await chromeApi.storage.session.set({
        [MEDIA_STORAGE_KEY]: mediaState,
        [LAST_DETECTED_STORAGE_KEY]: lastDetectedState,
      });
      await scheduleMediaCleanupForState(chromeApi, mediaState);
      await chromeApi.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: true });
      return { ok: true };
    });
  }

  if (message.type === "X_PLAYER_INACTIVE") {
    const tabId = sender.tab?.id;
    if (tabId === undefined || !isValidXContentRef(message.contentRef) || !senderIsXPage(sender)) {
      return { ok: false };
    }
    return state.runCaptureTask(async () => {
      const mediaState = await loadMediaCaptureState(chromeApi);
      const tabState = mediaState[String(tabId)];
      if (tabState?.active && sameContentRef(tabState.active.contentRef, message.contentRef)) {
        tabState.active = null;
        tabState.candidates = pruneCandidateMap(tabState.candidates, Date.now());
        await chromeApi.storage.session.set({ [MEDIA_STORAGE_KEY]: mediaState });
        await scheduleMediaCleanupForState(chromeApi, mediaState);
        await updatePanelForTab(chromeApi, tabId, sender.url ?? sender.tab?.url);
      }
      return { ok: true };
    });
  }

  if (message.type === "GET_MEDIA_CANDIDATES") {
    const allowed = await canReadMediaCandidates(chromeApi, sender, message.tabId, message.contentRef);
    if (!allowed) return { candidates: [] };
    return state.runCaptureTask(async () => {
      const mediaState = await loadMediaCaptureState(chromeApi);
      const now = Date.now();
      const tabState = mediaState[String(message.tabId)];
      const key = contentKey(message.contentRef);
      if (!tabState) return { candidates: [] };
      const candidates = pruneCandidates(tabState.candidates[key] ?? [], now);

      if (candidates.length !== (tabState.candidates[key]?.length ?? 0)) {
        if (candidates.length) tabState.candidates[key] = candidates;
        else delete tabState.candidates[key];
        if (!tabState.active && Object.keys(tabState.candidates).length === 0) {
          delete mediaState[String(message.tabId)];
        }
        await chromeApi.storage.session.set({ [MEDIA_STORAGE_KEY]: mediaState });
        await scheduleMediaCleanupForState(chromeApi, mediaState);
      }
      return { candidates: sortCandidates(candidates) };
    });
  }

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
    await state.runCaptureTask(() => updatePanelForTab(chromeApi, message.tabId, tab.url));
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
  const tabId = tab.id;
  const analyzedTabs = await loadAnalyzedTabs(chromeApi);
  const explicitRef = parseContentRef(tab.url);
  const rememberedRef = await state.runCaptureTask(
    () => resolveLastDetectedContent(chromeApi, tabId, tab.url),
  );
  if (rememberedRef) state.lastDetectedContentByTab.set(tabId, rememberedRef);
  else state.lastDetectedContentByTab.delete(tabId);
  const contentRef = explicitRef ?? rememberedRef;
  const context: ActiveTabContext = {
    tabId,
    url: tab.url ?? "",
    title: tab.title ?? "YouTube video",
    contentRef,
    videoId: contentRef?.platform === "youtube" ? contentRef.sourceContentId : null,
    analysis: contentRef
      ? analyzedTabs[String(tabId)]?.[contentKey(contentRef)] ?? null
      : null,
  };
  return context;
}

async function captureMediaCandidate(
  chromeApi: ChromeApi,
  details: chrome.webRequest.WebRequestBodyDetails,
): Promise<void> {
  if (details.tabId < 0 || (details.type !== "media" && details.type !== "xmlhttprequest")) return;
  const candidate = mediaCandidateFromRequest(details.url, details.timeStamp);
  if (!candidate) return;

  const state = await loadMediaCaptureState(chromeApi);
  const tabState = state[String(details.tabId)];
  const now = Date.now();
  if (!tabState?.active) return;
  const windowOpenedAt = tabState.active.expiresAt - CAPTURE_WINDOW_MS;
  if (candidate.capturedAt < windowOpenedAt || candidate.capturedAt > tabState.active.expiresAt) return;
  const key = contentKey(tabState.active.contentRef);
  const current = pruneCandidates(tabState.candidates[key] ?? [], now)
    .filter(({ url }) => url !== candidate.url);
  current.push(candidate);
  tabState.candidates[key] = sortCandidates(current).slice(0, MAX_CANDIDATES);
  await chromeApi.storage.session.set({ [MEDIA_STORAGE_KEY]: state });
  await scheduleMediaCleanupForState(chromeApi, state);
}

function mediaCandidateFromRequest(urlValue: string, capturedAt: number): MediaCandidate | null {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== "video.twimg.com"
    || url.port
    || url.username
    || url.password
    || url.hash
  ) {
    return null;
  }
  const path = url.pathname.toLowerCase();
  let kind: MediaCandidate["kind"];
  if (path.endsWith(".mp4")) kind = "mp4";
  else if (path.endsWith(".m3u8")) kind = "hls";
  else if (/\.(?:ts|m4s|cmfv|cmfa|aac)$/.test(path)) kind = "segment";
  else return null;
  return {
    url: url.href,
    kind,
    capturedAt: Number.isFinite(capturedAt) && capturedAt > 0 ? capturedAt : Date.now(),
  };
}

async function canReadMediaCandidates(
  chromeApi: ChromeApi,
  sender: chrome.runtime.MessageSender,
  requestedTabId: number,
  contentRef: ContentRef,
): Promise<boolean> {
  if (!isValidXContentRef(contentRef) || !Number.isInteger(requestedTabId) || requestedTabId < 0) {
    return false;
  }
  if (sender.tab?.id !== undefined) {
    return sender.tab.id === requestedTabId && senderMatchesRef(sender, contentRef);
  }
  const [activeTab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
  return activeTab?.id === requestedTabId && xUrlMatchesRef(activeTab.url, contentRef);
}

function senderMatchesRef(sender: chrome.runtime.MessageSender, contentRef: ContentRef): boolean {
  const currentUrl = sender.url ?? sender.tab?.url;
  return xUrlMatchesRef(currentUrl, contentRef);
}

function senderIsXPage(sender: chrome.runtime.MessageSender): boolean {
  const urls = [sender.url, sender.tab?.url].filter((value): value is string => Boolean(value));
  return urls.length > 0 && urls.every((candidate) => {
    try {
      const url = new URL(candidate);
      return url.protocol === "https:"
        && (url.hostname === "x.com" || url.hostname === "www.x.com")
        && !url.username
        && !url.password
        && !url.port;
    } catch {
      return false;
    }
  });
}

function xUrlMatchesRef(candidate: string | undefined, contentRef: ContentRef): boolean {
  if (!candidate) return false;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:"
    || (url.hostname !== "x.com" && url.hostname !== "www.x.com")
    || url.username
    || url.password
    || url.port
  ) return false;
  const match = X_STATUS_PATH.exec(url.pathname);
  if (!match || match[1] !== contentRef.sourceContentId) return false;
  return !match[2] || Number(match[2]) === contentRef.mediaIndex;
}

function activeContentMatchesUrl(contentRef: ContentRef | undefined, url: string | undefined): boolean {
  return Boolean(contentRef && xUrlMatchesRef(url, contentRef));
}

function isValidXContentRef(contentRef: ContentRef): boolean {
  if (contentRef?.platform !== "x") return false;
  const parsed = parseContentRef(
    `https://x.com/i/status/${contentRef.sourceContentId}/video/${contentRef.mediaIndex}`,
  );
  return Boolean(parsed && sameContentRef(parsed, contentRef));
}

function sameContentRef(left: ContentRef, right: ContentRef): boolean {
  return left.platform === right.platform
    && left.sourceContentId === right.sourceContentId
    && left.mediaIndex === right.mediaIndex;
}

function pruneCandidates(candidates: MediaCandidate[], now: number): MediaCandidate[] {
  return candidates.filter((candidate) => (
    candidate.capturedAt <= now + CAPTURE_WINDOW_MS
    && now - candidate.capturedAt < CANDIDATE_TTL_MS
    && mediaCandidateFromRequest(candidate.url, candidate.capturedAt)?.kind === candidate.kind
  ));
}

function pruneCandidateMap(
  candidates: Record<string, MediaCandidate[]>,
  now: number,
): Record<string, MediaCandidate[]> {
  return Object.fromEntries(
    Object.entries(candidates)
      .map(([key, values]) => [key, pruneCandidates(values, now)] as const)
      .filter((entry) => entry[1].length > 0),
  );
}

function sortCandidates(candidates: MediaCandidate[]): MediaCandidate[] {
  const rank: Record<MediaCandidate["kind"], number> = { mp4: 3, hls: 2, segment: 1 };
  return [...candidates].sort((left, right) => (
    rank[right.kind] - rank[left.kind]
    || right.capturedAt - left.capturedAt
    || left.url.localeCompare(right.url)
  ));
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

async function loadMediaCaptureState(chromeApi: ChromeApi): Promise<MediaCaptureState> {
  const value = await chromeApi.storage.session.get(MEDIA_STORAGE_KEY);
  return (value[MEDIA_STORAGE_KEY] as MediaCaptureState | undefined) ?? {};
}

async function loadLastDetectedContentState(chromeApi: ChromeApi): Promise<LastDetectedContentState> {
  const value = await chromeApi.storage.session.get(LAST_DETECTED_STORAGE_KEY);
  return (value[LAST_DETECTED_STORAGE_KEY] as LastDetectedContentState | undefined) ?? {};
}

async function resolveLastDetectedContent(
  chromeApi: ChromeApi,
  tabId: number,
  url?: string,
): Promise<ContentRef | null> {
  const state = await loadLastDetectedContentState(chromeApi);
  const tabKey = String(tabId);
  const stored = state[tabKey];
  if (
    stored
    && isValidXContentRef(stored.contentRef)
    && stored.canonicalStatusId === stored.contentRef.sourceContentId
    && xUrlMatchesRef(url, stored.contentRef)
  ) {
    return stored.contentRef;
  }
  if (stored) {
    delete state[tabKey];
    await chromeApi.storage.session.set({ [LAST_DETECTED_STORAGE_KEY]: state });
  }
  return null;
}

async function removeAllTabState(chromeApi: ChromeApi, tabId: number): Promise<void> {
  const value = await chromeApi.storage.session.get([
    STORAGE_KEY,
    MEDIA_STORAGE_KEY,
    LAST_DETECTED_STORAGE_KEY,
  ]);
  const tabKey = String(tabId);
  const analyzedTabs = (value[STORAGE_KEY] as AnalyzedTabs | undefined) ?? {};
  const mediaState = (value[MEDIA_STORAGE_KEY] as MediaCaptureState | undefined) ?? {};
  const lastDetectedState = (
    value[LAST_DETECTED_STORAGE_KEY] as LastDetectedContentState | undefined
  ) ?? {};
  delete analyzedTabs[tabKey];
  delete mediaState[tabKey];
  delete lastDetectedState[tabKey];
  await chromeApi.storage.session.set({
    [MEDIA_STORAGE_KEY]: mediaState,
    [LAST_DETECTED_STORAGE_KEY]: lastDetectedState,
  });
  await chromeApi.storage.session.set({ [STORAGE_KEY]: analyzedTabs });
  await scheduleMediaCleanupForState(chromeApi, mediaState);
}

async function closeCaptureForTab(
  chromeApi: ChromeApi,
  tabId: number,
  currentUrl?: string,
): Promise<void> {
  const state = await loadMediaCaptureState(chromeApi);
  const tabState = state[String(tabId)];
  if (!tabState?.active) return;
  if (xUrlMatchesRef(currentUrl, tabState.active.contentRef)) return;
  tabState.active = null;
  tabState.candidates = pruneCandidateMap(tabState.candidates, Date.now());
  if (Object.keys(tabState.candidates).length === 0) delete state[String(tabId)];
  await chromeApi.storage.session.set({ [MEDIA_STORAGE_KEY]: state });
  await scheduleMediaCleanupForState(chromeApi, state);
}

async function cleanupExpiredMedia(chromeApi: ChromeApi): Promise<void> {
  const state = await loadMediaCaptureState(chromeApi);
  const now = Date.now();
  for (const [tabKey, tabState] of Object.entries(state)) {
    tabState.candidates = pruneCandidateMap(tabState.candidates, now);
    if (!tabState.active && Object.keys(tabState.candidates).length === 0) delete state[tabKey];
  }
  await chromeApi.storage.session.set({ [MEDIA_STORAGE_KEY]: state });
  await scheduleMediaCleanupForState(chromeApi, state);
}

async function initializeMediaCapture(chromeApi: ChromeApi): Promise<void> {
  const state = await loadMediaCaptureState(chromeApi);
  const now = Date.now();
  for (const [tabKey, tabState] of Object.entries(state)) {
    tabState.active = null;
    tabState.candidates = pruneCandidateMap(tabState.candidates, now);
    if (Object.keys(tabState.candidates).length === 0) delete state[tabKey];
  }
  await chromeApi.storage.session.set({ [MEDIA_STORAGE_KEY]: state });
  await scheduleMediaCleanupForState(chromeApi, state);
}

async function scheduleMediaCleanupForState(
  chromeApi: ChromeApi,
  state: MediaCaptureState,
): Promise<void> {
  let nextExpiry = Number.POSITIVE_INFINITY;
  for (const tabState of Object.values(state)) {
    for (const candidates of Object.values(tabState.candidates)) {
      for (const candidate of candidates) {
        nextExpiry = Math.min(nextExpiry, candidate.capturedAt + CANDIDATE_TTL_MS);
      }
    }
  }
  if (Number.isFinite(nextExpiry)) {
    chromeApi.alarms.create(MEDIA_CLEANUP_ALARM, { when: nextExpiry });
  } else {
    await chromeApi.alarms.clear(MEDIA_CLEANUP_ALARM);
  }
}

async function updatePanelForTab(
  chromeApi: ChromeApi,
  tabId: number,
  url?: string,
): Promise<ContentRef | null> {
  const explicitRef = parseContentRef(url);
  const rememberedRef = await resolveLastDetectedContent(chromeApi, tabId, url);
  const isSupportedVideo = explicitRef !== null || rememberedRef !== null;
  await chromeApi.sidePanel.setOptions(
    isSupportedVideo
      ? { tabId, path: "sidepanel.html", enabled: true }
      : { tabId, enabled: false },
  );
  return rememberedRef;
}

function openPanelForTab(chromeApi: ChromeApi, tabId: number): void {
  void chromeApi.sidePanel
    .setOptions({ tabId, path: "sidepanel.html", enabled: true })
    .catch(reportBackgroundError);
  void chromeApi.sidePanel.open({ tabId }).catch(reportBackgroundError);
}

async function configureActiveTab(
  chromeApi: ChromeApi,
  lastDetectedContentByTab: Map<number, ContentRef>,
): Promise<void> {
  const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) {
    const rememberedRef = await updatePanelForTab(chromeApi, tab.id, tab.url);
    if (rememberedRef) lastDetectedContentByTab.set(tab.id, rememberedRef);
  }
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) {
  installBackgroundHandlers(chrome);
}
