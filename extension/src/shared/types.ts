export type JobStatus =
  | "queued"
  | "fetching_transcript"
  | "translating"
  | "analyzing"
  | "completed"
  | "failed";

export interface ContentRef {
  platform: "youtube" | "x";
  sourceContentId: string;
  mediaIndex: number;
}

export interface ContentContext {
  contentId: string;
  contentRef: ContentRef;
  videoId: string | null;
}

export interface AnalyzedTab {
  tabId: number;
  contentRef?: ContentRef;
  videoId?: string;
  jobId: string;
}

export interface ActiveTabContext {
  tabId: number;
  url: string;
  title: string;
  contentRef?: ContentRef | null;
  videoId: string | null;
  analysis: AnalyzedTab | null;
}

export interface MediaCandidate {
  url: string;
  kind: "mp4" | "hls" | "segment";
  capturedAt: number;
}

export interface LlmConfig {
  provider: "kimi" | "deepseek";
  apiUrl: string;
  apiKey: string;
  model: string;
}

export type ExtensionMessage =
  | { type: "GET_ACTIVE_TAB_CONTEXT" }
  | { type: "REGISTER_ANALYSIS"; tabId: number; videoId: string; jobId: string }
  | { type: "REGISTER_ANALYSIS"; tabId: number; contentRef: ContentRef; jobId: string }
  | { type: "SEEK_VIDEO"; tabId: number; videoId: string; startMs: number }
  | { type: "X_PLAYER_ACTIVE"; contentRef: ContentRef; durationMs: number }
  | { type: "X_PLAYER_INACTIVE"; contentRef: ContentRef }
  | { type: "GET_MEDIA_CANDIDATES"; tabId: number; contentRef: ContentRef };

export interface CaptionTrack {
  languageCode: string;
  languageName: string;
  isGenerated: boolean;
  isTranslatable: boolean;
}

export interface VideoInspection extends ContentContext {
  durationMs: number;
  sourceStatus: "ready" | "play_required" | "media_required" | "unavailable";
  transcriptSource: "youtube_caption" | "faster_whisper";
  availableLanguages: CaptionTrack[];
  tracks: CaptionTrack[];
  selectedLanguage: string;
}

export interface AnalysisStatus {
  jobId: string;
  status: JobStatus;
  failureCode: string | null;
  failureDetail: string | null;
}

export interface TimedSummary {
  start_ms: number;
  end_ms: number;
  title: string;
  summary: string;
}

export interface Highlight extends TimedSummary {
  original_excerpt: string;
  translated_excerpt: string;
}

export interface TranscriptSegment {
  id: string;
  startMs: number;
  durationMs: number;
  original: string;
  translated: string | null;
}

export interface AnalysisResult extends ContentContext {
  jobId: string;
  videoTitle: string;
  durationMs: number;
  sourceLanguage: string;
  targetLanguage: string;
  isGenerated: boolean | null;
  oneLineSummary: string;
  summaryPoints: string[];
  chapters: TimedSummary[];
  highlights: Highlight[];
  transcript: TranscriptSegment[];
  partial: boolean;
  failureCode: string | null;
  modelName: string;
  modelVersion: string;
}

export interface AnalysisHistoryItem extends ContentContext {
  jobId: string;
  videoTitle: string;
  durationMs: number;
  sourceLanguage: string;
  targetLanguage: string;
  completedAt: string;
  modelName: string;
  modelVersion: string;
}

export interface AnalysisHistoryResponse {
  items: AnalysisHistoryItem[];
  hasMore: boolean;
}
