import type {
  ActiveTabContext,
  ContentRef,
  ExtensionMessage,
  MediaCandidate,
  MediaUploadNotification,
  StartMediaUploadMessage,
  TranscriptSegment,
} from "../shared/types";

export interface BrowserBridge {
  getActiveContext(): Promise<ActiveTabContext>;
  registerAnalysis(tabId: number, contentRef: ContentRef, jobId: string): Promise<void>;
  seek(tabId: number, contentRef: ContentRef, startMs: number): Promise<void>;
  getMediaCandidates(tabId: number, contentRef: ContentRef): Promise<MediaCandidate[]>;
  startMediaUpload(message: Omit<StartMediaUploadMessage, "type">): Promise<boolean>;
  showSubtitles(tabId: number, contentRef: ContentRef, segments: TranscriptSegment[]): Promise<void>;
  onMediaUpload(listener: (message: MediaUploadNotification) => void): () => void;
}

async function send<T>(message: ExtensionMessage): Promise<T> {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response as T;
}

export const browserBridge: BrowserBridge = {
  getActiveContext: () => send<ActiveTabContext>({ type: "GET_ACTIVE_TAB_CONTEXT" }),
  registerAnalysis: async (tabId, contentRef, jobId) => {
    await send({ type: "REGISTER_ANALYSIS", tabId, contentRef, jobId });
  },
  seek: async (tabId, contentRef, startMs) => {
    await send({ type: "SEEK_CONTENT", tabId, contentRef, startMs });
  },
  getMediaCandidates: async (tabId, contentRef) => {
    const response = await send<{ candidates: MediaCandidate[] }>({
      type: "GET_MEDIA_CANDIDATES", tabId, contentRef,
    });
    return response.candidates;
  },
  startMediaUpload: async (message) => {
    const response = await send<{ ok: boolean }>({ type: "START_MEDIA_UPLOAD", ...message });
    return response.ok;
  },
  showSubtitles: async (tabId, contentRef, segments) => {
    await send({ type: "SET_SUBTITLES", tabId, contentRef, segments });
  },
  onMediaUpload: (listener) => {
    const onMessage = (message: ExtensionMessage) => {
      if (
        message.type === "MEDIA_UPLOAD_PROGRESS"
        || message.type === "MEDIA_UPLOAD_COMPLETE"
        || message.type === "MEDIA_UPLOAD_FAILED"
      ) listener(message);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  },
};
