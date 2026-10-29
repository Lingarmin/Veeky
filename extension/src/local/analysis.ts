import { contentKey, parseContentRef, parseXStatusRoute } from "../shared/content";
import type { AnalysisHistoryResponse, AnalysisResult, AnalysisStatus, ContentContext, ContentRef, TranscriptSegment, VideoInspection } from "../shared/types";
import type { AnalysisCreateResponse, AnalysisHistoryInput, InspectInput } from "../sidepanel/api";
import { LLM_PROVIDER_OPTIONS, type LlmProvider } from "../sidepanel/llm";
import type { ChatMessage } from "./llm-client";
import { createAnalysisMessages, createTranslationMessages, parseAnalysisResult, parseTranslationResult, type AnalysisResult as Summary } from "./prompts";
import { LocalAnalysisRepository, type LocalAnalysisTask, type LocalTaskStage } from "./repository";
import { selectYouTubeCaptionTrack, type YouTubeCaptionTrack } from "./youtube-captions";
import { MAX_VIDEO_DURATION_MS, localError, type YouTubeMetadata } from "./youtube-browser";

export type LocalLlmProvider = LlmProvider;

export interface LocalAnalysisCreateInput {
  contentRef: ContentRef;
  sourceLanguage?: string;
  targetLanguage?: string;
  title?: string;
  durationMs?: number;
  provider: LocalLlmProvider;
  model: string;
  force?: boolean;
}

export interface TranscriptionRequest {
  jobId: string;
  contentRef: ContentRef;
  durationMs: number;
  sourceLanguage: string;
}

export interface TranscriptionOptions {
  signal: AbortSignal;
  checkpointSegments: TranscriptSegment[];
  onCheckpoint: (sequence: number, segments: TranscriptSegment[]) => Promise<void>;
  onProgress: (stage: LocalTaskStage, completed: number, total: number | null) => Promise<void>;
}

/** All callbacks run in extension contexts. Credentials and media URLs never enter task inputs. */
export interface LocalAnalysisDependencies {
  repository: LocalAnalysisRepository;
  readYouTubeMetadata: (url: string, signal?: AbortSignal) => Promise<YouTubeMetadata>;
  fetchCaptionTranscript: (track: YouTubeCaptionTrack, videoId: string, options: { signal: AbortSignal }) => Promise<TranscriptSegment[]>;
  completeChat: (messages: ChatMessage[], provider: LocalLlmProvider, model: string, signal: AbortSignal) => Promise<string>;
  transcribe?: (request: TranscriptionRequest, options: TranscriptionOptions) => Promise<TranscriptSegment[]>;
  translationBatchSize?: number;
  now?: () => Date;
  createId?: () => string;
}

export interface LocalAnalysisStatus extends AnalysisStatus {
  stage: LocalTaskStage;
  state: LocalAnalysisTask["state"];
  progressCompleted: number;
  progressTotal: number | null;
}

const MAX_CONTEXT_CHARS = 24_000;
const MAX_BATCH_CHARS = 18_000;
const MAX_SUMMARY_CHARS = 7_000;
const SAFE_CODES = new Set([
  "storage_quota_exceeded", "storage_quota_unavailable", "local_asr_experimental_disabled",
  "analysis_cancelled", "analysis_failed", "analysis_busy", "analysis_not_found", "analysis_not_resumable",
  "video_too_long", "video_metadata_unavailable", "video_context_changed", "invalid_video_url", "captions_unavailable",
  "transcript_empty", "transcript_invalid_segment", "transcript_segment_too_large", "translation_invalid_response", "analysis_invalid_response",
  "local_asr_unavailable", "local_asr_failed", "audio_decode_unsupported", "audio_track_missing", "model_download_failed", "model_download_cancelled",
  "unsupported_media_candidate", "media_url_expired", "media_fetch_failed", "media_too_large", "audio_decode_failed", "audio_codec_unsupported", "model_manifest_invalid", "model_integrity_failed",
  "llm_invalid_config", "llm_invalid_request", "llm_cancelled", "llm_timeout", "llm_unavailable", "llm_authentication_failed",
  "llm_model_unavailable", "llm_quota_exhausted", "llm_rate_limited", "llm_request_rejected", "llm_invalid_response",
]);

export class LocalAnalysisEngine {
  private readonly ready: Promise<void>;
  private active: { jobId: string | null; controller: AbortController; done?: Promise<void> } | null = null;
  private readonly inspections = new Map<string, { durationMs: number; title: string }>();

  constructor(private readonly dependencies: LocalAnalysisDependencies) {
    this.ready = dependencies.repository.markRunningTasksInterrupted();
  }

  async inspect(input: string | InspectInput): Promise<VideoInspection> {
    await this.ready;
    const request = typeof input === "string" ? { url: input } : input;
    let ref = parseContentRef(request.url);
    if (!ref) {
      const route = parseXStatusRoute(request.url);
      if (route && request.activeMediaIndex) ref = { platform: "x", sourceContentId: route.sourceContentId, mediaIndex: request.activeMediaIndex };
    }
    if (!ref) throw localError("invalid_video_url");
    validateRef(ref);
    if (ref.platform === "x") {
      if (!request.clientDurationMs) return { ...context(ref), durationMs: 0, sourceStatus: "play_required", transcriptSource: "browser_whisper", tracks: [], availableLanguages: [], selectedLanguage: "auto" };
      validateDuration(request.clientDurationMs);
      this.inspections.set(contentKey(ref), { durationMs: request.clientDurationMs, title: "X video" });
      return { ...context(ref), durationMs: request.clientDurationMs, sourceStatus: "media_required", transcriptSource: "browser_whisper", tracks: [], availableLanguages: [], selectedLanguage: "auto" };
    }
    const metadata = await this.metadata(ref);
    this.inspections.set(contentKey(ref), { durationMs: metadata.durationMs, title: metadata.title });
    const track = selectYouTubeCaptionTrack(metadata.tracks, request.preferredLanguages?.[0]);
    const tracks = metadata.tracks.map(({ languageCode, languageName, isGenerated, isTranslatable }) => ({ languageCode, languageName, isGenerated, isTranslatable }));
    return { ...context(ref), durationMs: metadata.durationMs, sourceStatus: track ? "ready" : "unavailable", transcriptSource: "youtube_caption", tracks, availableLanguages: tracks, selectedLanguage: track?.languageCode ?? "" };
  }

  async createAnalysis(input: LocalAnalysisCreateInput): Promise<AnalysisCreateResponse> {
    if (this.active) throw localError("analysis_busy");
    const active = { jobId: null as string | null, controller: new AbortController(), done: undefined as Promise<void> | undefined };
    this.active = active;
    try {
      await this.ready;
      validateRef(input.contentRef);
      validateModel(input.provider, input.model);
      const repository = this.dependencies.repository;
      if (!input.force) {
        const latest = await repository.getLatestCompleted(input.contentRef);
        if (latest && latest.sourceLanguage === (input.sourceLanguage ?? latest.sourceLanguage) && latest.targetLanguage === (input.targetLanguage ?? "zh-Hans")) {
          this.active = null;
          return { ...context(input.contentRef), jobId: latest.jobId, cacheHit: true, status: "completed" };
        }
      }
      const metadata = input.contentRef.platform === "youtube" ? await this.metadata(input.contentRef, active.controller.signal) : null;
      const track = metadata ? selectYouTubeCaptionTrack(metadata.tracks, input.sourceLanguage) : null;
      if (metadata && !track) throw localError("captions_unavailable");
      const cached = this.inspections.get(contentKey(input.contentRef));
      const durationMs = metadata?.durationMs ?? input.durationMs ?? cached?.durationMs ?? 0;
      validateDuration(durationMs);
      const jobId = this.dependencies.createId?.() ?? crypto.randomUUID();
      await repository.createTask({
        jobId, contentRef: cleanRef(input.contentRef), videoTitle: (input.title ?? metadata?.title ?? cached?.title ?? "Video").slice(0, 1000),
        durationMs, sourceLanguage: language(track?.languageCode ?? input.sourceLanguage ?? "auto"), targetLanguage: language(input.targetLanguage ?? "zh-Hans"),
        provider: input.provider, model: input.model.trim(), isGenerated: track?.isGenerated ?? null, transcriptReady: false,
        stage: "checking_captions", state: "running", progressCompleted: 0, progressTotal: null, failureCode: null,
      });
      active.jobId = jobId;
      active.done = this.run(jobId, active.controller, track);
      return { ...context(input.contentRef), jobId, cacheHit: false, status: "fetching_transcript" };
    } catch (error) {
      if (this.active === active) this.active = null;
      throw localError(safeCode(error));
    }
  }

  async resume(jobId: string): Promise<AnalysisCreateResponse> {
    if (this.active) throw localError("analysis_busy");
    const active = { jobId, controller: new AbortController(), done: undefined as Promise<void> | undefined };
    this.active = active;
    try {
      await this.ready;
      const task = await this.task(jobId);
      if (task.state !== "failed" && task.state !== "interrupted") throw localError("analysis_not_resumable");
      validateModel(task.provider, task.model);
      validateDuration(task.durationMs);
      await this.dependencies.repository.updateTask(jobId, { state: "running", failureCode: null });
      active.done = this.run(jobId, active.controller);
      return { ...context(task.contentRef), jobId, cacheHit: false, status: "fetching_transcript" };
    } catch (error) {
      if (this.active === active) this.active = null;
      throw localError(safeCode(error));
    }
  }

  async cancel(jobId: string): Promise<void> {
    await this.ready;
    if (this.active?.jobId === jobId) {
      const active = this.active;
      active.controller.abort();
      await active.done;
      return;
    }
    const task = await this.task(jobId);
    if (task.state !== "completed") await this.dependencies.repository.updateTask(jobId, { state: "interrupted", failureCode: "analysis_cancelled" });
  }

  async getStatus(jobId: string): Promise<LocalAnalysisStatus> {
    await this.ready;
    const task = await this.task(jobId);
    const status = task.state === "completed" ? "completed" : task.state === "failed" || task.state === "interrupted" ? "failed"
      : task.stage === "summarizing" ? "analyzing" : task.stage === "checking_captions" ? "fetching_transcript"
        : task.stage === "downloading_model" ? "transcribing" : task.stage;
    return { jobId, status, state: task.state, stage: task.stage, progressCompleted: task.progressCompleted, progressTotal: task.progressTotal, failureCode: task.failureCode ?? null, failureDetail: null };
  }

  async getResult(jobId: string): Promise<AnalysisResult> {
    await this.ready;
    const completed = await this.dependencies.repository.getAnalysis(jobId);
    if (completed) return completed;
    const task = await this.task(jobId);
    const chunks = await this.dependencies.repository.getTranscriptChunks(jobId);
    return { ...resultBase(task), oneLineSummary: "", summaryPoints: [], chapters: [], highlights: [], transcript: chunks.flatMap((chunk) => chunk.segments), partial: true, failureCode: task.failureCode ?? null };
  }

  async getHistory(input: AnalysisHistoryInput = {}): Promise<AnalysisHistoryResponse> {
    await this.ready;
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    if (!input.contentId && !input.videoId) return this.dependencies.repository.getCompletedHistory({ limit, offset });
    const items: AnalysisHistoryResponse["items"] = [];
    for (let pageOffset = 0; ; pageOffset += 100) {
      const page = await this.dependencies.repository.getCompletedHistory({ limit: 100, offset: pageOffset });
      items.push(...page.items.filter((item) => (!input.contentId || item.contentId === input.contentId) && (!input.videoId || item.videoId === input.videoId)));
      if (!page.hasMore || items.length > offset + limit) break;
    }
    return { items: items.slice(offset, offset + limit), hasMore: items.length > offset + limit };
  }

  async getRecoverableTasks(): Promise<LocalAnalysisTask[]> {
    await this.ready;
    return this.dependencies.repository.getRecoverableTasks();
  }

  private async task(jobId: string): Promise<LocalAnalysisTask> {
    const task = await this.dependencies.repository.getTask(jobId);
    if (!task) throw localError("analysis_not_found");
    return task;
  }

  private async metadata(ref: ContentRef, signal?: AbortSignal): Promise<YouTubeMetadata> {
    try {
      const metadata = await this.dependencies.readYouTubeMetadata(`https://www.youtube.com/watch?v=${ref.sourceContentId}`, signal);
      if (metadata.videoId !== ref.sourceContentId) throw localError("video_context_changed");
      validateDuration(metadata.durationMs);
      return metadata;
    } catch (error) { throw localError(safeCode(error)); }
  }

  private async run(jobId: string, controller: AbortController, initialTrack?: YouTubeCaptionTrack | null): Promise<void> {
    const { repository } = this.dependencies;
    const signal = controller.signal;
    try {
      let task = await this.task(jobId);
      let chunks = await repository.getTranscriptChunks(jobId);
      if (!task.transcriptReady) {
        let transcript: TranscriptSegment[];
        if (task.contentRef.platform === "youtube") {
          const track = initialTrack ?? selectYouTubeCaptionTrack((await abortable(this.metadata(task.contentRef, signal), signal)).tracks, task.sourceLanguage);
          if (!track) throw localError("captions_unavailable");
          transcript = await abortable(this.dependencies.fetchCaptionTranscript(track, task.contentRef.sourceContentId, { signal }), signal);
          await repository.updateTask(jobId, { isGenerated: track.isGenerated });
        } else {
          if (!this.dependencies.transcribe) throw localError("local_asr_unavailable");
          await repository.updateTask(jobId, { stage: "transcribing" });
          transcript = await abortable(this.dependencies.transcribe({ jobId, contentRef: cleanRef(task.contentRef), durationMs: task.durationMs, sourceLanguage: task.sourceLanguage }, {
            signal, checkpointSegments: chunks.flatMap((chunk) => chunk.segments),
            onCheckpoint: async (sequence, segments) => { checkAbort(signal); await repository.saveTranscriptChunk(jobId, sequence, normalizeTranscript(segments, task.durationMs)); },
            onProgress: async (stage, completed, total) => {
              checkAbort(signal);
              if (!["downloading_model", "extracting_audio", "transcribing"].includes(stage) || !Number.isSafeInteger(completed) || completed < 0 || total !== null && (!Number.isSafeInteger(total) || total < completed)) return;
              await repository.updateTask(jobId, { stage, progressCompleted: completed, progressTotal: total });
            },
          }), signal);
        }
        checkAbort(signal);
        const batches = batchesOf(normalizeTranscript(transcript, task.durationMs), this.dependencies.translationBatchSize ?? 40);
        // ASR checkpoints may use a different partition; erase only unfinished checkpoints before final partitioning.
        await repository.replaceTranscriptChunks(jobId, batches);
        await repository.updateTask(jobId, { transcriptReady: true });
        task = await this.task(jobId);
        chunks = await repository.getTranscriptChunks(jobId);
      }
      await repository.updateTask(jobId, { stage: "translating", progressCompleted: 0, progressTotal: chunks.length });
      const translated: TranscriptSegment[] = [];
      for (let index = 0; index < chunks.length; index += 1) {
        checkAbort(signal);
        let segments = normalizeTranscript(chunks[index].segments, task.durationMs);
        const pending = segments.filter((segment) => !segment.translated);
        if (pending.length) {
          const additions = task.sourceLanguage === task.targetLanguage ? pending.map((segment) => ({ ...segment, translated: segment.original }))
            : parseTranslationResult(await this.chat(createTranslationMessages(pending, task.sourceLanguage, task.targetLanguage), task, signal), pending);
          const byId = new Map(additions.map((segment) => [segment.id, segment]));
          segments = segments.map((segment) => byId.get(segment.id) ?? segment);
          checkAbort(signal);
          await repository.saveTranscriptChunk(jobId, chunks[index].sequence, segments);
        }
        translated.push(...segments);
        await repository.updateTask(jobId, { progressCompleted: index + 1 });
      }
      const summary = await this.summarize(translated, task, signal);
      const originalText = quoteText(translated.map((segment) => segment.original).join(" "));
      if (summary.highlights.some((highlight) => !originalText.includes(quoteText(highlight.original_excerpt)))) throw localError("analysis_invalid_response");
      checkAbort(signal);
      await repository.completeAnalysis({ ...resultBase(task), oneLineSummary: summary.one_line_summary, summaryPoints: summary.summary_points, chapters: summary.chapters, highlights: summary.highlights, transcript: translated, partial: false, failureCode: null, completedAt: (this.dependencies.now?.() ?? new Date()).toISOString() });
    } catch (error) {
      await repository.updateTask(jobId, { state: signal.aborted ? "interrupted" : "failed", failureCode: signal.aborted ? "analysis_cancelled" : safeCode(error) });
    } finally {
      if (this.active?.controller === controller) this.active = null;
    }
  }

  private async chat(messages: ChatMessage[], task: LocalAnalysisTask, signal: AbortSignal): Promise<string> {
    checkAbort(signal);
    if (messages.reduce((sum, message) => sum + message.content.length, 0) > MAX_CONTEXT_CHARS) throw localError("transcript_segment_too_large");
    const content = await abortable(this.dependencies.completeChat(messages, task.provider!, task.model!, signal), signal);
    if (typeof content !== "string" || content.length > 100_000) throw localError("llm_invalid_response");
    return content;
  }

  private async summarize(transcript: TranscriptSegment[], task: LocalAnalysisTask, signal: AbortSignal): Promise<Summary> {
    const repository = this.dependencies.repository;
    const checkpoints = new Map((await repository.getSummaryCheckpoints(task.jobId)).map((checkpoint) => [`${checkpoint.level}:${checkpoint.sequence}`, checkpoint]));
    const originalText = quoteText(transcript.map((segment) => segment.original).join(" "));
    let batches = batchesOf(transcript, 100);
    let summaries: Summary[] = [];
    let completed = 0;
    let reducing = false;
    let level = 0;
    await repository.updateTask(task.jobId, { stage: "summarizing", progressCompleted: 0, progressTotal: null });
    for (;;) {
      summaries = [];
      for (let sequence = 0; sequence < batches.length; sequence += 1) {
        checkAbort(signal);
        const batch = batches[sequence];
        const messages = createAnalysisMessages(batch, task.targetLanguage, task.durationMs);
        if (reducing) messages[0].content += " The supplied segments contain partial analyses of successive transcript windows. Combine them into one coherent analysis, preserve chronological timestamps, deduplicate chapters, and retain original excerpts verbatim from those analyses. Do not quote the JSON syntax as transcript text.";
        const inputHash = await summaryInputHash(messages, task);
        const checkpoint = checkpoints.get(`${level}:${sequence}`);
        const reusable = checkpoint?.inputHash === inputHash;
        const content = reusable ? JSON.stringify(checkpoint.summary) : await this.chat(messages, task, signal);
        const summary = parseAnalysisResult(content, task.durationMs);
        if (JSON.stringify(JSON.stringify(summary)).length > MAX_SUMMARY_CHARS) throw localError("analysis_invalid_response");
        if (summary.highlights.some((highlight) => !originalText.includes(quoteText(highlight.original_excerpt)))) throw localError("analysis_invalid_response");
        checkAbort(signal);
        if (!reusable) await repository.saveSummaryCheckpoint({ taskId: task.jobId, level, sequence, inputHash, summary });
        summaries.push(summary);
        await repository.updateTask(task.jobId, { progressCompleted: ++completed });
      }
      if (summaries.length === 1) return summaries[0];
      reducing = true;
      level += 1;
      batches = batchesOf(summaries.map((summary, index) => ({ id: `summary-${index}`, startMs: summary.chapters[0].start_ms, durationMs: summary.chapters.at(-1)!.end_ms - summary.chapters[0].start_ms, original: JSON.stringify(summary), translated: null })), 100);
      // Each summary is <=7k; at least two fit in 18k, so every reduction shrinks.
    }
  }
}

function resultBase(task: LocalAnalysisTask) {
  return { ...context(task.contentRef), jobId: task.jobId, videoTitle: task.videoTitle, durationMs: task.durationMs, sourceLanguage: task.sourceLanguage, targetLanguage: task.targetLanguage, isGenerated: task.isGenerated ?? null, modelName: task.model ?? "", modelVersion: "local-v1" };
}
function context(ref: ContentRef): ContentContext { return { contentRef: cleanRef(ref), contentId: contentKey(ref), videoId: ref.platform === "youtube" ? ref.sourceContentId : null }; }
function cleanRef(ref: ContentRef): ContentRef { return { platform: ref.platform, sourceContentId: ref.sourceContentId, mediaIndex: ref.mediaIndex }; }
function validateRef(ref: ContentRef): void {
  if (!ref || !["youtube", "x"].includes(ref.platform) || !Number.isSafeInteger(ref.mediaIndex) || ref.mediaIndex < 1 || ref.mediaIndex > 2_147_483_647
    || typeof ref.sourceContentId !== "string" || !(ref.platform === "youtube" ? /^[A-Za-z0-9_-]{11}$/ : /^[1-9][0-9]{0,19}$/).test(ref.sourceContentId)) throw localError("invalid_video_url");
}
function validateDuration(durationMs: number): void {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw localError("video_metadata_unavailable");
  if (durationMs > MAX_VIDEO_DURATION_MS) throw localError("video_too_long");
}
function validateModel(provider: unknown, model: unknown): void {
  if (!LLM_PROVIDER_OPTIONS.some((option) => option.provider === provider) || typeof model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model.trim())) throw localError("llm_invalid_config");
}
function language(value: string): string { if (!/^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(value)) throw localError("llm_invalid_request"); return value; }
function normalizeTranscript(segments: TranscriptSegment[], durationMs: number): TranscriptSegment[] {
  if (!Array.isArray(segments) || segments.length === 0) throw localError("transcript_empty");
  const ids = new Set<string>();
  let previous = -1;
  return segments.map((segment) => {
    if (!segment || typeof segment.id !== "string" || !segment.id || ids.has(segment.id) || !Number.isSafeInteger(segment.startMs) || segment.startMs < previous || segment.startMs >= durationMs
      || !Number.isSafeInteger(segment.durationMs) || segment.durationMs < 0 || typeof segment.original !== "string" || !segment.original.trim()
      || segment.translated != null && typeof segment.translated !== "string") throw localError("transcript_invalid_segment");
    ids.add(segment.id); previous = segment.startMs;
    return { id: segment.id, startMs: segment.startMs, durationMs: Math.min(segment.durationMs, durationMs - segment.startMs), original: segment.original.trim(), translated: segment.translated?.trim() || null };
  });
}
function batchesOf(segments: TranscriptSegment[], maxCount: number): TranscriptSegment[][] {
  const batches: TranscriptSegment[][] = [];
  let batch: TranscriptSegment[] = [];
  let size = 0;
  for (const segment of segments) {
    const length = JSON.stringify(segment).length + 100;
    if (length > MAX_BATCH_CHARS) throw localError("transcript_segment_too_large");
    if (batch.length && (batch.length >= Math.max(1, maxCount) || size + length > MAX_BATCH_CHARS)) { batches.push(batch); batch = []; size = 0; }
    batch.push(segment); size += length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
function safeCode(error: unknown): string {
  const raw = error && typeof error === "object" && "code" in error ? String(error.code) : error instanceof Error ? error.message.split(":")[0] : "";
  return SAFE_CODES.has(raw) ? raw : "analysis_failed";
}
function checkAbort(signal: AbortSignal): void { if (signal.aborted) throw localError("analysis_cancelled"); }
function quoteText(value: string): string { return value.normalize("NFKC").replace(/\s+/gu, " ").trim(); }
async function summaryInputHash(messages: ChatMessage[], task: LocalAnalysisTask): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, provider: task.provider, model: task.model, messages }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(localError("analysis_cancelled"));
    if (signal.aborted) { promise.catch(() => undefined); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
