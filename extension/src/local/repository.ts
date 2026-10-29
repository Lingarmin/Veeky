import type {
  AnalysisHistoryItem,
  AnalysisResult,
  ContentRef,
  TranscriptSegment,
} from "../shared/types";
import type { LlmProvider } from "../sidepanel/llm";
import { parseAnalysisResult, type AnalysisResult as Summary } from "./prompts";
import {
  MODEL_STORAGE_BUDGET_BYTES,
  assertHistoryWriteAllowed,
  assertTaskDataMutationAllowed,
  assertTaskDataWriteAllowed,
  browserStorageEstimate,
  historySerializedBytes,
  resolveHistoryStorageLimits,
  resolveTaskDataStorageLimits,
  taskDataSerializedBytes,
  type BrowserStorageEstimate,
  type HistoryStorageLimits,
  type LocalStorageMetadata,
  type TaskDataSnapshot,
  type TaskDataStorageLimits,
} from "./storage";

const DATABASE_VERSION = 2;
const TASKS_STORE = "tasks";
const ANALYSES_STORE = "analyses";
const CHUNKS_STORE = "transcriptChunks";
const SUMMARIES_STORE = "summaryCheckpoints";
const CREDENTIAL_FIELD = /(?:api.?key|authorization|access.?token|refresh.?token|installation.?token|secret|password)/iu;

export type LocalTaskState = "running" | "interrupted" | "failed" | "completed";
export type LocalTaskStage =
  | "checking_captions"
  | "downloading_model"
  | "extracting_audio"
  | "transcribing"
  | "translating"
  | "summarizing";

export interface LocalAnalysisTaskInput {
  jobId: string;
  contentRef: ContentRef;
  videoTitle: string;
  durationMs: number;
  sourceLanguage: string;
  targetLanguage: string;
  stage: LocalTaskStage;
  state: LocalTaskState;
  progressCompleted: number;
  progressTotal: number | null;
  failureCode?: string | null;
  /** Nonsecret references needed for an explicit restart. */
  provider?: LlmProvider;
  model?: string;
  isGenerated?: boolean | null;
  transcriptReady?: boolean;
}

export interface LocalAnalysisTask extends LocalAnalysisTaskInput {
  contentKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface LocalAnalysisRecord extends AnalysisResult {
  completedAt: string;
  legacySourceKey?: string;
}

export interface LocalTranscriptChunk {
  taskId: string;
  sequence: number;
  segments: TranscriptSegment[];
  updatedAt: string;
}

export interface LocalSummaryCheckpointInput {
  taskId: string;
  level: number;
  sequence: number;
  /** SHA-256 of the exact prompt and nonsecret model references. */
  inputHash: string;
  summary: Summary;
}

export interface LocalSummaryCheckpoint extends LocalSummaryCheckpointInput {
  updatedAt: string;
}

export interface LocalHistoryPage {
  items: AnalysisHistoryItem[];
  hasMore: boolean;
}

export interface IndexedDbFactory {
  open(name: string, version?: number): IDBOpenDBRequest;
}

export interface LocalAnalysisRepositoryOptions {
  indexedDB?: IndexedDbFactory;
  databaseName?: string;
  now?: () => Date;
  historyLimits?: Partial<HistoryStorageLimits>;
  taskDataLimits?: Partial<TaskDataStorageLimits>;
  storageEstimate?: () => Promise<BrowserStorageEstimate>;
}

export class LocalAnalysisRepository {
  private readonly indexedDBFactory: IndexedDbFactory;
  private readonly databaseName: string;
  private readonly now: () => Date;
  private readonly historyLimits: HistoryStorageLimits;
  private readonly taskDataLimits: TaskDataStorageLimits;
  private readonly storageEstimate: () => Promise<BrowserStorageEstimate>;
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(options: LocalAnalysisRepositoryOptions = {}) {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error("IndexedDB is not available in this extension context");
    this.indexedDBFactory = factory;
    this.databaseName = options.databaseName ?? "veeky-local-analysis-v1";
    this.now = options.now ?? (() => new Date());
    this.historyLimits = resolveHistoryStorageLimits(options.historyLimits);
    this.taskDataLimits = resolveTaskDataStorageLimits(options.taskDataLimits);
    this.storageEstimate = options.storageEstimate ?? browserStorageEstimate;
  }

  async open(): Promise<void> {
    await this.database();
  }

  async createTask(input: LocalAnalysisTaskInput): Promise<void> {
    assertNoCredentialFields(input);
    validateTaskShape(input);
    if (!input.jobId.trim()) throw new Error("Task id is required");
    if (!Number.isFinite(input.durationMs) || input.durationMs < 0) throw new Error("Invalid task duration");
    if (!Number.isInteger(input.progressCompleted) || input.progressCompleted < 0) throw new Error("Invalid task progress");
    const database = await this.database();
    const timestamp = this.now().toISOString();
    const task: LocalAnalysisTask = {
      ...structuredClone(input),
      contentKey: contentKey(input.contentRef),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const transaction = database.transaction([TASKS_STORE, CHUNKS_STORE, SUMMARIES_STORE], "readwrite");
    const snapshot = await readTaskDataSnapshot(transaction);
    assertTaskDataWriteAllowed({ ...snapshot, tasks: [...snapshot.tasks, task] }, this.taskDataLimits);
    transaction.objectStore(TASKS_STORE).add(task);
    await transactionDone(transaction);
  }

  async updateTask(jobId: string, update: Partial<Pick<LocalAnalysisTaskInput,
    "stage" | "state" | "progressCompleted" | "progressTotal" | "failureCode" | "transcriptReady" | "isGenerated">>): Promise<void> {
    assertNoCredentialFields(update);
    validateTaskPatch(update);
    const database = await this.database();
    const transaction = database.transaction([TASKS_STORE, CHUNKS_STORE, SUMMARIES_STORE], "readwrite");
    const store = transaction.objectStore(TASKS_STORE);
    const existing = await requestResult<LocalAnalysisTask | undefined>(store.get(jobId));
    if (!existing) throw new Error(`Analysis task not found: ${jobId}`);
    validateTaskShape(existing, true);
    const updated = { ...existing, ...structuredClone(update), updatedAt: this.now().toISOString() };
    store.put(updated);
    await transactionDone(transaction);
  }

  async getTask(jobId: string): Promise<LocalAnalysisTask | null> {
    const database = await this.database();
    return (await requestResult<LocalAnalysisTask | undefined>(database.transaction(TASKS_STORE).objectStore(TASKS_STORE).get(jobId))) ?? null;
  }

  async getRecoverableTasks(): Promise<LocalAnalysisTask[]> {
    const database = await this.database();
    const tasks = await requestResult<LocalAnalysisTask[]>(database.transaction(TASKS_STORE).objectStore(TASKS_STORE).getAll());
    return tasks.filter((task) => task.state === "interrupted" || task.state === "failed")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async markRunningTasksInterrupted(): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction([TASKS_STORE, CHUNKS_STORE, SUMMARIES_STORE], "readwrite");
    const store = transaction.objectStore(TASKS_STORE);
    const snapshot = await readTaskDataSnapshot(transaction);
    const updatedAt = this.now().toISOString();
    for (const task of snapshot.tasks) {
      if (task.state === "running") {
        validateTaskShape(task, true);
        store.put({ ...task, state: "interrupted", updatedAt });
      }
    }
    await transactionDone(transaction);
  }

  async saveTranscriptChunk(taskId: string, sequence: number, segments: TranscriptSegment[]): Promise<void> {
    assertNoCredentialFields(segments);
    validateSegments(segments);
    if (!Number.isInteger(sequence) || sequence < 0) throw new Error("Invalid transcript sequence");
    const database = await this.database();
    const chunk: LocalTranscriptChunk = {
      taskId,
      sequence,
      segments: structuredClone(segments),
      updatedAt: this.now().toISOString(),
    };
    const transaction = database.transaction([TASKS_STORE, CHUNKS_STORE, SUMMARIES_STORE], "readwrite");
    const task = await requestResult<LocalAnalysisTask | undefined>(transaction.objectStore(TASKS_STORE).get(taskId));
    if (!task) {
      transaction.abort();
      throw new Error(`Analysis task not found: ${taskId}`);
    }
    const snapshot = await readTaskDataSnapshot(transaction);
    const chunks = [...snapshot.chunks.filter((stored) => stored.taskId !== taskId || stored.sequence !== sequence), chunk];
    assertTaskDataMutationAllowed(snapshot, { ...snapshot, chunks }, this.taskDataLimits);
    transaction.objectStore(CHUNKS_STORE).put(chunk);
    await transactionDone(transaction);
  }

  async getTranscriptChunks(taskId: string): Promise<LocalTranscriptChunk[]> {
    const database = await this.database();
    const rows = await requestResult<LocalTranscriptChunk[]>(database.transaction(CHUNKS_STORE).objectStore(CHUNKS_STORE).index("taskId").getAll(taskId));
    return rows.sort((left, right) => left.sequence - right.sequence);
  }

  async replaceTranscriptChunks(taskId: string, batches: TranscriptSegment[][]): Promise<void> {
    assertNoCredentialFields(batches);
    if (!Array.isArray(batches)) throw new Error("Invalid transcript batches");
    batches.forEach(validateSegments);
    const database = await this.database();
    const transaction = database.transaction([TASKS_STORE, CHUNKS_STORE, SUMMARIES_STORE], "readwrite");
    const task = await requestResult<LocalAnalysisTask | undefined>(transaction.objectStore(TASKS_STORE).get(taskId));
    if (!task || task.state === "completed") {
      transaction.abort();
      throw new Error("Cannot replace checkpoints for this task");
    }
    const store = transaction.objectStore(CHUNKS_STORE);
    const keys = await requestResult<IDBValidKey[]>(store.index("taskId").getAllKeys(taskId));
    const updatedAt = this.now().toISOString();
    const replacements = batches.map((segments, sequence): LocalTranscriptChunk => ({ taskId, sequence, segments: structuredClone(segments), updatedAt }));
    const snapshot = await readTaskDataSnapshot(transaction);
    assertTaskDataMutationAllowed(snapshot, { ...snapshot, chunks: [...snapshot.chunks.filter((chunk) => chunk.taskId !== taskId), ...replacements] }, this.taskDataLimits);
    for (const key of keys) store.delete(key);
    replacements.forEach((chunk) => store.put(chunk));
    await transactionDone(transaction);
  }

  async saveSummaryCheckpoint(input: LocalSummaryCheckpointInput): Promise<void> {
    assertNoCredentialFields(input);
    assertKnownFields(input, ["taskId", "level", "sequence", "inputHash", "summary"]);
    if (typeof input.taskId !== "string" || !input.taskId.trim() || !Number.isSafeInteger(input.level) || input.level < 0
      || !Number.isSafeInteger(input.sequence) || input.sequence < 0 || typeof input.inputHash !== "string" || !/^[a-f0-9]{64}$/.test(input.inputHash)) throw new Error("Invalid summary checkpoint");
    const database = await this.database();
    const transaction = database.transaction([TASKS_STORE, CHUNKS_STORE, SUMMARIES_STORE], "readwrite");
    const task = await requestResult<LocalAnalysisTask | undefined>(transaction.objectStore(TASKS_STORE).get(input.taskId));
    if (!task || task.state === "completed") throw new Error("Cannot save summary for this task");
    const serialized = JSON.stringify(input.summary);
    const summary = parseAnalysisResult(serialized, task.durationMs);
    if (JSON.stringify(serialized).length > 7_000) throw new Error("Summary checkpoint is too large");
    const checkpoint: LocalSummaryCheckpoint = { taskId: input.taskId, level: input.level, sequence: input.sequence, inputHash: input.inputHash, summary, updatedAt: this.now().toISOString() };
    const snapshot = await readTaskDataSnapshot(transaction);
    const summaries = [...snapshot.summaries.filter((stored) => stored.taskId !== input.taskId || stored.level !== input.level || stored.sequence !== input.sequence), checkpoint];
    assertTaskDataMutationAllowed(snapshot, { ...snapshot, summaries }, this.taskDataLimits);
    transaction.objectStore(SUMMARIES_STORE).put(checkpoint);
    await transactionDone(transaction);
  }

  async getSummaryCheckpoints(taskId: string): Promise<LocalSummaryCheckpoint[]> {
    const database = await this.database();
    const checkpoints = await requestResult<LocalSummaryCheckpoint[]>(database.transaction(SUMMARIES_STORE).objectStore(SUMMARIES_STORE).index("taskId").getAll(taskId));
    return checkpoints.sort((left, right) => left.level - right.level || left.sequence - right.sequence);
  }

  async completeAnalysis(result: LocalAnalysisRecord): Promise<void> {
    assertNoCredentialFields(result);
    validateRecordShape(result);
    validateCompletedAnalysis(result);
    const database = await this.database();
    const transaction = database.transaction([ANALYSES_STORE, TASKS_STORE, CHUNKS_STORE, SUMMARIES_STORE], "readwrite");
    const analyses = transaction.objectStore(ANALYSES_STORE);
    const existing = await requestResult<LocalAnalysisRecord | undefined>(analyses.get(result.jobId));
    if (existing) {
      transaction.abort();
      throw new Error(`Analysis already exists: ${result.jobId}`);
    }
    const storedResult = {
      ...structuredClone(result),
      contentKey: contentKey(result.contentRef),
    };
    const completed = (await requestResult<LocalAnalysisRecord[]>(analyses.getAll())).filter(isCompletedAnalysis);
    assertHistoryWriteAllowed([...completed, storedResult], this.historyLimits);
    const tasks = transaction.objectStore(TASKS_STORE);
    const task = await requestResult<LocalAnalysisTask | undefined>(tasks.get(result.jobId));
    const snapshot = await readTaskDataSnapshot(transaction);
    let completedTask: LocalAnalysisTask | null = null;
    if (task) {
      validateTaskShape(task, true);
      completedTask = { ...task, state: "completed", stage: "summarizing", updatedAt: this.now().toISOString() };
    }
    assertTaskDataMutationAllowed(snapshot, {
      tasks: snapshot.tasks,
      chunks: snapshot.chunks.filter((chunk) => chunk.taskId !== result.jobId),
      summaries: snapshot.summaries.filter((summary) => summary.taskId !== result.jobId),
    }, this.taskDataLimits);
    analyses.add(storedResult);
    if (completedTask) tasks.put(completedTask);
    await deleteTaskCheckpoints(transaction, result.jobId);
    await transactionDone(transaction);
  }

  async getAnalysis(jobId: string): Promise<LocalAnalysisRecord | null> {
    const database = await this.database();
    return (await requestResult<LocalAnalysisRecord | undefined>(database.transaction(ANALYSES_STORE).objectStore(ANALYSES_STORE).get(jobId))) ?? null;
  }

  async getCompletedHistory(options: { limit: number; offset: number }): Promise<LocalHistoryPage> {
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit)));
    const offset = Math.max(0, Math.floor(options.offset));
    const database = await this.database();
    const rows = await requestResult<LocalAnalysisRecord[]>(database.transaction(ANALYSES_STORE).objectStore(ANALYSES_STORE).getAll());
    const completed = rows.filter(isCompletedAnalysis)
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt) || right.jobId.localeCompare(left.jobId));
    const pageRows = completed.slice(offset, offset + limit + 1);
    return {
      items: pageRows.slice(0, limit).map(toHistoryItem),
      hasMore: pageRows.length > limit,
    };
  }

  async getLatestCompleted(contentRef: ContentRef): Promise<LocalAnalysisRecord | null> {
    const database = await this.database();
    const rows = await requestResult<LocalAnalysisRecord[]>(database.transaction(ANALYSES_STORE).objectStore(ANALYSES_STORE).index("contentKey").getAll(contentKey(contentRef)));
    return rows.filter(isCompletedAnalysis)
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt) || right.jobId.localeCompare(left.jobId))[0] ?? null;
  }

  async importCompletedIfAbsent(result: LocalAnalysisRecord, legacySourceKey: string): Promise<string | null> {
    assertNoCredentialFields(result);
    validateRecordShape(result);
    validateCompletedAnalysis(result);
    if (!legacySourceKey.trim()) throw new Error("Legacy source key is required");
    const database = await this.database();
    const transaction = database.transaction(ANALYSES_STORE, "readwrite");
    const store = transaction.objectStore(ANALYSES_STORE);
    const index = store.index("legacySourceKey");
    const existing = await requestResult<LocalAnalysisRecord | undefined>(index.get(legacySourceKey));
    if (existing) {
      await transactionDone(transaction);
      return existing.jobId;
    }
    const imported = {
      ...structuredClone(result),
      jobId: `import:${encodeURIComponent(legacySourceKey)}`,
      legacySourceKey,
      contentKey: contentKey(result.contentRef),
    };
    const completed = (await requestResult<LocalAnalysisRecord[]>(store.getAll())).filter(isCompletedAnalysis);
    assertHistoryWriteAllowed([...completed, imported], this.historyLimits);
    store.add(imported);
    await transactionDone(transaction);
    return imported.jobId;
  }

  async deleteCompletedAnalysis(jobId: string): Promise<void> {
    if (typeof jobId !== "string" || !jobId.trim()) throw new Error("Analysis id is required");
    const database = await this.database();
    const transaction = database.transaction([ANALYSES_STORE, TASKS_STORE, CHUNKS_STORE, SUMMARIES_STORE], "readwrite");
    const analyses = transaction.objectStore(ANALYSES_STORE);
    const tasks = transaction.objectStore(TASKS_STORE);
    const task = await requestResult<LocalAnalysisTask | undefined>(tasks.get(jobId));
    if (task?.state === "running") {
      transaction.abort();
      throw Object.assign(new Error("Running analysis cannot be deleted"), { code: "analysis_busy" });
    }
    const analysis = await requestResult<LocalAnalysisRecord | undefined>(analyses.get(jobId));
    if (!analysis || !isCompletedAnalysis(analysis)) {
      transaction.abort();
      throw Object.assign(new Error("Completed analysis not found"), { code: "analysis_not_found" });
    }
    analyses.delete(jobId);
    tasks.delete(jobId);
    const chunks = transaction.objectStore(CHUNKS_STORE);
    const summaries = transaction.objectStore(SUMMARIES_STORE);
    const [chunkKeys, summaryKeys] = await Promise.all([
      requestResult<IDBValidKey[]>(chunks.index("taskId").getAllKeys(jobId)),
      requestResult<IDBValidKey[]>(summaries.index("taskId").getAllKeys(jobId)),
    ]);
    for (const key of chunkKeys) chunks.delete(key);
    for (const key of summaryKeys) summaries.delete(key);
    await transactionDone(transaction);
  }

  async discardRecoverableTask(jobId: string): Promise<void> {
    if (typeof jobId !== "string" || !jobId.trim()) throw new Error("Analysis id is required");
    const database = await this.database();
    const transaction = database.transaction([TASKS_STORE, CHUNKS_STORE, SUMMARIES_STORE], "readwrite");
    const tasks = transaction.objectStore(TASKS_STORE);
    const task = await requestResult<LocalAnalysisTask | undefined>(tasks.get(jobId));
    if (task?.state === "running") {
      transaction.abort();
      throw Object.assign(new Error("Running analysis cannot be discarded"), { code: "analysis_busy" });
    }
    if (!task || (task.state !== "interrupted" && task.state !== "failed")) {
      transaction.abort();
      throw Object.assign(new Error("Recoverable analysis not found"), { code: "analysis_not_found" });
    }
    tasks.delete(jobId);
    await deleteTaskCheckpoints(transaction, jobId);
    await transactionDone(transaction);
  }

  async getStorageMetadata(): Promise<LocalStorageMetadata> {
    const database = await this.database();
    const transaction = database.transaction([ANALYSES_STORE, TASKS_STORE, CHUNKS_STORE, SUMMARIES_STORE]);
    const analysisRequest = transaction.objectStore(ANALYSES_STORE).getAll();
    const taskRequest = transaction.objectStore(TASKS_STORE).getAll();
    const chunkRequest = transaction.objectStore(CHUNKS_STORE).getAll();
    const summaryRequest = transaction.objectStore(SUMMARIES_STORE).getAll();
    const [analyses, tasks, chunks, summaries] = await Promise.all([
      requestResult<LocalAnalysisRecord[]>(analysisRequest),
      requestResult<LocalAnalysisTask[]>(taskRequest),
      requestResult<LocalTranscriptChunk[]>(chunkRequest),
      requestResult<LocalSummaryCheckpoint[]>(summaryRequest),
    ]);
    const history = analyses.filter(isCompletedAnalysis);
    const estimate = await this.storageEstimate().catch((): BrowserStorageEstimate => ({}));
    return {
      history: {
        recordCount: history.length,
        bytes: historySerializedBytes(history),
        maxRecords: this.historyLimits.maxRecords,
        maxBytes: this.historyLimits.maxBytes,
      },
      taskData: {
        taskCount: tasks.length,
        transcriptChunkCount: chunks.length,
        summaryCheckpointCount: summaries.length,
        bytes: taskDataSerializedBytes({ tasks, chunks, summaries }),
        maxBytes: this.taskDataLimits.maxBytes,
        maxTaskBytes: this.taskDataLimits.maxTaskBytes,
      },
      model: { maxBytes: MODEL_STORAGE_BUDGET_BYTES },
      browser: {
        usageBytes: finiteStorageValue(estimate.usage),
        quotaBytes: finiteStorageValue(estimate.quota),
      },
    };
  }

  private database(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    const databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.indexedDBFactory.open(this.databaseName, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(TASKS_STORE)) {
          const tasks = database.createObjectStore(TASKS_STORE, { keyPath: "jobId" });
          tasks.createIndex("state", "state");
          tasks.createIndex("updatedAt", "updatedAt");
        }
        if (!database.objectStoreNames.contains(ANALYSES_STORE)) {
          const analyses = database.createObjectStore(ANALYSES_STORE, { keyPath: "jobId" });
          analyses.createIndex("completedAt", "completedAt");
          analyses.createIndex("contentKey", "contentKey");
          analyses.createIndex("legacySourceKey", "legacySourceKey", { unique: true });
        }
        if (!database.objectStoreNames.contains(CHUNKS_STORE)) {
          const chunks = database.createObjectStore(CHUNKS_STORE, { keyPath: ["taskId", "sequence"] });
          chunks.createIndex("taskId", "taskId");
        }
        if (!database.objectStoreNames.contains(SUMMARIES_STORE)) {
          const summaries = database.createObjectStore(SUMMARIES_STORE, { keyPath: ["taskId", "level", "sequence"] });
          summaries.createIndex("taskId", "taskId");
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error ?? new Error("Unable to open local analysis database"));
      request.onblocked = () => reject(new Error("Local database upgrade is blocked by another extension page"));
    }).catch((error: unknown) => {
      this.databasePromise = null;
      throw error;
    });
    this.databasePromise = databasePromise;
    return databasePromise;
  }
}

let defaultRepository: LocalAnalysisRepository | null = null;

export function getLocalAnalysisRepository(): LocalAnalysisRepository {
  if (!defaultRepository) defaultRepository = new LocalAnalysisRepository();
  return defaultRepository;
}

export function contentKey(contentRef: ContentRef): string {
  return `${contentRef.platform}:${contentRef.sourceContentId}:${contentRef.mediaIndex}`;
}

const TASK_FIELDS = ["jobId", "contentRef", "videoTitle", "durationMs", "sourceLanguage", "targetLanguage", "stage", "state", "progressCompleted", "progressTotal", "failureCode", "provider", "model", "isGenerated", "transcriptReady"];
const TASK_UPDATE_FIELDS = ["stage", "state", "progressCompleted", "progressTotal", "failureCode", "transcriptReady", "isGenerated"];
const TIMED_FIELDS = ["start_ms", "end_ms", "title", "summary"];

function assertKnownFields(value: unknown, allowed: readonly string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) throw new Error("Expected a data object");
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown durable data field: ${key}`);
}

function requireText(value: unknown): void {
  if (typeof value !== "string") throw new Error("Expected text in durable data");
}

function validateContentRef(ref: ContentRef): void {
  assertKnownFields(ref, ["platform", "sourceContentId", "mediaIndex"]);
  if (!["youtube", "x"].includes(ref.platform) || typeof ref.sourceContentId !== "string" || !/^[A-Za-z0-9_-]+$/.test(ref.sourceContentId)
    || !Number.isSafeInteger(ref.mediaIndex) || ref.mediaIndex < 0) throw new Error("Invalid content reference");
}

function validateTaskPatch(update: Partial<LocalAnalysisTaskInput>): void {
  assertKnownFields(update, TASK_UPDATE_FIELDS);
  if (update.stage !== undefined && !["checking_captions", "downloading_model", "extracting_audio", "transcribing", "translating", "summarizing"].includes(update.stage)) throw new Error("Invalid task stage");
  if (update.state !== undefined && !["running", "interrupted", "failed", "completed"].includes(update.state)) throw new Error("Invalid task state");
  if (update.progressCompleted !== undefined && (!Number.isSafeInteger(update.progressCompleted) || update.progressCompleted < 0)) throw new Error("Invalid task progress");
  if (update.progressTotal != null && (!Number.isSafeInteger(update.progressTotal) || update.progressTotal < 0)) throw new Error("Invalid task progress");
  if (update.failureCode != null && (typeof update.failureCode !== "string" || !/^[a-z][a-z0-9_]{0,79}$/.test(update.failureCode))) throw new Error("Invalid failure code");
  if (update.isGenerated != null && typeof update.isGenerated !== "boolean") throw new Error("Invalid caption source");
  if (update.transcriptReady !== undefined && typeof update.transcriptReady !== "boolean") throw new Error("Invalid transcript state");
}

function validateTaskShape(task: LocalAnalysisTaskInput, stored = false): void {
  assertKnownFields(task, stored ? [...TASK_FIELDS, "contentKey", "createdAt", "updatedAt"] : TASK_FIELDS);
  validateContentRef(task.contentRef);
  [task.jobId, task.videoTitle, task.sourceLanguage, task.targetLanguage].forEach(requireText);
  validateTaskPatch({ stage: task.stage, state: task.state, progressCompleted: task.progressCompleted, progressTotal: task.progressTotal, failureCode: task.failureCode, isGenerated: task.isGenerated, transcriptReady: task.transcriptReady });
  if (task.provider !== undefined && !["kimi", "deepseek", "hunyuan", "qwen", "glm"].includes(task.provider)) throw new Error("Invalid provider reference");
  if (task.model !== undefined) requireText(task.model);
  if (!Number.isFinite(task.durationMs) || task.durationMs < 0 || task.durationMs > 14_400_000) throw new Error("Invalid task duration");
  if (stored) {
    const row = task as LocalAnalysisTask;
    [row.createdAt, row.updatedAt, row.contentKey].forEach(requireText);
    if (row.contentKey !== contentKey(row.contentRef)) throw new Error("Invalid task content key");
  }
}

function validateSegments(segments: TranscriptSegment[]): void {
  if (!Array.isArray(segments)) throw new Error("Invalid transcript segments");
  for (const segment of segments) {
    assertKnownFields(segment, ["id", "startMs", "durationMs", "original", "translated"]);
    [segment.id, segment.original].forEach(requireText);
    if (segment.translated !== null) requireText(segment.translated);
    if (!Number.isSafeInteger(segment.startMs) || segment.startMs < 0 || !Number.isSafeInteger(segment.durationMs) || segment.durationMs < 0) throw new Error("Invalid transcript time");
  }
}

function validateRecordShape(result: LocalAnalysisRecord): void {
  assertKnownFields(result, ["jobId", "contentId", "contentRef", "videoId", "videoTitle", "durationMs", "sourceLanguage", "targetLanguage", "isGenerated", "oneLineSummary", "summaryPoints", "chapters", "highlights", "transcript", "partial", "failureCode", "modelName", "modelVersion", "completedAt", "legacySourceKey"]);
  validateContentRef(result.contentRef);
  [result.jobId, result.contentId, result.videoTitle, result.sourceLanguage, result.targetLanguage, result.oneLineSummary, result.modelName, result.modelVersion, result.completedAt].forEach(requireText);
  if (result.videoId !== null) requireText(result.videoId);
  if (result.legacySourceKey !== undefined) requireText(result.legacySourceKey);
  if (result.isGenerated !== null && typeof result.isGenerated !== "boolean" || typeof result.partial !== "boolean") throw new Error("Invalid analysis flags");
  if (result.failureCode !== null) requireText(result.failureCode);
  if (!Array.isArray(result.summaryPoints) || !Array.isArray(result.chapters) || !Array.isArray(result.highlights)) throw new Error("Invalid analysis collections");
  result.summaryPoints.forEach(requireText);
  for (const timed of [...result.chapters, ...result.highlights]) {
    const highlight = result.highlights.includes(timed as AnalysisResult["highlights"][number]);
    assertKnownFields(timed, highlight ? [...TIMED_FIELDS, "original_excerpt", "translated_excerpt"] : TIMED_FIELDS);
    [timed.title, timed.summary].forEach(requireText);
    if (!Number.isSafeInteger(timed.start_ms) || !Number.isSafeInteger(timed.end_ms) || timed.start_ms < 0 || timed.end_ms <= timed.start_ms) throw new Error("Invalid analysis time");
    if (highlight) {
      const item = timed as AnalysisResult["highlights"][number];
      [item.original_excerpt, item.translated_excerpt].forEach(requireText);
    }
  }
  validateSegments(result.transcript);
}

function validateCompletedAnalysis(result: LocalAnalysisRecord): void {
  if (!result.jobId.trim()) throw new Error("Analysis id is required");
  if (!result.videoTitle.trim()) throw new Error("Analysis title is required");
  if (!Number.isFinite(result.durationMs) || result.durationMs < 0 || result.durationMs > 4 * 60 * 60 * 1000) {
    throw Object.assign(new Error("Analysis duration is outside the supported range"), { code: "video_too_long" });
  }
  if (!Array.isArray(result.transcript) || !result.completedAt || !Number.isFinite(Date.parse(result.completedAt))) {
    throw new Error("Analysis is not complete");
  }
  if (result.partial || result.failureCode) throw new Error("Only complete successful analyses can be saved as history");
}

function isCompletedAnalysis(result: LocalAnalysisRecord): boolean {
  return Boolean(result.completedAt && !result.partial && !result.failureCode);
}

function toHistoryItem(result: LocalAnalysisRecord): AnalysisHistoryItem {
  return {
    jobId: result.jobId,
    contentId: result.contentId,
    contentRef: result.contentRef,
    videoId: result.videoId,
    videoTitle: result.videoTitle,
    durationMs: result.durationMs,
    sourceLanguage: result.sourceLanguage,
    targetLanguage: result.targetLanguage,
    completedAt: result.completedAt,
    modelName: result.modelName,
    modelVersion: result.modelVersion,
  };
}

function assertNoCredentialFields(value: unknown, path = ""): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentialFields(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (CREDENTIAL_FIELD.test(key)) throw new Error(`Sensitive credential field is forbidden in local analysis data: ${childPath}`);
    assertNoCredentialFields(child, childPath);
  }
}

interface RepositoryTaskDataSnapshot extends TaskDataSnapshot {
  tasks: LocalAnalysisTask[];
  chunks: LocalTranscriptChunk[];
  summaries: LocalSummaryCheckpoint[];
}

async function readTaskDataSnapshot(transaction: IDBTransaction): Promise<RepositoryTaskDataSnapshot> {
  const [tasks, chunks, summaries] = await Promise.all([
    requestResult<LocalAnalysisTask[]>(transaction.objectStore(TASKS_STORE).getAll()),
    requestResult<LocalTranscriptChunk[]>(transaction.objectStore(CHUNKS_STORE).getAll()),
    requestResult<LocalSummaryCheckpoint[]>(transaction.objectStore(SUMMARIES_STORE).getAll()),
  ]);
  return { tasks, chunks, summaries };
}

async function deleteTaskCheckpoints(transaction: IDBTransaction, taskId: string): Promise<void> {
  const chunks = transaction.objectStore(CHUNKS_STORE);
  const summaries = transaction.objectStore(SUMMARIES_STORE);
  const [chunkKeys, summaryKeys] = await Promise.all([
    requestResult<IDBValidKey[]>(chunks.index("taskId").getAllKeys(taskId)),
    requestResult<IDBValidKey[]>(summaries.index("taskId").getAllKeys(taskId)),
  ]);
  for (const key of chunkKeys) chunks.delete(key);
  for (const key of summaryKeys) summaries.delete(key);
}

function requestResult<T = unknown>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function finiteStorageValue(value: number | undefined): number | null {
  return Number.isFinite(value) && value! >= 0 ? value! : null;
}
