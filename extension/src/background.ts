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
const MAX_TOTAL_CANDIDATES = 200;
const MAX_TOTAL_CANDIDATE_URL_BYTES = 128_000;
const RECENT_REQUEST_MAX_AGE_MS = 1_500;
const MAX_RECENT_REQUESTS_PER_TAB = 12;
const MAX_RECENT_REQUEST_URL_BYTES = 32_000;
const MAX_TOTAL_RECENT_REQUESTS = 48;
const MAX_TOTAL_RECENT_REQUEST_URL_BYTES = 64_000;
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

interface XRouteEpoch {
  epoch: number;
  statusId: string | null;
  mediaIndex: number | null;
  routeKey: string | null;
}

interface BufferedMediaCandidate extends MediaCandidate {
  routeEpoch: number;
  statusId: string;
}

interface BackgroundState {
  lastDetectedContentByTab: Map<number, ContentRef>;
  recentRequestsByTab: Map<number, BufferedMediaCandidate[]>;
  routeEpochByTab: Map<number, XRouteEpoch>;
  rescheduleRecentRequestCleanup: () => void;
  runCaptureTask: <T>(task: () => Promise<T>) => Promise<T>;
}

type ChromeApi = Pick<
  typeof chrome,
  | "action"
  | "alarms"
  | "runtime"
  | "sidePanel"
  | "scripting"
  | "storage"
  | "tabs"
  | "webNavigation"
  | "webRequest"
>;

export function parseVideoId(url?: string): string | null {
  const ref = parseContentRef(url);
  return ref?.platform === "youtube" ? ref.sourceContentId : null;
}

export function installBackgroundHandlers(chromeApi: ChromeApi): void {
  const lastDetectedContentByTab = new Map<number, ContentRef>();
  const recentRequestsByTab = new Map<number, BufferedMediaCandidate[]>();
  const routeEpochByTab = new Map<number, XRouteEpoch>();
  let recentRequestCleanupTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  const rescheduleRecentRequestCleanup = () => {
    if (recentRequestCleanupTimer !== null) globalThis.clearTimeout(recentRequestCleanupTimer);
    pruneRecentRequestMap(recentRequestsByTab, Date.now());
    const nextExpiry = nextRecentRequestExpiry(recentRequestsByTab);
    if (nextExpiry === null) {
      recentRequestCleanupTimer = null;
      return;
    }
    recentRequestCleanupTimer = globalThis.setTimeout(() => {
      recentRequestCleanupTimer = null;
      rescheduleRecentRequestCleanup();
    }, Math.max(0, nextExpiry - Date.now()));
  };
  let captureQueue: Promise<void> = Promise.resolve();
  const runCaptureTask = <T>(task: () => Promise<T>): Promise<T> => {
    const result = captureQueue.then(task);
    captureQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  const state: BackgroundState = {
    lastDetectedContentByTab,
    recentRequestsByTab,
    routeEpochByTab,
    rescheduleRecentRequestCleanup,
    runCaptureTask,
  };
  void chromeApi.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch(reportBackgroundError);
  const initialization = runCaptureTask(async () => {
    await initializeMediaCapture(chromeApi);
    await configureActiveTab(chromeApi, lastDetectedContentByTab, routeEpochByTab);
  });
  void initialization.catch(reportBackgroundError);

  chromeApi.action.onClicked.addListener((tab) => {
    const tabId = tab.id;
    if (tabId === undefined || !isSupportedPanelUrl(tab.url)) return;
    openPanelForTab(chromeApi, tabId);
  });

  const observeNavigation = (details: { frameId: number; tabId: number; url: string }) => {
    if (details.frameId !== 0) return;
    updateRouteEpoch(routeEpochByTab, details.tabId, details.url);
  };
  chromeApi.webNavigation.onHistoryStateUpdated.addListener(observeNavigation);
  chromeApi.webNavigation.onCommitted.addListener(observeNavigation);

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
    updateRouteEpoch(routeEpochByTab, tabId, changeInfo.url);
    const explicitRef = parseContentRef(tab.url);
    const supportedPanelUrl = isSupportedPanelUrl(tab.url);
    const rememberedRef = lastDetectedContentByTab.get(tabId);
    const rememberedRefStillMatches = activeContentMatchesUrl(rememberedRef, tab.url);
    if (!rememberedRefStillMatches) lastDetectedContentByTab.delete(tabId);
    void chromeApi.sidePanel.setOptions(
      supportedPanelUrl || rememberedRefStillMatches
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
    recentRequestsByTab.delete(tabId);
    routeEpochByTab.delete(tabId);
    rescheduleRecentRequestCleanup();
    return runCaptureTask(() => removeAllTabState(chromeApi, tabId))
      .catch(reportBackgroundError);
  });

  chromeApi.webRequest.onBeforeRequest.addListener(
    (details) => {
      const requestRoute = routeEpochByTab.get(details.tabId) ?? null;
      void runCaptureTask(() => captureMediaCandidate(
        chromeApi,
        details,
        recentRequestsByTab,
        requestRoute,
        rescheduleRecentRequestCleanup,
      )).catch(reportBackgroundError);
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
    const activeRoute = updateRouteEpoch(
      state.routeEpochByTab,
      tabId,
      sender.url ?? sender.tab?.url,
    );
    return state.runCaptureTask(async () => {
      const mediaState = await loadMediaCaptureState(chromeApi);
      const tabKey = String(tabId);
      const prior = mediaState[tabKey];
      const samePlayer = Boolean(
        prior?.active && sameContentRef(prior.active.contentRef, message.contentRef),
      );
      const key = contentKey(message.contentRef);
      const buffered = claimRecentRequests(
        state.recentRequestsByTab,
        tabId,
        signalAt,
        activeRoute,
        message.contentRef,
      );
      state.rescheduleRecentRequestCleanup();
      const candidates = pruneCandidateMap(prior?.candidates ?? {}, Date.now());
      if (buffered.length) {
        candidates[key] = mergeCandidates(candidates[key] ?? [], buffered, Date.now());
      }
      mediaState[tabKey] = {
        active: {
          contentRef: message.contentRef,
          expiresAt: samePlayer ? prior.active!.expiresAt : signalAt + CAPTURE_WINDOW_MS,
        },
        candidates,
      };
      enforceAggregateCandidateLimits(mediaState);
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
        enforceAggregateCandidateLimits(mediaState);
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
        enforceAggregateCandidateLimits(mediaState);
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
  recentRequestsByTab: Map<number, BufferedMediaCandidate[]>,
  requestRoute: XRouteEpoch | null,
  rescheduleRecentRequestCleanup: () => void,
): Promise<void> {
  if (details.tabId < 0 || (details.type !== "media" && details.type !== "xmlhttprequest")) return;
  const candidate = mediaCandidateFromRequest(details.url, details.timeStamp);
  if (!candidate) return;

  const state = await loadMediaCaptureState(chromeApi);
  const tabState = state[String(details.tabId)];
  const now = Date.now();
  if (!tabState?.active || !routeMatchesContentRef(requestRoute, tabState.active.contentRef)) {
    if (!requestRoute?.statusId) return;
    bufferRecentRequest(recentRequestsByTab, details.tabId, {
      ...candidate,
      routeEpoch: requestRoute.epoch,
      statusId: requestRoute.statusId,
    }, now);
    rescheduleRecentRequestCleanup();
    return;
  }
  const windowOpenedAt = tabState.active.expiresAt - CAPTURE_WINDOW_MS;
  if (candidate.capturedAt < windowOpenedAt || candidate.capturedAt > tabState.active.expiresAt) return;
  const key = contentKey(tabState.active.contentRef);
  tabState.candidates[key] = mergeCandidates(tabState.candidates[key] ?? [], [candidate], now);
  enforceAggregateCandidateLimits(state);
  await chromeApi.storage.session.set({ [MEDIA_STORAGE_KEY]: state });
  await scheduleMediaCleanupForState(chromeApi, state);
}

function mergeCandidates(
  current: MediaCandidate[],
  additions: MediaCandidate[],
  now: number,
): MediaCandidate[] {
  const byUrl = new Map(pruneCandidates(current, now).map((candidate) => [candidate.url, candidate]));
  for (const candidate of additions) byUrl.set(candidate.url, candidate);
  return sortCandidates([...byUrl.values()]).slice(0, MAX_CANDIDATES);
}

function bufferRecentRequest(
  recentRequestsByTab: Map<number, BufferedMediaCandidate[]>,
  tabId: number,
  candidate: BufferedMediaCandidate,
  now: number,
): void {
  const recent = (recentRequestsByTab.get(tabId) ?? [])
    .filter((item) => now - item.capturedAt <= RECENT_REQUEST_MAX_AGE_MS)
    .filter((item) => item.url !== candidate.url);
  recent.push(candidate);
  while (
    recent.length > MAX_RECENT_REQUESTS_PER_TAB
    || estimatedCandidateUrlBytes(recent) > MAX_RECENT_REQUEST_URL_BYTES
  ) {
    recent.shift();
  }
  if (recent.length) recentRequestsByTab.set(tabId, recent);
  else recentRequestsByTab.delete(tabId);
  pruneRecentRequestMap(recentRequestsByTab, now);
  enforceAggregateRecentRequestLimits(recentRequestsByTab);
}

function claimRecentRequests(
  recentRequestsByTab: Map<number, BufferedMediaCandidate[]>,
  tabId: number,
  signalAt: number,
  activeRoute: XRouteEpoch,
  contentRef: ContentRef,
): MediaCandidate[] {
  pruneRecentRequestMap(recentRequestsByTab, signalAt);
  const claimed = (recentRequestsByTab.get(tabId) ?? []).filter((candidate) => (
    candidate.capturedAt <= signalAt
    && signalAt - candidate.capturedAt <= RECENT_REQUEST_MAX_AGE_MS
    && candidate.routeEpoch === activeRoute.epoch
    && candidate.statusId === activeRoute.statusId
    && candidate.statusId === contentRef.sourceContentId
  ));
  recentRequestsByTab.delete(tabId);
  return claimed.map(({ routeEpoch: _routeEpoch, statusId: _statusId, ...candidate }) => candidate);
}

function pruneRecentRequestMap(
  recentRequestsByTab: Map<number, BufferedMediaCandidate[]>,
  now: number,
): void {
  for (const [tabId, candidates] of recentRequestsByTab) {
    const recent = candidates.filter((candidate) => (
      now - candidate.capturedAt <= RECENT_REQUEST_MAX_AGE_MS
    ));
    if (recent.length) recentRequestsByTab.set(tabId, recent);
    else recentRequestsByTab.delete(tabId);
  }
}

function nextRecentRequestExpiry(
  recentRequestsByTab: Map<number, BufferedMediaCandidate[]>,
): number | null {
  let nextExpiry = Number.POSITIVE_INFINITY;
  for (const candidates of recentRequestsByTab.values()) {
    for (const candidate of candidates) {
      nextExpiry = Math.min(nextExpiry, candidate.capturedAt + RECENT_REQUEST_MAX_AGE_MS + 1);
    }
  }
  return Number.isFinite(nextExpiry) ? nextExpiry : null;
}

function enforceAggregateRecentRequestLimits(
  recentRequestsByTab: Map<number, BufferedMediaCandidate[]>,
): void {
  const entries = [...recentRequestsByTab.entries()].flatMap(([tabId, candidates]) => (
    candidates.map((candidate) => ({ tabId, candidate }))
  )).sort((left, right) => (
    left.candidate.capturedAt - right.candidate.capturedAt
    || left.tabId - right.tabId
    || left.candidate.url.localeCompare(right.candidate.url)
  ));
  let totalBytes = entries.reduce(
    (total, entry) => total + entry.candidate.url.length * 2,
    0,
  );
  while (
    entries.length > MAX_TOTAL_RECENT_REQUESTS
    || totalBytes > MAX_TOTAL_RECENT_REQUEST_URL_BYTES
  ) {
    const oldest = entries.shift();
    if (!oldest) break;
    const candidates = recentRequestsByTab.get(oldest.tabId);
    if (!candidates) continue;
    const index = candidates.findIndex(({ url }) => url === oldest.candidate.url);
    if (index < 0) continue;
    totalBytes -= candidates[index].url.length * 2;
    candidates.splice(index, 1);
    if (candidates.length === 0) recentRequestsByTab.delete(oldest.tabId);
  }
}

function estimatedCandidateUrlBytes(candidates: MediaCandidate[]): number {
  return candidates.reduce((total, candidate) => total + candidate.url.length * 2, 0);
}

function enforceAggregateCandidateLimits(state: MediaCaptureState): void {
  const entries = Object.entries(state).flatMap(([tabKey, tabState]) => (
    Object.entries(tabState.candidates).flatMap(([key, candidates]) => (
      candidates.map((candidate) => ({ tabKey, key, candidate }))
    ))
  )).sort((left, right) => (
    left.candidate.capturedAt - right.candidate.capturedAt
    || left.tabKey.localeCompare(right.tabKey)
    || left.key.localeCompare(right.key)
    || left.candidate.url.localeCompare(right.candidate.url)
  ));
  let totalBytes = entries.reduce(
    (total, entry) => total + entry.candidate.url.length * 2,
    0,
  );
  while (entries.length > MAX_TOTAL_CANDIDATES || totalBytes > MAX_TOTAL_CANDIDATE_URL_BYTES) {
    const oldest = entries.shift();
    if (!oldest) break;
    const candidates = state[oldest.tabKey]?.candidates[oldest.key];
    if (!candidates) continue;
    const index = candidates.findIndex(({ url }) => url === oldest.candidate.url);
    if (index < 0) continue;
    totalBytes -= candidates[index].url.length * 2;
    candidates.splice(index, 1);
    if (candidates.length === 0) delete state[oldest.tabKey].candidates[oldest.key];
  }
  for (const [tabKey, tabState] of Object.entries(state)) {
    if (!tabState.active && Object.keys(tabState.candidates).length === 0) delete state[tabKey];
  }
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

function updateRouteEpoch(
  routeEpochByTab: Map<number, XRouteEpoch>,
  tabId: number,
  candidate: string | undefined,
): XRouteEpoch {
  const route = parseXStatusRoute(candidate);
  const routeKey = route
    ? `${route.sourceContentId}:${route.mediaIndex ?? "status"}`
    : null;
  const current = routeEpochByTab.get(tabId);
  if (current?.routeKey === routeKey) return current;
  const next = {
    epoch: (current?.epoch ?? 0) + 1,
    statusId: route?.sourceContentId ?? null,
    mediaIndex: route?.mediaIndex ?? null,
    routeKey,
  };
  routeEpochByTab.set(tabId, next);
  return next;
}

function routeMatchesContentRef(route: XRouteEpoch | null, contentRef: ContentRef): boolean {
  return Boolean(
    route?.statusId === contentRef.sourceContentId
    && (route.mediaIndex === null || route.mediaIndex === contentRef.mediaIndex),
  );
}

function parseXStatusRoute(candidate: string | undefined): {
  sourceContentId: string;
  mediaIndex: number | null;
} | null {
  if (!candidate) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:"
    || (url.hostname !== "x.com" && url.hostname !== "www.x.com")
    || url.username
    || url.password
    || url.port
  ) return null;
  const match = X_STATUS_PATH.exec(url.pathname);
  if (!match) return null;
  return {
    sourceContentId: match[1],
    mediaIndex: match[2] ? Number(match[2]) : null,
  };
}

function isSupportedPanelUrl(candidate: string | undefined): boolean {
  if (parseContentRef(candidate)) return true;
  return parseXStatusRoute(candidate) !== null;
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
      .map(([key, values]) => [
        key,
        sortCandidates(pruneCandidates(values, now)).slice(0, MAX_CANDIDATES),
      ] as const)
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
  enforceAggregateCandidateLimits(mediaState);
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
  enforceAggregateCandidateLimits(state);
  await chromeApi.storage.session.set({ [MEDIA_STORAGE_KEY]: state });
  await scheduleMediaCleanupForState(chromeApi, state);
}

async function cleanupExpiredMedia(chromeApi: ChromeApi): Promise<void> {
  const state = await loadMediaCaptureState(chromeApi);
  const now = Date.now();
  for (const [tabKey, tabState] of Object.entries(state)) {
    if (tabState.active && tabState.active.expiresAt <= now) tabState.active = null;
    tabState.candidates = pruneCandidateMap(tabState.candidates, now);
    if (!tabState.active && Object.keys(tabState.candidates).length === 0) delete state[tabKey];
  }
  enforceAggregateCandidateLimits(state);
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
  enforceAggregateCandidateLimits(state);
  await chromeApi.storage.session.set({ [MEDIA_STORAGE_KEY]: state });
  await scheduleMediaCleanupForState(chromeApi, state);
}

async function scheduleMediaCleanupForState(
  chromeApi: ChromeApi,
  state: MediaCaptureState,
): Promise<void> {
  let nextExpiry = Number.POSITIVE_INFINITY;
  for (const tabState of Object.values(state)) {
    if (tabState.active) nextExpiry = Math.min(nextExpiry, tabState.active.expiresAt);
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
  const isSupportedVideo = explicitRef !== null || rememberedRef !== null || isSupportedPanelUrl(url);
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
  routeEpochByTab: Map<number, XRouteEpoch>,
): Promise<void> {
  const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) {
    if (!routeEpochByTab.has(tab.id)) {
      updateRouteEpoch(routeEpochByTab, tab.id, tab.url);
    }
    const rememberedRef = await updatePanelForTab(chromeApi, tab.id, tab.url);
    if (rememberedRef) lastDetectedContentByTab.set(tab.id, rememberedRef);
  }
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) {
  installBackgroundHandlers(chrome);
}
