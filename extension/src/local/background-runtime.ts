import { browserLlmConfigStore, isLlmConfigured, LLM_PROVIDER_OPTIONS } from "../sidepanel/llm";
import { completeChat } from "./llm-client";
import { LOCAL_BROKER, LOCAL_COMMAND, LOCAL_EXECUTE, LOCAL_OPERATIONS, safeRuntimeCode } from "./runtime";
import { localError, readYouTubeMetadata } from "./youtube-browser";
import { parseContentRef, parseXStatusRoute } from "../shared/content";
import type { ContentRef } from "../shared/types";

type ChromeApi = Pick<typeof chrome, "runtime" | "offscreen" | "tabs" | "scripting" | "storage">;
export const EXPERIMENTAL_ASR_KEY = "veeky.experimentalLocalAsr.v1";
export type LocalMediaResolver = (ref: ContentRef) => Promise<{ url: string; durationMs: number; title: string }>;

export function trustedExtensionSender(api: Pick<typeof chrome, "runtime">, sender: chrome.runtime.MessageSender, page: string): boolean {
  const expected = api.runtime.getURL(page);
  return sender.id === api.runtime.id && sender.url === expected
    && (!sender.tab?.url || sender.tab.url === expected);
}

export function installLocalRuntime(api: ChromeApi, resolveMedia: LocalMediaResolver): void {
  let creating: Promise<void> | null = null;
  const requests = new Map<string, AbortController>();
  const requireAsrConsent = async () => {
    const stored = await api.storage.local.get(EXPERIMENTAL_ASR_KEY);
    if (stored[EXPERIMENTAL_ASR_KEY] !== true) throw localError("local_asr_experimental_disabled");
  };
  const ensure = async () => {
    if (creating) return creating;
    creating = (async () => {
      if (!await api.offscreen.hasDocument()) await api.offscreen.createDocument({
        url: "offscreen.html", reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.DOM_PARSER],
        justification: "Run local speech recognition and checkpoint video analysis while the side panel is closed.",
      });
      // Document creation finishes before its module may be ready to receive messages.
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          const reply = await api.runtime.sendMessage({ type: LOCAL_EXECUTE, operation: "ping" });
          if (reply?.ok) return;
        } catch { /* A newly-created document may still be loading. */ }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw localError("analysis_engine_unavailable");
    })().finally(() => { creating = null; });
    return creating;
  };
  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== LOCAL_COMMAND && message?.type !== LOCAL_BROKER) return false;
    const command = message.type === LOCAL_COMMAND;
    if (!trustedExtensionSender(api, sender, command ? "sidepanel.html" : "offscreen.html")) {
      respond({ ok: false, code: "analysis_unauthorized" }); return false;
    }
    void (async () => {
      if (command) {
        if (!LOCAL_OPERATIONS.includes(message.operation)) throw localError("analysis_invalid_request");
        await ensure();
        let input = message.input;
        if (message.operation === "inspect") {
          let ref = parseContentRef(input?.url);
          const route = parseXStatusRoute(input?.url);
          if (!ref && route && input?.activeMediaIndex) ref = { platform: "x", sourceContentId: route.sourceContentId, mediaIndex: input.activeMediaIndex };
          if (ref?.platform === "x") {
            await requireAsrConsent();
            const media = await resolveMedia(ref);
            input = { url: input.url, activeMediaIndex: ref.mediaIndex, clientDurationMs: media.durationMs };
          }
        }
        return api.runtime.sendMessage({ type: LOCAL_EXECUTE, operation: message.operation, input });
      }
      if (message.operation === "heartbeat") return { ok: true };
      if (message.operation === "cancel") {
        requests.get(message.id)?.abort(); return { ok: true };
      }
      if (message.operation === "metadata") return { ok: true, value: await readYouTubeMetadata(message.url, api) };
      if (message.operation === "media") {
        await requireAsrConsent();
        return { ok: true, value: await resolveMedia(message.contentRef) };
      }
      if (message.operation !== "complete" || !LLM_PROVIDER_OPTIONS.some((p) => p.provider === message.provider)
        || typeof message.model !== "string" || message.model.length > 200
        || typeof message.id !== "string" || requests.has(message.id)
        || !Array.isArray(message.messages) || JSON.stringify(message.messages).length > 200_000) throw localError("llm_invalid_request");
      const controller = new AbortController();
      requests.set(message.id, controller);
      try {
        const config = await browserLlmConfigStore.load(message.provider);
        if (!isLlmConfigured(config)) throw localError("llm_invalid_config");
        const value = await completeChat({ ...config, model: message.model }, message.messages, { signal: controller.signal, thinking: { type: "disabled" }, responseFormat: { type: "json_object" } });
        return { ok: true, value };
      } finally { requests.delete(message.id); }
    })().then(respond, (error) => respond({ ok: false, code: safeRuntimeCode(error) }));
    return true;
  });
}
