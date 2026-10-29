import { describe, expect, it } from "vitest";
import {
  HISTORY_STORAGE_BUDGET_BYTES,
  HISTORY_STORAGE_RECORD_LIMIT,
  MODEL_STORAGE_BUDGET_BYTES,
  TASK_DATA_PER_TASK_BUDGET_BYTES,
  TASK_DATA_STORAGE_BUDGET_BYTES,
  assertHistoryWriteAllowed,
  assertStorageCapacity,
  assertTaskDataWriteAllowed,
  historySerializedBytes,
  resolveTaskDataStorageLimits,
  taskDataSerializedBytes,
} from "../src/local/storage";

describe("standalone local storage policy", () => {
  it("keeps model data and completed history in separate configured budgets", () => {
    expect(MODEL_STORAGE_BUDGET_BYTES).toBe(1024 ** 3);
    expect(HISTORY_STORAGE_BUDGET_BYTES).toBe(100 * 1024 ** 2);
    expect(HISTORY_STORAGE_RECORD_LIMIT).toBe(1000);
    expect(TASK_DATA_STORAGE_BUDGET_BYTES).toBe(256 * 1024 ** 2);
    expect(TASK_DATA_PER_TASK_BUDGET_BYTES).toBe(64 * 1024 ** 2);
  });

  it("measures and bounds aggregate and per-task recoverable data", () => {
    const snapshot = {
      tasks: [{ jobId: "one", title: "你好" }, { jobId: "two", title: "small" }],
      chunks: [{ taskId: "one", text: "large transcript" }],
      summaries: [{ taskId: "two", text: "summary" }],
    };
    const bytes = taskDataSerializedBytes(snapshot);
    expect(bytes).toBe(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength);
    expect(() => assertTaskDataWriteAllowed(snapshot, { maxBytes: bytes, maxTaskBytes: bytes })).not.toThrow();
    expect(() => assertTaskDataWriteAllowed(snapshot, { maxBytes: bytes - 1, maxTaskBytes: bytes }))
      .toThrow(expect.objectContaining({ code: "storage_quota_exceeded" }));
    expect(() => assertTaskDataWriteAllowed(snapshot, { maxBytes: bytes, maxTaskBytes: 1 }))
      .toThrow(expect.objectContaining({ code: "storage_quota_exceeded" }));
  });

  it("keeps partial task-data limit overrides internally consistent", () => {
    expect(resolveTaskDataStorageLimits({ maxBytes: 100 })).toEqual({ maxBytes: 100, maxTaskBytes: 100 });
  });

  it("measures serialized UTF-8 bytes and rejects writes over either history limit", () => {
    const rows = [{ title: "你好" }];
    expect(historySerializedBytes(rows)).toBe(new TextEncoder().encode(JSON.stringify(rows)).byteLength);
    expect(() => assertHistoryWriteAllowed(rows, { maxRecords: 1, maxBytes: 100 })).not.toThrow();
    expect(() => assertHistoryWriteAllowed([...rows, { title: "second" }], { maxRecords: 1, maxBytes: 100 }))
      .toThrow(expect.objectContaining({ code: "storage_quota_exceeded" }));
    expect(() => assertHistoryWriteAllowed(rows, { maxRecords: 10, maxBytes: 5 }))
      .toThrow(expect.objectContaining({ code: "storage_quota_exceeded" }));
  });

  it("checks browser capacity before a bounded write without treating unknown estimates as free space", async () => {
    await expect(assertStorageCapacity(60, async () => ({ usage: 50, quota: 100 })))
      .rejects.toMatchObject({ code: "storage_quota_exceeded" });
    await expect(assertStorageCapacity(50, async () => ({ usage: 50, quota: 100 }))).resolves.toBeUndefined();
    await expect(assertStorageCapacity(1, async () => ({})))
      .rejects.toMatchObject({ code: "storage_quota_unavailable" });
  });
});
