import { findXVideoForContentRef, installXPlayerTracker } from "./x-player";
import { SubtitleOverlay } from "./subtitle-overlay";
import type { ContentRef, ExtensionMessage, TranscriptSegment } from "../shared/types";

type ContentChromeApi = Pick<typeof chrome, "runtime">;

const installations = new WeakMap<Document, () => void>();

export function installContentScript(
  chromeApi: ContentChromeApi,
  pageWindow: Window = window,
  pageDocument: Document = document,
): () => void {
  const existing = installations.get(pageDocument);
  if (existing) return existing;

  const send = (message: ExtensionMessage) => {
    try {
      const pending = chromeApi.runtime.sendMessage(message, () => {
        void chromeApi.runtime.lastError;
      }) as unknown;
      if (isPromiseLike(pending)) pending.catch(() => undefined);
    } catch {
      // The extension can reload while an X page remains open.
    }
  };
  const overlay = new SubtitleOverlay(pageDocument);
  let activeRef: ContentRef | null = null;
  let activeVideo: HTMLVideoElement | null = null;
  const subtitles = new Map<string, TranscriptSegment[]>();

  const mountSubtitles = () => {
    if (!activeRef || !activeVideo) return;
    const segments = subtitles.get(contentRefKey(activeRef));
    if (segments) overlay.mount(activeVideo, segments);
  };
  const onMessage = (message: ExtensionMessage) => {
    if (message.type === "SET_SUBTITLES") {
      subtitles.set(contentRefKey(message.contentRef), message.segments.filter((item) => item.translated));
      if (activeRef && sameContentRef(activeRef, message.contentRef)) mountSubtitles();
      return;
    }
    if (message.type !== "SEEK_CONTENT" || !activeRef || !activeVideo) return;
    if (!sameContentRef(activeRef, message.contentRef) || !activeVideo.isConnected) return;
    activeVideo.currentTime = Math.max(0, message.startMs / 1000);
    void activeVideo.play().catch(() => undefined);
  };
  chromeApi.runtime.onMessage.addListener(onMessage);
  const stopTracker = installXPlayerTracker({
    window: pageWindow,
    document: pageDocument,
    onActive: (contentRef, durationMs) => {
      activeRef = contentRef;
      activeVideo = findXVideoForContentRef(pageDocument, pageWindow, contentRef);
      mountSubtitles();
      send({ type: "X_PLAYER_ACTIVE", contentRef, durationMs });
    },
    onInactive: (contentRef) => {
      if (activeRef && sameContentRef(activeRef, contentRef)) {
        activeRef = null;
        activeVideo = null;
        overlay.clear();
      }
      send({ type: "X_PLAYER_INACTIVE", contentRef });
    },
  });
  const teardown = () => {
    stopTracker();
    chromeApi.runtime.onMessage.removeListener(onMessage);
    overlay.destroy();
    if (installations.get(pageDocument) === teardown) installations.delete(pageDocument);
  };
  installations.set(pageDocument, teardown);
  return teardown;
}

function sameContentRef(left: ContentRef, right: ContentRef): boolean {
  return left.platform === right.platform
    && left.sourceContentId === right.sourceContentId
    && left.mediaIndex === right.mediaIndex;
}

function contentRefKey(contentRef: ContentRef): string {
  return `${contentRef.platform}:${contentRef.sourceContentId}:${contentRef.mediaIndex}`;
}

function isPromiseLike(value: unknown): value is { catch: (handler: () => undefined) => unknown } {
  return typeof value === "object"
    && value !== null
    && "catch" in value
    && typeof value.catch === "function";
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) {
  installContentScript(chrome);
}
