import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import type { ContentRef, TranscriptSegment } from "../src/shared/types";
import { LocalAnalysisRepository, type LocalAnalysisRecord, type LocalAnalysisTaskInput } from "../src/local/repository";

const contentRef: ContentRef = {
  platform: "youtube",
  sourceContentId: "abc123",
  mediaIndex: 0,
};

function result(jobId: string, completedAt = "2026-10-27T10:00:00.000Z"): LocalAnalysisRecord {
  return {
    jobId,
    contentId: "youtube:abc123:0",
    contentRef,
    videoId: "abc123",
    videoTitle: "A sample video",
    durationMs: 120_000,
    sourceLanguage: "en",
    targetLanguage: "zh-Hans",
    isGenerated: false,
    oneLineSummary: "A local result",
    summaryPoints: ["Point one"],
    chapters: [],
    highlights: [],
    transcript: [segment("one")],
    partial: false,
    failureCode: null,
    modelName: "kimi-test",
    modelVersion: "test-v1",
    completedAt,
  } as LocalAnalysisRecord;
}

function segment(id: string): TranscriptSegment {
  return { id, startMs: 0, durationMs: 1000, original: "hello", translated: "你好" };
}

function summaryValue() {
  return { one_line_summary: "Overview", summary_points: ["First", "Second", "Third"], chapters: [{ start_ms: 0, end_ms: 1000, title: "Topic", summary: "Specific details" }], highlights: [] };
}

function taskInput(overrides: Partial<LocalAnalysisTaskInput> = {}): LocalAnalysisTaskInput {
  return {
    jobId: "task-1",
    contentRef,
    videoTitle: "A sample video",
    durationMs: 120_000,
    sourceLanguage: "en",
    targetLanguage: "zh-Hans",
    stage: "translating",
    state: "running",
    progressCompleted: 1,
    progressTotal: 2,
    ...overrides,
  };
}

describe("LocalAnalysisRepository", () => {
  let factory: IDBFactory;
  let repository: LocalAnalysisRepository;

  beforeEach(async () => {
    factory = new IDBFactory();
    repository = new LocalAnalysisRepository({ indexedDB: factory, databaseName: "veeky-test" });
    await repository.open();
  });

  it.each(["mediaUrl", "mediaBytes", "unexpected"])("rejects undeclared %s fields on every durable input", async (field) => {
    const extra = { [field]: field === "mediaBytes" ? new Uint8Array([1, 2, 3]) : "https://video.twimg.com/private?token=secret" };
    await expect(repository.createTask({ ...taskInput(), ...extra })).rejects.toThrow(/unknown.*field/i);
    expect(await repository.getTask("task-1")).toBeNull();
    await repository.createTask(taskInput());
    await expect(repository.updateTask("task-1", { state: "failed", ...extra })).rejects.toThrow(/unknown.*field/i);
    await expect(repository.saveTranscriptChunk("task-1", 0, [{ ...segment("bad"), ...extra }])).rejects.toThrow(/unknown.*field/i);
    await expect(repository.replaceTranscriptChunks("task-1", [[{ ...segment("bad"), ...extra }]])).rejects.toThrow(/unknown.*field/i);
    await expect(repository.completeAnalysis({ ...result("bad"), ...extra })).rejects.toThrow(/unknown.*field/i);
    await expect(repository.importCompletedIfAbsent({ ...result("bad"), ...extra }, "legacy-bad")).rejects.toThrow(/unknown.*field/i);
    await expect(repository.saveSummaryCheckpoint({ taskId: "task-1", level: 0, sequence: 0, inputHash: "a".repeat(64), summary: summaryValue(), ...extra })).rejects.toThrow(/unknown.*field/i);
    expect(await repository.getTranscriptChunks("task-1")).toEqual([]);
    expect(await repository.getSummaryCheckpoints("task-1")).toEqual([]);
    expect(await repository.getAnalysis("bad")).toBeNull();
    expect((await repository.getTask("task-1"))?.state).toBe("running");
  });

  it("rejects undeclared nested fields and binary values disguised as transcript text", async () => {
    await expect(repository.createTask({ ...taskInput(), contentRef: { ...contentRef, mediaUrl: "https://video.twimg.com/private" } } as LocalAnalysisTaskInput)).rejects.toThrow(/unknown.*field/i);
    await repository.createTask(taskInput());
    await expect(repository.saveTranscriptChunk("task-1", 0, [{ ...segment("bad"), original: new Uint8Array([1, 2]) } as unknown as TranscriptSegment])).rejects.toThrow();
    await expect(repository.completeAnalysis({ ...result("bad"), chapters: [{ start_ms: 0, end_ms: 1000, title: "Topic", summary: "Details", mediaBytes: [1, 2] }] } as unknown as LocalAnalysisRecord)).rejects.toThrow(/unknown.*field/i);
  });

  it("persists validated summary checkpoints across repository instances", async () => {
    await repository.createTask(taskInput());
    await repository.saveSummaryCheckpoint({ taskId: "task-1", level: 0, sequence: 0, inputHash: "a".repeat(64), summary: summaryValue() });
    const reopened = new LocalAnalysisRepository({ indexedDB: factory, databaseName: "veeky-test" });
    expect(await reopened.getSummaryCheckpoints("task-1")).toEqual([expect.objectContaining({ taskId: "task-1", level: 0, sequence: 0, inputHash: "a".repeat(64), summary: summaryValue() })]);
    await expect(repository.saveSummaryCheckpoint({ taskId: "task-1", level: 1, sequence: 0, inputHash: "a".repeat(64), summary: { ...summaryValue(), chapters: [{ start_ms: 0, end_ms: 999_999, title: "Invalid", summary: "Out of range" }] } })).rejects.toThrow();
  });

  it("upgrades the existing database without replacing completed history or transcript checkpoints", async () => {
    const oldDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open("veeky-upgrade", 1);
      request.onupgradeneeded = () => {
        const tasks = request.result.createObjectStore("tasks", { keyPath: "jobId" });
        tasks.createIndex("state", "state"); tasks.createIndex("updatedAt", "updatedAt");
        const analyses = request.result.createObjectStore("analyses", { keyPath: "jobId" });
        analyses.createIndex("completedAt", "completedAt"); analyses.createIndex("contentKey", "contentKey"); analyses.createIndex("legacySourceKey", "legacySourceKey", { unique: true });
        const chunks = request.result.createObjectStore("transcriptChunks", { keyPath: ["taskId", "sequence"] });
        chunks.createIndex("taskId", "taskId");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = oldDatabase.transaction(["tasks", "analyses", "transcriptChunks"], "readwrite");
    transaction.objectStore("tasks").put({ ...taskInput(), contentKey: "youtube:abc123:0", createdAt: "2026-10-27T10:00:00Z", updatedAt: "2026-10-27T10:00:00Z" });
    transaction.objectStore("analyses").put({ ...result("historic"), contentKey: "youtube:abc123:0" });
    transaction.objectStore("transcriptChunks").put({ taskId: "task-1", sequence: 0, segments: [segment("original")], updatedAt: "2026-10-27T10:00:00Z" });
    await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); });
    oldDatabase.close();
    const upgraded = new LocalAnalysisRepository({ indexedDB: factory, databaseName: "veeky-upgrade" });
    expect(await upgraded.getAnalysis("historic")).toMatchObject({ videoTitle: "A sample video" });
    expect(await upgraded.getTranscriptChunks("task-1")).toEqual([expect.objectContaining({ segments: [segment("original")] })]);
    await upgraded.saveSummaryCheckpoint({ taskId: "task-1", level: 0, sequence: 0, inputHash: "a".repeat(64), summary: summaryValue() });
    expect(await upgraded.getSummaryCheckpoints("task-1")).toHaveLength(1);
  });

  it("atomically replaces ASR checkpoint partitions without leaving stale segments", async () => {
    await repository.createTask(taskInput());
    await repository.saveTranscriptChunk("task-1", 0, [segment("old")]);
    await repository.saveTranscriptChunk("task-1", 8, [segment("stale")]);
    await repository.replaceTranscriptChunks("task-1", [[segment("new")]]);
    expect((await repository.getTranscriptChunks("task-1")).map((chunk) => chunk.segments)).toEqual([[segment("new")]]);
  });

  it("persists a task and transcript checkpoint across repository instances", async () => {
    await repository.createTask(taskInput());
    await repository.saveTranscriptChunk("task-1", 0, [segment("one")]);

    const reopened = new LocalAnalysisRepository({ indexedDB: factory, databaseName: "veeky-test" });
    const task = await reopened.getTask("task-1");
    const chunks = await reopened.getTranscriptChunks("task-1");

    expect(task?.state).toBe("running");
    expect(chunks).toEqual([expect.objectContaining({ taskId: "task-1", sequence: 0, segments: [segment("one")] })]);
  });

  it("marks unfinished tasks interrupted after a browser restart without losing checkpoints", async () => {
    await repository.createTask(taskInput());
    await repository.saveTranscriptChunk("task-1", 0, [segment("one")]);

    await repository.markRunningTasksInterrupted();

    expect((await repository.getTask("task-1"))?.state).toBe("interrupted");
    expect(await repository.getTranscriptChunks("task-1")).toHaveLength(1);
    expect(await repository.getRecoverableTasks()).toHaveLength(1);
  });

  it("rejects an oversized transcript chunk without partially writing it", async () => {
    repository = new LocalAnalysisRepository({
      indexedDB: factory,
      databaseName: "veeky-task-chunk-limit",
      taskDataLimits: { maxBytes: 50_000, maxTaskBytes: 1_000 },
    });
    await repository.createTask(taskInput());

    await expect(repository.saveTranscriptChunk("task-1", 0, [{ ...segment("large"), original: "x".repeat(2_000) }]))
      .rejects.toMatchObject({ code: "storage_quota_exceeded" });
    expect(await repository.getTranscriptChunks("task-1")).toEqual([]);
    expect(await repository.getTask("task-1")).not.toBeNull();
  });

  it("bounds accumulated task rows and summary checkpoints", async () => {
    const databaseName = "veeky-task-aggregate-limit";
    const roomy = new LocalAnalysisRepository({ indexedDB: factory, databaseName });
    await roomy.createTask(taskInput());
    const baseline = await roomy.getStorageMetadata();
    const limitedTasks = new LocalAnalysisRepository({
      indexedDB: factory,
      databaseName,
      taskDataLimits: { maxBytes: baseline.taskData.bytes + 50, maxTaskBytes: baseline.taskData.bytes + 50 },
    });
    await expect(limitedTasks.createTask(taskInput({ jobId: "task-2" })))
      .rejects.toMatchObject({ code: "storage_quota_exceeded" });
    expect(await limitedTasks.getTask("task-2")).toBeNull();

    const checkpointName = "veeky-checkpoint-aggregate-limit";
    const checkpointRepo = new LocalAnalysisRepository({ indexedDB: factory, databaseName: checkpointName });
    await checkpointRepo.createTask(taskInput());
    await checkpointRepo.saveSummaryCheckpoint({ taskId: "task-1", level: 0, sequence: 0, inputHash: "a".repeat(64), summary: summaryValue() });
    const checkpointBaseline = await checkpointRepo.getStorageMetadata();
    const checkpointLimited = new LocalAnalysisRepository({
      indexedDB: factory,
      databaseName: checkpointName,
      taskDataLimits: { maxBytes: 50_000, maxTaskBytes: checkpointBaseline.taskData.bytes + 50 },
    });
    await expect(checkpointLimited.saveSummaryCheckpoint({ taskId: "task-1", level: 0, sequence: 1, inputHash: "b".repeat(64), summary: summaryValue() }))
      .rejects.toMatchObject({ code: "storage_quota_exceeded" });
    expect(await checkpointLimited.getSummaryCheckpoints("task-1")).toHaveLength(1);
  });

  it("rolls back an oversized transcript replacement", async () => {
    const databaseName = "veeky-replacement-limit";
    const roomy = new LocalAnalysisRepository({ indexedDB: factory, databaseName });
    await roomy.createTask(taskInput());
    await roomy.saveTranscriptChunk("task-1", 0, [segment("original")]);
    const baseline = await roomy.getStorageMetadata();
    const limited = new LocalAnalysisRepository({
      indexedDB: factory,
      databaseName,
      taskDataLimits: { maxBytes: 50_000, maxTaskBytes: baseline.taskData.bytes + 50 },
    });

    await expect(limited.replaceTranscriptChunks("task-1", [[{ ...segment("replacement"), original: "x".repeat(2_000) }]]))
      .rejects.toMatchObject({ code: "storage_quota_exceeded" });
    expect((await limited.getTranscriptChunks("task-1")).map((chunk) => chunk.segments)).toEqual([[segment("original")]]);
  });

  it("allows bounded state transitions and shrinking cleanup for legacy data already over budget", async () => {
    const databaseName = "veeky-legacy-over-budget";
    const roomy = new LocalAnalysisRepository({ indexedDB: factory, databaseName });
    await roomy.createTask(taskInput({ jobId: "failed-task" }));
    await roomy.saveTranscriptChunk("failed-task", 0, [{ ...segment("large"), original: "x".repeat(2_000) }]);
    await roomy.createTask(taskInput({ jobId: "interrupted-task" }));
    const strict = new LocalAnalysisRepository({
      indexedDB: factory,
      databaseName,
      taskDataLimits: { maxBytes: 1, maxTaskBytes: 1 },
    });

    await expect(strict.updateTask("failed-task", { state: "failed", failureCode: "storage_quota_exceeded" })).resolves.toBeUndefined();
    await expect(strict.markRunningTasksInterrupted()).resolves.toBeUndefined();
    await expect(strict.replaceTranscriptChunks("failed-task", [[segment("smaller")]])).resolves.toBeUndefined();
    await expect(strict.discardRecoverableTask("failed-task")).resolves.toBeUndefined();

    expect((await strict.getTask("interrupted-task"))?.state).toBe("interrupted");
    expect(await strict.getTask("failed-task")).toBeNull();
  });

  it("serializes concurrent task-data writes against the aggregate budget", async () => {
    const databaseName = "veeky-task-concurrent-limit";
    const roomy = new LocalAnalysisRepository({ indexedDB: factory, databaseName });
    await roomy.createTask(taskInput({ jobId: "task-one" }));
    await roomy.createTask(taskInput({ jobId: "task-two" }));
    const baseline = await roomy.getStorageMetadata();
    const options = {
      indexedDB: factory,
      databaseName,
      taskDataLimits: { maxBytes: baseline.taskData.bytes + 1_200, maxTaskBytes: baseline.taskData.bytes + 1_200 },
    };
    const first = new LocalAnalysisRepository(options);
    const second = new LocalAnalysisRepository(options);
    const writes = await Promise.allSettled([
      first.saveTranscriptChunk("task-one", 0, [{ ...segment("one"), original: "x".repeat(800) }]),
      second.saveTranscriptChunk("task-two", 0, [{ ...segment("two"), original: "x".repeat(800) }]),
    ]);

    expect(writes.filter((write) => write.status === "fulfilled")).toHaveLength(1);
    expect(writes.filter((write) => write.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "storage_quota_exceeded" }) }),
    ]);
    expect((await first.getTranscriptChunks("task-one")).length + (await first.getTranscriptChunks("task-two")).length).toBe(1);
  });

  it("lists completed history only, newest first, while reanalysis creates another row", async () => {
    await repository.createTask(taskInput({ jobId: "task-old", state: "running" }));
    await repository.completeAnalysis(result("analysis-old", "2026-10-26T10:00:00.000Z"));
    await repository.completeAnalysis(result("analysis-new", "2026-10-27T10:00:00.000Z"));

    const history = await repository.getCompletedHistory({ limit: 10, offset: 0 });
    const latest = await repository.getLatestCompleted(contentRef);

    expect(history.items.map((item) => item.jobId)).toEqual(["analysis-new", "analysis-old"]);
    expect(latest?.jobId).toBe("analysis-new");
    expect(history.items.every((item) => Boolean(item.completedAt))).toBe(true);
  });

  it("imports only once for the same legacy record and never overwrites local analyses", async () => {
    const legacy = result("legacy-job");
    const firstId = await repository.importCompletedIfAbsent(legacy, "legacy-job");
    const secondId = await repository.importCompletedIfAbsent({ ...legacy, videoTitle: "Changed" }, "legacy-job");

    expect(firstId).toBe(secondId);
    expect((await repository.getCompletedHistory({ limit: 10, offset: 0 })).items).toHaveLength(1);
    expect((await repository.getAnalysis(firstId!))?.videoTitle).toBe("A sample video");
  });

  it("enforces completed history count and byte limits without deleting older history", async () => {
    repository = new LocalAnalysisRepository({
      indexedDB: factory,
      databaseName: "veeky-limited",
      historyLimits: { maxRecords: 2, maxBytes: 50_000 },
    });
    await repository.completeAnalysis(result("one"));
    await repository.completeAnalysis(result("two"));

    await expect(repository.completeAnalysis(result("three")))
      .rejects.toMatchObject({ code: "storage_quota_exceeded" });
    expect((await repository.getCompletedHistory({ limit: 10, offset: 0 })).items.map((item) => item.jobId).sort())
      .toEqual(["one", "two"]);

    const byteLimited = new LocalAnalysisRepository({
      indexedDB: factory,
      databaseName: "veeky-byte-limited",
      historyLimits: { maxRecords: 10, maxBytes: 10 },
    });
    await expect(byteLimited.completeAnalysis(result("too-large")))
      .rejects.toMatchObject({ code: "storage_quota_exceeded" });
    expect(await byteLimited.getAnalysis("too-large")).toBeNull();
  });

  it("serializes concurrent history writes against the same configured limit", async () => {
    const options = {
      indexedDB: factory,
      databaseName: "veeky-concurrent-limit",
      historyLimits: { maxRecords: 1, maxBytes: 50_000 },
    };
    const first = new LocalAnalysisRepository(options);
    const second = new LocalAnalysisRepository(options);

    const writes = await Promise.allSettled([
      first.completeAnalysis(result("concurrent-one")),
      second.completeAnalysis(result("concurrent-two")),
    ]);

    expect(writes.filter((write) => write.status === "fulfilled")).toHaveLength(1);
    expect(writes.filter((write) => write.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "storage_quota_exceeded" }) }),
    ]);
    expect((await first.getCompletedHistory({ limit: 10, offset: 0 })).items).toHaveLength(1);
  });

  it("does not lose task checkpoints when completed history has no remaining capacity", async () => {
    repository = new LocalAnalysisRepository({
      indexedDB: factory,
      databaseName: "veeky-checkpoint-limit",
      historyLimits: { maxRecords: 1, maxBytes: 50_000 },
    });
    await repository.completeAnalysis(result("existing"));
    await repository.createTask(taskInput({ jobId: "blocked" }));
    await repository.saveTranscriptChunk("blocked", 0, [segment("saved")]);

    await expect(repository.completeAnalysis(result("blocked")))
      .rejects.toMatchObject({ code: "storage_quota_exceeded" });
    expect((await repository.getTask("blocked"))?.state).toBe("running");
    expect(await repository.getTranscriptChunks("blocked")).toHaveLength(1);
    expect(await repository.getAnalysis("blocked")).toBeNull();
  });

  it("keeps a duplicate legacy import idempotent even when history is at capacity", async () => {
    repository = new LocalAnalysisRepository({
      indexedDB: factory,
      databaseName: "veeky-import-limited",
      historyLimits: { maxRecords: 1, maxBytes: 50_000 },
    });
    const firstId = await repository.importCompletedIfAbsent(result("legacy"), "legacy-source");

    await expect(repository.importCompletedIfAbsent({ ...result("legacy"), videoTitle: "Changed" }, "legacy-source"))
      .resolves.toBe(firstId);
    await expect(repository.importCompletedIfAbsent(result("other"), "other-source"))
      .rejects.toMatchObject({ code: "storage_quota_exceeded" });
    expect((await repository.getCompletedHistory({ limit: 10, offset: 0 })).items).toHaveLength(1);
  });

  it("deletes one completed record and all of its task checkpoints atomically", async () => {
    await repository.createTask(taskInput({ jobId: "delete-me" }));
    await repository.saveTranscriptChunk("delete-me", 0, [segment("saved")]);
    await repository.saveSummaryCheckpoint({ taskId: "delete-me", level: 0, sequence: 0, inputHash: "a".repeat(64), summary: summaryValue() });
    await repository.completeAnalysis(result("delete-me"));
    await repository.completeAnalysis(result("keep-me"));

    await repository.deleteCompletedAnalysis("delete-me");

    expect(await repository.getAnalysis("delete-me")).toBeNull();
    expect(await repository.getTask("delete-me")).toBeNull();
    expect(await repository.getTranscriptChunks("delete-me")).toEqual([]);
    expect(await repository.getSummaryCheckpoints("delete-me")).toEqual([]);
    expect(await repository.getAnalysis("keep-me")).not.toBeNull();
  });

  it("removes redundant checkpoints atomically when completion succeeds", async () => {
    await repository.createTask(taskInput({ jobId: "complete-me" }));
    await repository.saveTranscriptChunk("complete-me", 0, [segment("saved")]);
    await repository.saveSummaryCheckpoint({ taskId: "complete-me", level: 0, sequence: 0, inputHash: "a".repeat(64), summary: summaryValue() });

    await repository.completeAnalysis(result("complete-me"));

    expect(await repository.getAnalysis("complete-me")).not.toBeNull();
    expect((await repository.getTask("complete-me"))?.state).toBe("completed");
    expect(await repository.getTranscriptChunks("complete-me")).toEqual([]);
    expect(await repository.getSummaryCheckpoints("complete-me")).toEqual([]);
  });

  it("discards only non-running recoverable tasks and their checkpoints", async () => {
    await repository.createTask(taskInput({ jobId: "recoverable", state: "failed", failureCode: "analysis_failed" }));
    await repository.saveTranscriptChunk("recoverable", 0, [segment("saved")]);
    await repository.saveSummaryCheckpoint({ taskId: "recoverable", level: 0, sequence: 0, inputHash: "a".repeat(64), summary: summaryValue() });
    await repository.createTask(taskInput({ jobId: "running" }));

    await repository.discardRecoverableTask("recoverable");
    await expect(repository.discardRecoverableTask("running")).rejects.toMatchObject({ code: "analysis_busy" });

    expect(await repository.getTask("recoverable")).toBeNull();
    expect(await repository.getTranscriptChunks("recoverable")).toEqual([]);
    expect(await repository.getSummaryCheckpoints("recoverable")).toEqual([]);
    expect(await repository.getTask("running")).not.toBeNull();
  });

  it("rejects cleanup for a running task without losing its record or checkpoints", async () => {
    await repository.createTask(taskInput({ jobId: "running" }));
    await repository.saveTranscriptChunk("running", 0, [segment("saved")]);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open("veeky-test", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("analyses", "readwrite");
    transaction.objectStore("analyses").add({ ...result("running"), contentKey: "youtube:abc123:0" });
    await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); });
    database.close();

    await expect(repository.deleteCompletedAnalysis("running")).rejects.toMatchObject({ code: "analysis_busy" });
    expect(await repository.getAnalysis("running")).not.toBeNull();
    expect(await repository.getTask("running")).not.toBeNull();
    expect(await repository.getTranscriptChunks("running")).toHaveLength(1);
  });

  it("reports history, checkpoint, model budget and browser quota metadata", async () => {
    repository = new LocalAnalysisRepository({
      indexedDB: factory,
      databaseName: "veeky-stats",
      storageEstimate: async () => ({ usage: 1234, quota: 5678 }),
    });
    await repository.createTask(taskInput());
    await repository.saveTranscriptChunk("task-1", 0, [segment("saved")]);
    await repository.completeAnalysis(result("complete"));

    await expect(repository.getStorageMetadata()).resolves.toMatchObject({
      history: { recordCount: 1, maxRecords: 1000, maxBytes: 100 * 1024 ** 2 },
      taskData: { taskCount: 1, transcriptChunkCount: 1, summaryCheckpointCount: 0, maxBytes: 256 * 1024 ** 2, maxTaskBytes: 64 * 1024 ** 2 },
      model: { maxBytes: 1024 ** 3 },
      browser: { usageBytes: 1234, quotaBytes: 5678 },
    });
  });

  it("rejects credential-bearing data before it can enter durable storage", async () => {
    await expect(repository.createTask({
      ...taskInput(),
      apiKey: "must-not-persist",
    } as LocalAnalysisTaskInput)).rejects.toThrow(/sensitive credential field/i);

    await expect(repository.completeAnalysis({
      ...result("with-key"),
      llmConfig: { apiKey: "must-not-persist" },
    } as LocalAnalysisRecord)).rejects.toThrow(/sensitive credential field/i);
    expect(await repository.getTask("task-1")).toBeNull();
    expect(await repository.getAnalysis("with-key")).toBeNull();
  });
});
