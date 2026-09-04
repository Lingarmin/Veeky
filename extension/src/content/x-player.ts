import type { ContentRef } from "../shared/types";

const X_STATUS_PATH = /^\/[^/]+\/status\/([0-9]+)(?:\/video\/([1-9][0-9]*))?\/?$/;

export interface XPlayerTrackerOptions {
  onActive: (contentRef: ContentRef, durationMs: number) => void;
  onInactive: (contentRef: ContentRef) => void;
  document?: Document;
  window?: Window;
}

interface Selection {
  video: HTMLVideoElement;
  contentRef: ContentRef;
  durationMs: number;
}

interface BoundVideo {
  play: () => void;
  pause: () => void;
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
  let selection: Selection | null = null;
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
    if (selection && selection.video !== video) clearSelection();
    selection = { video, contentRef, durationMs };
    options.onActive(contentRef, durationMs);
  };

  const bind = (video: HTMLVideoElement) => {
    if (bindings.has(video)) return;
    const listeners: BoundVideo = {
      play: () => select(video),
      pause: () => {
        if (selection?.video === video) clearSelection();
      },
      loadedmetadata: () => {
        if (selection?.video === video && !video.paused) select(video);
      },
    };
    video.addEventListener("play", listeners.play);
    video.addEventListener("pause", listeners.pause);
    video.addEventListener("loadedmetadata", listeners.loadedmetadata);
    bindings.set(video, listeners);
  };

  const unbind = (video: HTMLVideoElement, listeners: BoundVideo) => {
    video.removeEventListener("play", listeners.play);
    video.removeEventListener("pause", listeners.pause);
    video.removeEventListener("loadedmetadata", listeners.loadedmetadata);
    bindings.delete(video);
  };

  const scan = () => {
    if (stopped) return;
    for (const [video, listeners] of bindings) {
      if (!video.isConnected) unbind(video, listeners);
    }
    if (selection && !selection.video.isConnected) clearSelection();

    const videos = Array.from(pageDocument.querySelectorAll<HTMLVideoElement>("video"));
    for (const video of videos) bind(video);
    const playing = videos
      .filter((video) => !video.paused && contentRefForVideo(video, pageRoute(pageWindow)))
      .sort((left, right) => playerPriority(right) - playerPriority(left));
    if (playing[0]) select(playing[0]);
  };

  const handleRouteChange = () => {
    clearSelection();
    scan();
  };
  const observer = new MutationObserver(scan);
  observer.observe(pageDocument.documentElement, { childList: true, subtree: true });
  pageWindow.addEventListener("popstate", handleRouteChange);
  const removeHistoryHook = subscribeToHistory(pageWindow, handleRouteChange);
  scan();

  return () => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    pageWindow.removeEventListener("popstate", handleRouteChange);
    removeHistoryHook();
    for (const [video, listeners] of bindings) unbind(video, listeners);
    selection = null;
  };
}

function pageRoute(pageWindow: Window): string {
  return `${pageWindow.location.pathname}${pageWindow.location.search}${pageWindow.location.hash}`;
}

function contentRefForVideo(video: HTMLVideoElement, pageUrl: string): ContentRef | null {
  const route = parseXStatusRoute(pageUrl);
  if (!route) return null;
  const scope = playerScope(video);
  if (!scope || owningStatusId(video, scope) !== route.sourceContentId) return null;

  let mediaIndex = route.mediaIndex;
  if (!mediaIndex && scope.matches("article")) {
    const scopedVideos = Array.from(scope.querySelectorAll<HTMLVideoElement>("video"))
      .filter((candidate) => (
        playerScope(candidate) === scope
        && owningStatusId(candidate, scope) === route.sourceContentId
      ));
    const index = scopedVideos.indexOf(video);
    if (index >= 0) mediaIndex = index + 1;
  } else if (!mediaIndex) {
    mediaIndex = mediaIndexFromLinks(scope, route.sourceContentId);
  }
  if (!mediaIndex || mediaIndex < 1) return null;
  return { platform: "x", sourceContentId: route.sourceContentId, mediaIndex };
}

function playerScope(video: HTMLVideoElement): Element | null {
  return video.closest('[role="dialog"]') ?? video.closest("article");
}

function owningStatusId(video: HTMLVideoElement, scope: Element): string | null {
  let container: Element | null = video.parentElement;
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

function mediaIndexFromLinks(scope: Element, statusId: string): number | null {
  for (const anchor of scope.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')) {
    const route = parseXStatusRoute(anchor.getAttribute("href") ?? anchor.href);
    if (route?.sourceContentId === statusId && route.mediaIndex) return route.mediaIndex;
  }
  return null;
}

function parseXStatusRoute(candidate: string): { sourceContentId: string; mediaIndex: number | null } | null {
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
  if (!match) return null;
  const mediaIndex = match[2] ? Number(match[2]) : null;
  if (mediaIndex !== null && (!Number.isSafeInteger(mediaIndex) || mediaIndex < 1)) return null;
  return { sourceContentId: match[1], mediaIndex };
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
