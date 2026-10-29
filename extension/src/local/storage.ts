export const MODEL_STORAGE_BUDGET_BYTES = 1024 ** 3;
export const HISTORY_STORAGE_BUDGET_BYTES = 100 * 1024 ** 2;
export const HISTORY_STORAGE_RECORD_LIMIT = 1000;
export const TASK_DATA_STORAGE_BUDGET_BYTES = 256 * 1024 ** 2;
export const TASK_DATA_PER_TASK_BUDGET_BYTES = 64 * 1024 ** 2;

export interface HistoryStorageLimits {
  maxRecords: number;
  maxBytes: number;
}

export interface TaskDataStorageLimits {
  maxBytes: number;
  maxTaskBytes: number;
}

export interface TaskDataSnapshot {
  tasks: readonly { jobId: string }[];
  chunks: readonly { taskId: string }[];
  summaries: readonly { taskId: string }[];
}

export interface BrowserStorageEstimate {
  usage?: number;
  quota?: number;
}

export interface LocalStorageMetadata {
  history: {
    recordCount: number;
    bytes: number;
    maxRecords: number;
    maxBytes: number;
  };
  taskData: {
    taskCount: number;
    transcriptChunkCount: number;
    summaryCheckpointCount: number;
    bytes: number;
    maxBytes: number;
    maxTaskBytes: number;
  };
  model: {
    maxBytes: number;
  };
  browser: {
    usageBytes: number | null;
    quotaBytes: number | null;
  };
}

export const DEFAULT_HISTORY_STORAGE_LIMITS: HistoryStorageLimits = Object.freeze({
  maxRecords: HISTORY_STORAGE_RECORD_LIMIT,
  maxBytes: HISTORY_STORAGE_BUDGET_BYTES,
});

export const DEFAULT_TASK_DATA_STORAGE_LIMITS: TaskDataStorageLimits = Object.freeze({
  maxBytes: TASK_DATA_STORAGE_BUDGET_BYTES,
  maxTaskBytes: TASK_DATA_PER_TASK_BUDGET_BYTES,
});

export function storageError(code: "storage_quota_exceeded" | "storage_quota_unavailable", message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Value cannot be serialized for local storage");
  return new TextEncoder().encode(serialized).byteLength;
}

export function historySerializedBytes(records: readonly unknown[]): number {
  return serializedBytes(records);
}

export function resolveHistoryStorageLimits(overrides: Partial<HistoryStorageLimits> = {}): HistoryStorageLimits {
  const limits = { ...DEFAULT_HISTORY_STORAGE_LIMITS, ...overrides };
  if (!Number.isSafeInteger(limits.maxRecords) || limits.maxRecords < 1
    || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1) {
    throw new Error("Invalid local history storage limits");
  }
  return limits;
}

export function resolveTaskDataStorageLimits(overrides: Partial<TaskDataStorageLimits> = {}): TaskDataStorageLimits {
  const maxBytes = overrides.maxBytes ?? DEFAULT_TASK_DATA_STORAGE_LIMITS.maxBytes;
  const limits = {
    maxBytes,
    maxTaskBytes: overrides.maxTaskBytes ?? Math.min(DEFAULT_TASK_DATA_STORAGE_LIMITS.maxTaskBytes, maxBytes),
  };
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1
    || !Number.isSafeInteger(limits.maxTaskBytes) || limits.maxTaskBytes < 1
    || limits.maxTaskBytes > limits.maxBytes) {
    throw new Error("Invalid local task data storage limits");
  }
  return limits;
}

export function assertHistoryWriteAllowed(records: readonly unknown[], limits = DEFAULT_HISTORY_STORAGE_LIMITS): void {
  if (records.length > limits.maxRecords || historySerializedBytes(records) > limits.maxBytes) {
    throw storageError("storage_quota_exceeded", "Local completed history storage limit reached");
  }
}

export function taskDataSerializedBytes(snapshot: TaskDataSnapshot): number {
  return serializedBytes(snapshot);
}

export function assertTaskDataWriteAllowed(snapshot: TaskDataSnapshot, limits = DEFAULT_TASK_DATA_STORAGE_LIMITS): void {
  const violation = taskDataLimitViolation(snapshot, limits);
  if (violation) throw storageError("storage_quota_exceeded", violation);
}

export function assertTaskDataMutationAllowed(
  current: TaskDataSnapshot,
  projected: TaskDataSnapshot,
  limits = DEFAULT_TASK_DATA_STORAGE_LIMITS,
): void {
  const violation = taskDataLimitViolation(projected, limits);
  if (!violation) return;
  if (taskDataSerializedBytes(projected) > taskDataSerializedBytes(current)) {
    throw storageError("storage_quota_exceeded", violation);
  }
  const currentTaskBytes = taskDataBytesByTask(current);
  for (const [taskId, projectedBytes] of taskDataBytesByTask(projected)) {
    if (projectedBytes > (currentTaskBytes.get(taskId) ?? 0)) {
      throw storageError("storage_quota_exceeded", violation);
    }
  }
}

function taskDataLimitViolation(snapshot: TaskDataSnapshot, limits: TaskDataStorageLimits): string | null {
  if (taskDataSerializedBytes(snapshot) > limits.maxBytes) return "Local recoverable task storage limit reached";
  for (const bytes of taskDataBytesByTask(snapshot).values()) {
    if (bytes > limits.maxTaskBytes) return "Local per-task recoverable storage limit reached";
  }
  return null;
}

function taskDataBytesByTask(snapshot: TaskDataSnapshot): Map<string, number> {
  const grouped = new Map<string, { tasks: { jobId: string }[]; chunks: { taskId: string }[]; summaries: { taskId: string }[] }>();
  const group = (taskId: string) => {
    let value = grouped.get(taskId);
    if (!value) {
      value = { tasks: [], chunks: [], summaries: [] };
      grouped.set(taskId, value);
    }
    return value;
  };
  for (const task of snapshot.tasks) group(task.jobId).tasks.push(task);
  for (const chunk of snapshot.chunks) group(chunk.taskId).chunks.push(chunk);
  for (const summary of snapshot.summaries) group(summary.taskId).summaries.push(summary);
  return new Map([...grouped].map(([taskId, value]) => [taskId, taskDataSerializedBytes(value)]));
}

export async function assertStorageCapacity(
  requiredBytes: number,
  estimate: () => Promise<BrowserStorageEstimate> = browserStorageEstimate,
): Promise<void> {
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) throw new Error("Invalid storage capacity request");
  const { usage, quota } = await estimate();
  if (!Number.isFinite(usage) || usage! < 0 || !Number.isFinite(quota) || quota! < 0 || usage! > quota!) {
    throw storageError("storage_quota_unavailable", "Browser storage capacity is unavailable");
  }
  if (requiredBytes > quota! - usage!) {
    throw storageError("storage_quota_exceeded", "Browser storage does not have enough available capacity");
  }
}

export async function browserStorageEstimate(): Promise<BrowserStorageEstimate> {
  if (!globalThis.navigator?.storage?.estimate) return {};
  return globalThis.navigator.storage.estimate();
}
