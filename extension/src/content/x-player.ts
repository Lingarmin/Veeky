import type { ContentRef } from "../shared/types";

const MAX_X_SOURCE_CONTENT_ID = 18_446_744_073_709_551_615n;
const MAX_DATABASE_INTEGER = 2_147_483_647;
const X_STATUS_PATH = /^\/[^/]+\/status\/([0-9]+)(?:\/video\/([0-9]+))?\/?$/;
const ROUTE_POLL_MS = 250;

export interface XPlayerTrackerOptions {
  onActive: (contentRef: ContentRef, durationMs: number) => void;
  onInactive: (contentRef: ContentRef) => void;
  document?: Document;
  window?: Window;
}

export function findXVideoForContentRef(
  pageDocument: Document,
  pageWindow: Window,
  contentRef: ContentRef,
): HTMLVideoElement | null {
  return matchingVideos(
    Array.from(pageDocument.querySelectorAll<HTMLVideoElement>("video")),
    pageRoute(pageWindow),
    contentRef,
  ).sort((left, right) => (
    Number(left.paused) - Number(right.paused)
    || playerPriority(right) - playerPriority(left)
  ))[0] ?? null;
}

interface Selection {
  video: HTMLVideoElement;
  contentRef: ContentRef;
  durationMs: number;
  slot: PlayerSlot;
}

interface PlayerSlot {
  scope: Element;
  container: Element;
  containerVideoIndex: number;
  scopeVideoIndex: number;
}

interface BoundVideo {
  play: () => void;
  loadedmetadata: () => void;
}

interface HistoryHook {
  originalPushState: History["pushState"];
  originalReplaceState: History["replaceState"];
  pushState: History["pushState"];
  replaceState: History["replaceState"];
  subscribers: Set<() => void>;
}

const historyHooks = new WeakMap<Window, HistoryHook>();

export function installXPlayerTracker(options: XPlayerTrackerOptions): () => void {
  const pageWindow = options.window ?? window;
  const pageDocument = options.document ?? document;
  const bindings = new Map<HTMLVideoElement, BoundVideo>();
  const playOrder = new Map<HTMLVideoElement, number>();
  let selection: Selection | null = null;
  let playSequence = 0;
  let lastRoute = pageRoute(pageWindow);
  let stopped = false;

  const clearSelection = () => {
    if (!selection) return;
    const previous = selection;
    selection = null;
    options.onInactive(previous.contentRef);
  };

  const select = (video: HTMLVideoElement) => {
    const contentRef = contentRefForVideo(video, pageRoute(pageWindow));
    if (!contentRef) return;
    const durationMs = playerDurationMs(video);
    if (
      selection?.video === video
      && sameContentRef(selection.contentRef, contentRef)
      && selection.durationMs === durationMs
    ) {
      return;
    }
    if (
      selection
      && (selection.video !== video || !sameContentRef(selection.contentRef, contentRef))
    ) {
      clearSelection();
    }
    selection = { video, contentRef, durationMs, slot: playerSlot(video, contentRef) };
    options.onActive(contentRef, durationMs);
  };

  const bind = (video: HTMLVideoElement) => {
    if (bindings.has(video)) return;
    const listeners: BoundVideo = {
      play: () => {
        playSequence += 1;
        playOrder.set(video, playSequence);
        select(video);
      },
      loadedmetadata: () => {
        if (selection?.video === video) select(video);
      },
    };
    video.addEventListener("play", listeners.play);
    video.addEventListener("loadedmetadata", listeners.loadedmetadata);
    bindings.set(video, listeners);
  };

  const unbind = (video: HTMLVideoElement, listeners: BoundVideo) => {
    video.removeEventListener("play", listeners.play);
    video.removeEventListener("loadedmetadata", listeners.loadedmetadata);
    bindings.delete(video);
    playOrder.delete(video);
  };

  const scan = () => {
    if (stopped) return;
    for (const [video, listeners] of bindings) {
      if (!video.isConnected) unbind(video, listeners);
    }

    const videos = Array.from(pageDocument.querySelectorAll<HTMLVideoElement>("video"));
    for (const video of videos) bind(video);
    if (selection && !selection.video.isConnected) {
      const previous = selection;
      const route = pageRoute(pageWindow);
      const replacement = matchingVideos(videos, route, previous.contentRef)
        .filter((video) => matchesPlayerSlot(video, previous.slot, previous.contentRef))
        .sort((left, right) => (
          Number(left.paused) - Number(right.paused)
          || playerPriority(right) - playerPriority(left)
        ))[0];
      if (replacement) {
        selection = null;
        select(replacement);
        return;
      }
      clearSelection();
    }
    if (selection && selection.video.isConnected) {
      const selectedVideo = selection.video;
      const currentRef = contentRefForVideo(selectedVideo, pageRoute(pageWindow));
      if (currentRef) {
        if (!sameContentRef(selection.contentRef, currentRef)) select(selectedVideo);
        return;
      }
      clearSelection();
    }
    const playing = videos
      .filter((video) => !video.paused && contentRefForVideo(video, pageRoute(pageWindow)))
      .sort((left, right) => (
        (playOrder.get(right) ?? 0) - (playOrder.get(left) ?? 0)
        || playerPriority(right) - playerPriority(left)
      ));
    if (playing[0]) select(playing[0]);
  };

  const handleRouteChange = () => {
    lastRoute = pageRoute(pageWindow);
    clearSelection();
    scan();
  };
  const observer = new MutationObserver(scan);
  observer.observe(pageDocument.documentElement, {
    attributes: true,
    attributeFilter: ["href"],
    childList: true,
    subtree: true,
  });
  pageWindow.addEventListener("popstate", handleRouteChange);
  const removeHistoryHook = subscribeToHistory(pageWindow, handleRouteChange);
  const routePoll = pageWindow.setInterval(() => {
    if (pageRoute(pageWindow) !== lastRoute) handleRouteChange();
  }, ROUTE_POLL_MS);
  scan();

  return () => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    pageWindow.removeEventListener("popstate", handleRouteChange);
    removeHistoryHook();
    pageWindow.clearInterval(routePoll);
    for (const [video, listeners] of bindings) unbind(video, listeners);
    selection = null;
  };
}

function pageRoute(pageWindow: Window): string {
  return `${pageWindow.location.pathname}${pageWindow.location.search}${pageWindow.location.hash}`;
}

function matchingVideos(
  videos: HTMLVideoElement[],
  pageUrl: string,
  contentRef: ContentRef,
): HTMLVideoElement[] {
  return videos.filter((video) => {
    const candidateRef = contentRefForVideo(video, pageUrl);
    return candidateRef && sameContentRef(candidateRef, contentRef);
  });
}

function contentRefForVideo(video: HTMLVideoElement, pageUrl: string): ContentRef | null {
  const route = parseXStatusRoute(pageUrl);
  if (!route) return null;
  const scope = playerScope(video);
  if (!scope || owningStatusId(video, scope) !== route.sourceContentId) return null;

  const containedIndex = mediaIndexFromContainedLink(video, scope, route.sourceContentId);
  const tileIndex = mediaIndexFromTiles(video, scope, route.sourceContentId);
  const visibleMediaCount = mediaElementsInScope(scope, route.sourceContentId).length;
  const mediaIndex = route.mediaIndex && visibleMediaCount <= 1
    ? route.mediaIndex
    : containedIndex ?? tileIndex ?? route.mediaIndex;
  if (!mediaIndex || mediaIndex < 1) return null;
  return { platform: "x", sourceContentId: route.sourceContentId, mediaIndex };
}

function mediaIndexFromTiles(
  video: HTMLVideoElement,
  scope: Element,
  statusId: string,
): number | null {
  const index = mediaElementsInScope(scope, statusId)
    .findIndex((candidate) => candidate === video || candidate.contains(video));
  return index >= 0 ? index + 1 : null;
}

function mediaElementsInScope(scope: Element, statusId: string): Element[] {
  const recognizedTiles = Array.from(scope.querySelectorAll<HTMLElement>(
    '[data-testid="tweetPhoto"], [data-testid="videoPlayer"]',
  )).filter((candidate) => (
    playerScope(candidate) === scope
    && owningStatusId(candidate, scope) === statusId
  ));
  if (recognizedTiles.length > 0) {
    return recognizedTiles.filter((candidate) => (
      !recognizedTiles.some((other) => other !== candidate && other.contains(candidate))
    ));
  }
  return Array.from(scope.querySelectorAll<HTMLElement>("video, img"))
    .filter((candidate) => (
      playerScope(candidate) === scope
      && owningStatusId(candidate, scope) === statusId
    ));
}

function playerSlot(video: HTMLVideoElement, contentRef: ContentRef): PlayerSlot {
  const scope = playerScope(video) ?? video.parentElement ?? video;
  const tile = video.closest<HTMLElement>(
    '[data-testid="tweetPhoto"], [data-testid="videoPlayer"]',
  );
  const container = tile && playerScope(tile) === scope
    ? tile
    : video.parentElement ?? scope;
  return {
    scope,
    container,
    containerVideoIndex: videoIndex(container, video, scope, contentRef.sourceContentId),
    scopeVideoIndex: videoIndex(scope, video, scope, contentRef.sourceContentId),
  };
}

function matchesPlayerSlot(
  video: HTMLVideoElement,
  slot: PlayerSlot,
  contentRef: ContentRef,
): boolean {
  const scope = playerScope(video);
  if (scope !== slot.scope) return false;
  if (!slot.container.isConnected) {
    return videoIndex(scope, video, scope, contentRef.sourceContentId) === slot.scopeVideoIndex;
  }
  const candidateSlot = playerSlot(video, contentRef);
  return candidateSlot.container === slot.container
    && candidateSlot.containerVideoIndex === slot.containerVideoIndex;
}

function videoIndex(
  container: Element,
  video: HTMLVideoElement,
  scope: Element,
  statusId: string,
): number {
  return Array.from(container.querySelectorAll<HTMLVideoElement>("video"))
    .filter((candidate) => (
      playerScope(candidate) === scope
      && owningStatusId(candidate, scope) === statusId
    ))
    .indexOf(video);
}

function playerScope(element: Element): Element | null {
  return element.closest('[role="dialog"]') ?? element.closest("article");
}

function owningStatusId(element: Element, scope: Element): string | null {
  let container: Element | null = element;
  while (container) {
    const anchor = container.matches('a[href*="/status/"]')
      ? container as HTMLAnchorElement
      : container.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
    if (anchor) {
      return parseXStatusRoute(anchor.getAttribute("href") ?? anchor.href)?.sourceContentId ?? null;
    }
    if (container === scope) return null;
    container = container.parentElement;
  }
  return null;
}

function mediaIndexFromContainedLink(
  video: HTMLVideoElement,
  scope: Element,
  statusId: string,
): number | null {
  const containingAnchor = video.closest<HTMLAnchorElement>('a[href*="/status/"]');
  if (containingAnchor && scope.contains(containingAnchor)) {
    const route = parseXStatusRoute(containingAnchor.getAttribute("href") ?? containingAnchor.href);
    if (route?.sourceContentId === statusId && route.mediaIndex) return route.mediaIndex;
  }
  if (!scope.matches('[role="dialog"]')) return null;
  for (const anchor of scope.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')) {
    const route = parseXStatusRoute(anchor.getAttribute("href") ?? anchor.href);
    if (route?.sourceContentId === statusId && route.mediaIndex) return route.mediaIndex;
  }
  return null;
}

function parseXStatusRoute(candidate: string): {
  sourceContentId: string;
  mediaIndex: number | null;
} | null {
  let url: URL;
  try {
    url = new URL(candidate, "https://x.com");
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:"
    || (url.hostname !== "x.com" && url.hostname !== "www.x.com")
    || url.username
    || url.password
    || url.port
  ) {
    return null;
  }
  const match = X_STATUS_PATH.exec(url.pathname);
  if (!match || !isValidXSourceContentId(match[1])) return null;
  if (!match[2]) return { sourceContentId: match[1], mediaIndex: null };

  const mediaIndex = Number(match[2]);
  if (!Number.isSafeInteger(mediaIndex) || mediaIndex < 1 || mediaIndex > MAX_DATABASE_INTEGER) {
    return null;
  }
  return { sourceContentId: match[1], mediaIndex };
}

function isValidXSourceContentId(candidate: string): boolean {
  if (candidate.length > 20) return false;
  const value = BigInt(candidate);
  return value > 0n && value <= MAX_X_SOURCE_CONTENT_ID;
}

function playerDurationMs(video: HTMLVideoElement): number {
  return Number.isFinite(video.duration) && video.duration > 0
    ? Math.round(video.duration * 1000)
    : 0;
}

function playerPriority(video: HTMLVideoElement): number {
  return video.closest('[role="dialog"]') ? 2 : 1;
}

function sameContentRef(left: ContentRef, right: ContentRef): boolean {
  return left.platform === right.platform
    && left.sourceContentId === right.sourceContentId
    && left.mediaIndex === right.mediaIndex;
}

function subscribeToHistory(pageWindow: Window, subscriber: () => void): () => void {
  let hook = historyHooks.get(pageWindow);
  if (!hook) {
    const history = pageWindow.history;
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    const subscribers = new Set<() => void>();
    const notify = () => {
      for (const callback of [...subscribers]) callback();
    };
    const pushState: History["pushState"] = function (...args) {
      originalPushState.apply(history, args);
      notify();
    };
    const replaceState: History["replaceState"] = function (...args) {
      originalReplaceState.apply(history, args);
      notify();
    };
    hook = { originalPushState, originalReplaceState, pushState, replaceState, subscribers };
    history.pushState = pushState;
    history.replaceState = replaceState;
    historyHooks.set(pageWindow, hook);
  }
  hook.subscribers.add(subscriber);

  return () => {
    const current = historyHooks.get(pageWindow);
    if (!current) return;
    current.subscribers.delete(subscriber);
    if (current.subscribers.size > 0) return;
    if (pageWindow.history.pushState === current.pushState) {
      pageWindow.history.pushState = current.originalPushState;
    }
    if (pageWindow.history.replaceState === current.replaceState) {
      pageWindow.history.replaceState = current.originalReplaceState;
    }
    historyHooks.delete(pageWindow);
  };
}
