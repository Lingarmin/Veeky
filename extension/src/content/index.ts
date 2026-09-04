import { installXPlayerTracker } from "./x-player";
import type { ExtensionMessage } from "../shared/types";

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
  const stopTracker = installXPlayerTracker({
    window: pageWindow,
    document: pageDocument,
    onActive: (contentRef, durationMs) => send({ type: "X_PLAYER_ACTIVE", contentRef, durationMs }),
    onInactive: (contentRef) => send({ type: "X_PLAYER_INACTIVE", contentRef }),
  });
  const teardown = () => {
    stopTracker();
    if (installations.get(pageDocument) === teardown) installations.delete(pageDocument);
  };
  installations.set(pageDocument, teardown);
  return teardown;
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
