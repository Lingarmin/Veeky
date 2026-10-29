import type { AnalysisHistoryItem, ContentRef, Highlight, TimedSummary, TranscriptSegment } from "../shared/types";
import { contentKey, parseContentRef } from "../shared/content";
import { getLocalAnalysisRepository, type LocalAnalysisRecord, type LocalAnalysisRepository } from "./repository";

export interface LegacyImportCounts {
  pages: number;
  scanned: number;
  imported: number;
  skipped: number;
  rejected: number;
}

export interface LegacyImportOptions {
  confirmed: boolean;
  apiOrigin: string;
  signal?: AbortSignal;
  repository?: LocalAnalysisRepository;
  onProgress?: (counts: LegacyImportCounts) => void;
}

const IDENTITY_KEY = "veeky.installationIdentity.v1";
const PAGE_SIZE = 50;
const MAX_PAGES = 100;
const MAX_READS = 1_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_DURATION_MS = 4 * 60 * 60 * 1000;
const HISTORY_FIELDS = ["jobId", "contentId", "contentRef", "videoId", "videoTitle", "durationMs", "sourceLanguage", "targetLanguage", "completedAt", "modelName", "modelVersion"];
const RESULT_FIELDS = [...HISTORY_FIELDS.filter((field) => field !== "completedAt"), "isGenerated", "oneLineSummary", "summaryPoints", "chapters", "highlights", "transcript", "partial", "failureCode"];

class InvalidLegacyData extends Error {
  constructor() { super("Invalid legacy history data"); }
}

/** Explicit migration only: never creates an identity, registers it, or changes the old service. */
export async function importLegacyHistory(options: LegacyImportOptions): Promise<LegacyImportCounts> {
  if (options.confirmed !== true) throw new Error("Explicit confirmation is required for legacy import");
  if (!["http://127.0.0.1:8000", "http://localhost:8000"].includes(options.apiOrigin)) throw new Error("Legacy import origin is not allowed");
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Legacy import cancelled"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  const totalTimer = setTimeout(() => controller.abort(new Error("Legacy import time limit reached")), 10 * 60 * 1000);
  const counts: LegacyImportCounts = { pages: 0, scanned: 0, imported: 0, skipped: 0, rejected: 0 };
  const report = () => options.onProgress?.({ ...counts });
  try {
    const stored = await abortable(chrome.storage.local.get(IDENTITY_KEY), controller.signal);
    const identity: unknown = stored[IDENTITY_KEY];
    if (!identity || typeof identity !== "object" || Array.isArray(identity)) throw new Error("Existing legacy installation identity is required");
    const { installationId, installationToken } = identity as Record<string, unknown>;
    if (typeof installationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(installationId)
      || typeof installationToken !== "string" || !/^[A-Za-z0-9_-]{43,256}$/.test(installationToken)
      || installationId.includes(installationToken)) throw new Error("Existing legacy installation identity is invalid");
    const repository = options.repository ?? getLocalAnalysisRepository();
    let reads = 0;
    let totalBytes = 0;
    const read = async (path: string): Promise<unknown> => {
      controller.signal.throwIfAborted();
      if (++reads > MAX_READS) throw new Error("Legacy import read limit reached");
      const requestController = new AbortController();
      const forward = () => requestController.abort(controller.signal.reason);
      controller.signal.addEventListener("abort", forward, { once: true });
      const timer = setTimeout(() => requestController.abort(new Error("Legacy import request timed out")), 30_000);
      try {
        const response = await abortable(fetch(`${options.apiOrigin}${path}`, {
          method: "GET", credentials: "omit", redirect: "error", cache: "no-store", signal: requestController.signal,
          headers: { Accept: "application/json", Authorization: `Bearer ${installationToken}`, "X-Veeky-Installation-Id": installationId },
        }), requestController.signal);
        if (!response.ok || response.redirected) {
          void response.body?.cancel().catch(() => {});
          throw new Error(`Legacy history request failed (${response.status})`);
        }
        if (Number(response.headers.get("Content-Length")) > MAX_RESPONSE_BYTES) {
          void response.body?.cancel().catch(() => {});
          throw new Error("Legacy response is too large");
        }
        if (!response.body) throw new InvalidLegacyData();
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let bytes = 0;
        let text = "";
        try {
          while (true) {
            const chunk = await abortable(reader.read(), requestController.signal);
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            totalBytes += chunk.value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES || totalBytes > MAX_TOTAL_BYTES) throw new Error("Legacy response size limit reached");
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
          try { return JSON.parse(text) as unknown; } catch { throw new InvalidLegacyData(); }
        } finally {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", forward);
      }
    };

    const visited = new Set<string>();
    let offset = 0;
    while (counts.pages < MAX_PAGES) {
      const page = object(await read(`/v1/analyses/history?limit=${PAGE_SIZE}&offset=${offset}`), ["items", "hasMore"]);
      const items = array(page.items, PAGE_SIZE);
      if (typeof page.hasMore !== "boolean" || page.hasMore && items.length === 0) throw new InvalidLegacyData();
      counts.pages++;
      for (const rawItem of items) {
        controller.signal.throwIfAborted();
        counts.scanned++;
        let history: AnalysisHistoryItem;
        try { history = parseHistory(rawItem); } catch (error) {
          if (!(error instanceof InvalidLegacyData)) throw error;
          counts.rejected++;
          report();
          continue;
        }
        const sourceKey = JSON.stringify([options.apiOrigin, installationId, history.jobId]);
        const localJobId = `import:${encodeURIComponent(sourceKey)}`;
        if (visited.has(sourceKey) || await repository.getAnalysis(localJobId)) {
          counts.skipped++;
          report();
          continue;
        }
        visited.add(sourceKey);
        let record: LocalAnalysisRecord;
        try {
          record = parseResult(await read(`/v1/analyses/${encodeURIComponent(history.jobId)}/result`), history);
          if (JSON.stringify(record).includes(installationToken)) throw new InvalidLegacyData();
        } catch (error) {
          if (!(error instanceof InvalidLegacyData)) throw error;
          counts.rejected++;
          report();
          continue;
        }
        controller.signal.throwIfAborted();
        await repository.importCompletedIfAbsent(record, sourceKey);
        counts.imported++;
        report();
      }
      report();
      if (!page.hasMore) return { ...counts };
      offset += items.length;
    }
    throw new Error("Legacy import page limit reached");
  } finally {
    clearTimeout(totalTimer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) throw new InvalidLegacyData();
  return value as Record<string, unknown>;
}

function text(value: unknown, max = 20_000, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || !allowEmpty && !value.trim()) throw new InvalidLegacyData();
  return value;
}

function integer(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw new InvalidLegacyData();
  return value;
}

function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new InvalidLegacyData();
  return value;
}

function reference(value: unknown): ContentRef {
  const ref = object(value, ["platform", "sourceContentId", "mediaIndex"]);
  if (ref.platform !== "youtube" && ref.platform !== "x") throw new InvalidLegacyData();
  const sourceContentId = text(ref.sourceContentId, 128);
  const mediaIndex = integer(ref.mediaIndex, Number.MAX_SAFE_INTEGER);
  const parsed = parseContentRef(ref.platform === "youtube"
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(sourceContentId)}`
    : `https://x.com/i/status/${encodeURIComponent(sourceContentId)}/video/${mediaIndex}`);
  if (!parsed || parsed.sourceContentId !== sourceContentId || parsed.mediaIndex !== mediaIndex) throw new InvalidLegacyData();
  return parsed;
}

function parseHistory(value: unknown): AnalysisHistoryItem {
  const row = object(value, HISTORY_FIELDS);
  const contentRef = reference(row.contentRef);
  const jobId = text(row.jobId, 128);
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) throw new InvalidLegacyData();
  const videoId = row.videoId === null ? null : text(row.videoId, 128);
  if (videoId !== (contentRef.platform === "youtube" ? contentRef.sourceContentId : null)) throw new InvalidLegacyData();
  const completedAt = text(row.completedAt, 64);
  if (!Number.isFinite(Date.parse(completedAt))) throw new InvalidLegacyData();
  return { jobId, contentId: text(row.contentId, 256), contentRef, videoId, videoTitle: text(row.videoTitle, 10_000),
    durationMs: integer(row.durationMs, MAX_DURATION_MS), sourceLanguage: text(row.sourceLanguage, 64), targetLanguage: text(row.targetLanguage, 64),
    completedAt, modelName: text(row.modelName, 256), modelVersion: text(row.modelVersion, 256) };
}

function timed(value: unknown, durationMs: number, highlight = false): TimedSummary | Highlight {
  const row = object(value, highlight ? ["start_ms", "end_ms", "title", "summary", "original_excerpt", "translated_excerpt"] : ["start_ms", "end_ms", "title", "summary"]);
  const start_ms = integer(row.start_ms, durationMs);
  const end_ms = integer(row.end_ms, durationMs);
  if (end_ms <= start_ms) throw new InvalidLegacyData();
  const base = { start_ms, end_ms, title: text(row.title), summary: text(row.summary) };
  return highlight ? { ...base, original_excerpt: text(row.original_excerpt), translated_excerpt: text(row.translated_excerpt) } : base;
}

function segment(value: unknown, durationMs: number): TranscriptSegment {
  const row = object(value, ["id", "startMs", "durationMs", "original", "translated"]);
  const startMs = integer(row.startMs, durationMs);
  const segmentDuration = integer(row.durationMs, durationMs);
  if (startMs + segmentDuration > durationMs) throw new InvalidLegacyData();
  return { id: text(row.id, 256), startMs, durationMs: segmentDuration, original: text(row.original), translated: row.translated === null ? null : text(row.translated, 20_000, true) };
}

function parseResult(value: unknown, history: AnalysisHistoryItem): LocalAnalysisRecord {
  const row = object(value, RESULT_FIELDS);
  const ref = reference(row.contentRef);
  if (row.jobId !== history.jobId || row.contentId !== history.contentId || contentKey(ref) !== contentKey(history.contentRef)
    || row.videoId !== history.videoId || row.durationMs !== history.durationMs || row.sourceLanguage !== history.sourceLanguage
    || row.targetLanguage !== history.targetLanguage || row.partial !== false || row.failureCode !== null
    || row.isGenerated !== null && typeof row.isGenerated !== "boolean") throw new InvalidLegacyData();
  const durationMs = integer(row.durationMs, MAX_DURATION_MS);
  const transcript = array(row.transcript, 30_000).map((entry) => segment(entry, durationMs));
  if (new Set(transcript.map((entry) => entry.id)).size !== transcript.length) throw new InvalidLegacyData();
  return { jobId: history.jobId, contentId: contentKey(ref), contentRef: ref, videoId: history.videoId,
    videoTitle: text(row.videoTitle, 10_000), durationMs, sourceLanguage: history.sourceLanguage, targetLanguage: history.targetLanguage,
    isGenerated: row.isGenerated as boolean | null, oneLineSummary: text(row.oneLineSummary),
    summaryPoints: array(row.summaryPoints, 100).map((entry) => text(entry)),
    chapters: array(row.chapters, 1_000).map((entry) => timed(entry, durationMs)),
    highlights: array(row.highlights, 1_000).map((entry) => timed(entry, durationMs, true) as Highlight), transcript,
    partial: false, failureCode: null, modelName: text(row.modelName, 256), modelVersion: text(row.modelVersion, 256), completedAt: history.completedAt };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Legacy import cancelled"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
