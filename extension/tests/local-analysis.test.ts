import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { LocalAnalysisEngine, type LocalAnalysisDependencies } from "../src/local/analysis";
import { LocalAnalysisRepository } from "../src/local/repository";
import type { ChatMessage } from "../src/local/llm-client";
import type { ContentRef, TranscriptSegment } from "../src/shared/types";
import { LLM_PROVIDER_OPTIONS } from "../src/sidepanel/llm";

beforeAll(() => vi.stubGlobal("crypto", webcrypto));
afterAll(() => vi.unstubAllGlobals());

const ref: ContentRef = { platform: "youtube", sourceContentId: "dQw4w9WgXcQ", mediaIndex: 1 };
const input = { contentRef: ref, sourceLanguage: "en", targetLanguage: "zh-Hans", provider: "kimi" as const, model: "kimi-k2" };
const segment = (index: number): TranscriptSegment => ({ id: String(index), startMs: index * 1000, durationMs: 1000, original: `Sentence ${index}`, translated: null });
const summary = JSON.stringify({ one_line_summary: "概述", summary_points: ["要点一", "要点二", "要点三"], chapters: [{ start_ms: 0, end_ms: 1000, title: "主题", summary: "讲解了具体事实" }], highlights: [] });

function harness(overrides: Partial<LocalAnalysisDependencies> = {}) {
  const repository = new LocalAnalysisRepository({ indexedDB: new IDBFactory() });
  const calls: ChatMessage[][] = [];
  const dependencies: LocalAnalysisDependencies = {
    repository,
    readYouTubeMetadata: async () => ({ videoId: ref.sourceContentId, title: "Example", durationMs: 120_000, tracks: [{ baseUrl: `https://www.youtube.com/api/timedtext?v=${ref.sourceContentId}`, languageCode: "en", languageName: "English", isGenerated: false, isTranslatable: true }] }),
    fetchCaptionTranscript: async () => [segment(0), segment(1)],
    completeChat: async (messages) => {
      calls.push(messages);
      const payload = JSON.parse(messages[1].content);
      if (payload.source_language) return JSON.stringify({ translations: payload.segments.map((s: { segment_id: string }) => ({ segment_id: s.segment_id, text: `翻译 ${s.segment_id}` })) });
      return summary;
    },
    ...overrides,
  };
  return { engine: new LocalAnalysisEngine(dependencies), repository, calls, dependencies };
}

async function finished(engine: LocalAnalysisEngine, jobId: string) {
  await vi.waitFor(async () => expect(["completed", "failed"]).toContain((await engine.getStatus(jobId)).status));
  return engine.getStatus(jobId);
}

describe("local analysis engine", () => {
  it("labels X inspection as browser Whisper before and after media metadata is available", async () => {
    const { engine } = harness();
    expect(await engine.inspect("https://x.com/person/status/1234/video/1")).toMatchObject({ transcriptSource: "browser_whisper", sourceStatus: "play_required" });
    expect(await engine.inspect({ url: "https://x.com/person/status/1234/video/1", clientDurationMs: 1000 })).toMatchObject({ transcriptSource: "browser_whisper", sourceStatus: "media_required" });
  });

  it.each(["map", "reduce"])("reuses successful %s checkpoints after failure and engine restart", async (phase) => {
    let fail = true;
    let completedInPhase = 0;
    const requests = new Map<string, number>();
    let firstSuccessful = "";
    const largeSummary = JSON.stringify({ ...JSON.parse(summary), one_line_summary: "Fact. ".repeat(600) });
    const { engine, repository, dependencies } = harness({
      fetchCaptionTranscript: async () => Array.from({ length: 120 }, (_, i) => ({ ...segment(i), original: "Long factual sentence. ".repeat(50) })),
      completeChat: async (messages) => {
        const payload = JSON.parse(messages[1].content);
        if (payload.source_language) return JSON.stringify({ translations: payload.segments.map((s: { segment_id: string }) => ({ segment_id: s.segment_id, text: `翻译 ${s.segment_id}` })) });
        const key = JSON.stringify(messages);
        requests.set(key, (requests.get(key) ?? 0) + 1);
        const currentPhase = messages[0].content.includes("partial analyses") ? "reduce" : "map";
        if (currentPhase === phase) {
          if (fail && completedInPhase === 1) throw Object.assign(new Error("temporary"), { code: "llm_unavailable" });
          if (!firstSuccessful) firstSuccessful = key;
          completedInPhase += 1;
        }
        return largeSummary;
      },
    });
    const created = await engine.createAnalysis(input);
    expect(await finished(engine, created.jobId)).toMatchObject({ status: "failed", failureCode: "llm_unavailable" });
    expect((await repository.getSummaryCheckpoints(created.jobId)).some((checkpoint) => checkpoint.level === (phase === "map" ? 0 : 1))).toBe(true);
    fail = false;
    const restarted = new LocalAnalysisEngine(dependencies);
    await restarted.resume(created.jobId);
    expect(await finished(restarted, created.jobId)).toMatchObject({ status: "completed" });
    expect(requests.get(firstSuccessful)).toBe(1);
    expect((await restarted.getHistory()).items).toHaveLength(1);
  });

  it.each(LLM_PROVIDER_OPTIONS)("supports $provider and restores its nonsecret reference on explicit resume", async ({ provider, defaultModel }) => {
    let fail = true;
    const seen: Array<{ provider: string; model: string }> = [];
    const { engine, repository } = harness({ completeChat: async (messages, requestedProvider, model) => {
      seen.push({ provider: requestedProvider, model });
      if (fail) throw Object.assign(new Error("temporary"), { code: "llm_unavailable" });
      const payload = JSON.parse(messages[1].content);
      return payload.source_language ? JSON.stringify({ translations: payload.segments.map((s: { segment_id: string }) => ({ segment_id: s.segment_id, text: `翻译 ${s.segment_id}` })) }) : summary;
    } });
    const created = await engine.createAnalysis({ ...input, provider, model: defaultModel });
    expect(await finished(engine, created.jobId)).toMatchObject({ failureCode: "llm_unavailable" });
    expect(await repository.getTask(created.jobId)).toMatchObject({ provider, model: defaultModel });
    fail = false;
    await engine.resume(created.jobId);
    expect(await finished(engine, created.jobId)).toMatchObject({ status: "completed" });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((reference) => reference.provider === provider && reference.model === defaultModel)).toBe(true);
  });

  it("inspects captions, translates, and adds immutable completed history for each reanalysis", async () => {
    const { engine, repository, calls } = harness();
    const inspected = await engine.inspect(`https://youtu.be/${ref.sourceContentId}`);
    expect(inspected).toMatchObject({ sourceStatus: "ready", selectedLanguage: "en", durationMs: 120_000 });
    expect(JSON.stringify(inspected)).not.toContain("timedtext");
    const first = await engine.createAnalysis(input);
    expect(await finished(engine, first.jobId)).toMatchObject({ status: "completed" });
    expect((await engine.getResult(first.jobId)).transcript.map((s) => s.translated)).toEqual(["翻译 0", "翻译 1"]);
    expect(calls).toHaveLength(2);
    const second = await engine.createAnalysis({ ...input, force: true });
    await finished(engine, second.jobId);
    expect(second.jobId).not.toBe(first.jobId);
    expect((await engine.getHistory()).items).toHaveLength(2);
    expect(await repository.getLatestCompleted(ref)).toMatchObject({ jobId: second.jobId });
    const task = await repository.getTask(first.jobId);
    expect(task).toMatchObject({ provider: "kimi", model: "kimi-k2" });
    expect(JSON.stringify(task)).not.toMatch(/apiKey|timedtext|https:/);
  });

  it("keeps originals and completed translation checkpoints after failure; explicit resume skips them", async () => {
    let fail = true;
    const translatedIds: string[] = [];
    const { engine, repository } = harness({
      translationBatchSize: 1,
      completeChat: async (messages) => {
        const data = JSON.parse(messages[1].content);
        if (!data.source_language) return summary;
        const id = data.segments[0].segment_id;
        translatedIds.push(id);
        if (id === "1" && fail) throw new Error("secret-token https://signed-media.example");
        return JSON.stringify({ translations: [{ segment_id: id, text: `翻译 ${id}` }] });
      },
    });
    const created = await engine.createAnalysis(input);
    expect(await finished(engine, created.jobId)).toMatchObject({ status: "failed", failureCode: "analysis_failed" });
    expect((await engine.getResult(created.jobId)).transcript).toEqual([{ ...segment(0), translated: "翻译 0" }, segment(1)]);
    expect((await engine.getHistory()).items).toHaveLength(0);
    expect(JSON.stringify(await repository.getTask(created.jobId))).not.toContain("secret-token");
    fail = false;
    await engine.resume(created.jobId);
    await finished(engine, created.jobId);
    expect(translatedIds).toEqual(["0", "1", "1"]);
    expect((await engine.getHistory()).items).toHaveLength(1);
  });

  it("cancels an active request, keeps checkpoints, and enforces one active analysis", async () => {
    let signal: AbortSignal | undefined;
    const { engine } = harness({ completeChat: async (_messages, _provider, _model, requestSignal) => {
      signal = requestSignal;
      return new Promise<string>(() => undefined);
    } });
    const created = await engine.createAnalysis(input);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await expect(engine.createAnalysis(input)).rejects.toMatchObject({ code: "analysis_busy" });
    await engine.cancel(created.jobId);
    expect(signal?.aborted).toBe(true);
    expect(await engine.getStatus(created.jobId)).toMatchObject({ status: "failed", state: "interrupted", failureCode: "analysis_cancelled" });
    expect((await engine.getResult(created.jobId)).transcript).toHaveLength(2);
  });

  it("marks running tasks interrupted at restart and never resumes provider calls automatically", async () => {
    const { repository, dependencies } = harness();
    await repository.createTask({ ...input, jobId: "interrupted", videoTitle: "Example", durationMs: 1000, stage: "translating", state: "running", progressCompleted: 0, progressTotal: 1, transcriptReady: true });
    await repository.saveTranscriptChunk("interrupted", 0, [segment(0)]);
    const completeChat = vi.fn(dependencies.completeChat);
    const engine = new LocalAnalysisEngine({ ...dependencies, completeChat });
    expect(await engine.getStatus("interrupted")).toMatchObject({ state: "interrupted" });
    expect(completeChat).not.toHaveBeenCalled();
    await engine.resume("interrupted");
    expect(await finished(engine, "interrupted")).toMatchObject({ status: "completed" });
  });

  it("rejects more than four hours before task creation or inference; permits the boundary for X", async () => {
    const { engine, repository } = harness({ transcribe: async () => [segment(0)] });
    const x = { ...input, contentRef: { platform: "x" as const, sourceContentId: "1234", mediaIndex: 1 }, durationMs: 14_400_001 };
    await expect(engine.createAnalysis(x)).rejects.toMatchObject({ code: "video_too_long" });
    expect(await repository.getRecoverableTasks()).toEqual([]);
    const created = await engine.createAnalysis({ ...x, durationMs: 14_400_000 });
    expect(await finished(engine, created.jobId)).toMatchObject({ status: "completed" });
  });

  it("bounds provider contexts and reduces map summaries for long transcripts", async () => {
    const { engine, calls } = harness({ fetchCaptionTranscript: async () => Array.from({ length: 120 }, (_, i) => ({ ...segment(i), original: "Long factual sentence. ".repeat(50) })) });
    const created = await engine.createAnalysis(input);
    expect(await finished(engine, created.jobId)).toMatchObject({ status: "completed" });
    expect(calls.filter((messages) => !JSON.parse(messages[1].content).source_language).length).toBeGreaterThan(2);
    expect(Math.max(...calls.map((messages) => messages.reduce((sum, message) => sum + message.content.length, 0)))).toBeLessThanOrEqual(24_000);
  });

  it("refuses captions that do not exist without starting inference", async () => {
    const { engine, calls } = harness({ readYouTubeMetadata: async () => ({ videoId: ref.sourceContentId, title: "No captions", durationMs: 1000, tracks: [] }) });
    expect(await engine.inspect(`https://youtu.be/${ref.sourceContentId}`)).toMatchObject({ sourceStatus: "unavailable" });
    await expect(engine.createAnalysis(input)).rejects.toMatchObject({ code: "captions_unavailable" });
    expect(calls).toEqual([]);
  });

  it("does not save malformed translation or summaries as completed history", async () => {
    const { engine } = harness({ completeChat: async () => '{"translations":[{"segment_id":"wrong","text":"wrong"}]}' });
    const created = await engine.createAnalysis(input);
    expect(await finished(engine, created.jobId)).toMatchObject({ failureCode: "translation_invalid_response" });
    expect((await engine.getResult(created.jobId)).transcript.every((segment) => segment.translated === null)).toBe(true);
    expect((await engine.getHistory()).items).toEqual([]);
  });

  it("passes partial ASR checkpoints to explicit resume and replaces stale partitions", async () => {
    let first = true;
    let resumed: TranscriptSegment[] = [];
    const { engine, repository } = harness({ transcribe: async (_request, options) => {
      if (first) {
        await options.onCheckpoint(8, [segment(0)]);
        throw Object.assign(new Error("failed"), { code: "local_asr_failed" });
      }
      resumed = options.checkpointSegments;
      return [segment(0), segment(1)];
    } });
    const created = await engine.createAnalysis({ ...input, contentRef: { platform: "x", sourceContentId: "1234", mediaIndex: 1 }, durationMs: 3000 });
    expect(await finished(engine, created.jobId)).toMatchObject({ failureCode: "local_asr_failed" });
    first = false;
    await engine.resume(created.jobId);
    expect(await finished(engine, created.jobId)).toMatchObject({ status: "completed" });
    expect(resumed).toEqual([segment(0)]);
    expect(await repository.getTranscriptChunks(created.jobId)).toHaveLength(0);
    expect((await engine.getResult(created.jobId)).transcript).toHaveLength(2);
  });

  it("rejects fabricated highlight excerpts before persisting a completed result", async () => {
    const { engine } = harness({ completeChat: async (messages) => {
      const payload = JSON.parse(messages[1].content);
      if (payload.source_language) return JSON.stringify({ translations: payload.segments.map((s: { segment_id: string }) => ({ segment_id: s.segment_id, text: "翻译" })) });
      return JSON.stringify({ ...JSON.parse(summary), highlights: [{ start_ms: 0, end_ms: 1000, title: "Excerpt", summary: "A claim", original_excerpt: "Fabricated words", translated_excerpt: "编造" }] });
    } });
    const created = await engine.createAnalysis(input);
    expect(await finished(engine, created.jobId)).toMatchObject({ status: "failed", failureCode: "analysis_invalid_response" });
    expect((await engine.getHistory()).items).toEqual([]);
  });

  it("rejects summary payloads whose escaped representation prevents bounded reduction", async () => {
    const { engine } = harness({ completeChat: async (messages) => {
      const payload = JSON.parse(messages[1].content);
      if (payload.source_language) return JSON.stringify({ translations: payload.segments.map((s: { segment_id: string }) => ({ segment_id: s.segment_id, text: "翻译" })) });
      return JSON.stringify({ ...JSON.parse(summary), one_line_summary: '"'.repeat(3200) });
    } });
    const created = await engine.createAnalysis(input);
    expect(await finished(engine, created.jobId)).toMatchObject({ status: "failed", failureCode: "analysis_invalid_response" });
  });

  it.each(["model_manifest_invalid", "model_integrity_failed", "media_url_expired", "media_fetch_failed", "media_too_large", "audio_codec_unsupported", "audio_decode_failed", "unsupported_media_candidate"])("preserves the safe X limitation code %s", async (code) => {
    const { engine } = harness({ transcribe: async () => { throw Object.assign(new Error("signed URL must stay private"), { code }); } });
    const created = await engine.createAnalysis({ ...input, contentRef: { platform: "x", sourceContentId: "1234", mediaIndex: 1 }, durationMs: 3000 });
    expect(await finished(engine, created.jobId)).toMatchObject({ status: "failed", failureCode: code, failureDetail: null });
  });
});
