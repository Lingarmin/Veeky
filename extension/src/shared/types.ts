export type JobStatus =
  | "queued"
  | "fetching_transcript"
  | "translating"
  | "analyzing"
  | "completed"
  | "failed";

export interface AnalyzedTab {
  tabId: number;
  videoId: string;
  jobId: string;
}

export interface ActiveTabContext {
  tabId: number;
  url: string;
  title: string;
  videoId: string | null;
  analysis: AnalyzedTab | null;
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
  | { type: "SEEK_VIDEO"; tabId: number; videoId: string; startMs: number };

export interface CaptionTrack {
  languageCode: string;
  languageName: string;
  isGenerated: boolean;
  isTranslatable: boolean;
}

export interface VideoInspection {
  videoId: string;
  durationMs: number;
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

export interface AnalysisResult {
  jobId: string;
  videoId: string;
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

export interface AnalysisHistoryItem {
  jobId: string;
  videoId: string;
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
