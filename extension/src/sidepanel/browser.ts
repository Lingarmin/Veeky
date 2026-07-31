import type { ActiveTabContext, ExtensionMessage } from "../shared/types";

export interface BrowserBridge {
  getActiveContext(): Promise<ActiveTabContext>;
  registerAnalysis(tabId: number, videoId: string, jobId: string): Promise<void>;
  seek(tabId: number, videoId: string, startMs: number): Promise<void>;
}

async function send<T>(message: ExtensionMessage): Promise<T> {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response as T;
}

export const browserBridge: BrowserBridge = {
  getActiveContext: () => send<ActiveTabContext>({ type: "GET_ACTIVE_TAB_CONTEXT" }),
  registerAnalysis: async (tabId, videoId, jobId) => {
    await send({ type: "REGISTER_ANALYSIS", tabId, videoId, jobId });
  },
  seek: async (tabId, videoId, startMs) => {
    await send({ type: "SEEK_VIDEO", tabId, videoId, startMs });
  },
};
