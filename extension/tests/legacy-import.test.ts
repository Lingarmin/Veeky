import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importLegacyHistory } from "../src/local/legacy-import";
import { LocalAnalysisRepository } from "../src/local/repository";
import { contentKey, parseContentRef } from "../src/shared/content";

const origin = "http://127.0.0.1:8000";
const storageKey = "veeky.installationIdentity.v1";
const identity = { installationId: "existing-owner", installationToken: "a".repeat(43) };
const videoId = "dQw4w9WgXcQ";
const ref = { platform: "youtube", sourceContentId: videoId, mediaIndex: 1 };
const item = (jobId = "job-1") => ({
  jobId, contentId: "legacy-content-uuid", contentRef: ref, videoId, videoTitle: "Existing history",
  durationMs: 120000, sourceLanguage: "en", targetLanguage: "zh-Hans", completedAt: "2026-01-01T00:00:00Z",
  modelName: "kimi", modelVersion: "old-version",
});
const result = (jobId = "job-1") => {
  const { completedAt: _, ...metadata } = item(jobId);
  return { ...metadata, isGenerated: false, oneLineSummary: "Summary", summaryPoints: ["One"],
    chapters: [{ start_ms: 0, end_ms: 1000, title: "Start", summary: "Details" }], highlights: [],
    transcript: [{ id: "seg-1", startMs: 0, durationMs: 1000, original: "Hello", translated: "你好" }],
    partial: false, failureCode: null };
};
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

describe("explicit legacy history import", () => {
  let repository: LocalAnalysisRepository;
  let fetchMock: ReturnType<typeof vi.fn>;
  let get: ReturnType<typeof vi.fn>;
  let set: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    repository = new LocalAnalysisRepository({ indexedDB: new IDBFactory(), databaseName: "legacy-tests" });
    fetchMock = vi.fn();
    get = vi.fn().mockResolvedValue({ [storageKey]: identity });
    set = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("chrome", { storage: { local: { get, set } } });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("does not read credentials or access the network without explicit consent", async () => {
    await expect(importLegacyHistory({ confirmed: false, apiOrigin: origin, repository })).rejects.toThrow(/consent|confirm/i);
    expect(get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["https://example.com", "http://127.0.0.1:8001", "http://localhost:8000/path", "http://localhost:8000/", "http://user@localhost:8000", "http://127.1:8000"])("rejects unapproved origin %s before credentials are read", async (apiOrigin) => {
    await expect(importLegacyHistory({ confirmed: true, apiOrigin, repository })).rejects.toThrow(/origin/i);
    expect(get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires an existing identity and never creates or registers one", async () => {
    get.mockResolvedValue({});
    await expect(importLegacyHistory({ confirmed: true, apiOrigin: origin, repository })).rejects.toThrow(/identity/i);
    expect(get).toHaveBeenCalledWith(storageKey);
    expect(set).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("imports complete owned results via GET only, reconciles content identity and preserves repeats", async () => {
    const progress = vi.fn();
    fetchMock.mockImplementation((url: string) => Promise.resolve(url.includes("/history?")
      ? json({ items: [item()], hasMore: false }) : json(result())));
    expect(await importLegacyHistory({ confirmed: true, apiOrigin: origin, repository, onProgress: progress }))
      .toMatchObject({ imported: 1, skipped: 0, rejected: 0, scanned: 1, pages: 1 });
    const history = await repository.getCompletedHistory({ limit: 10, offset: 0 });
    expect(history.items).toHaveLength(1);
    const stored = await repository.getAnalysis(history.items[0].jobId);
    const browserRef = parseContentRef(`https://www.youtube.com/watch?v=${videoId}`)!;
    expect(browserRef).toEqual(ref);
    expect(stored).toMatchObject({ contentId: contentKey(browserRef), contentRef: browserRef, completedAt: item().completedAt, videoTitle: "Existing history" });
    expect((await repository.getLatestCompleted(browserRef))?.jobId).toBe(stored?.jobId);
    expect(stored?.legacySourceKey).toContain(origin);
    expect(stored?.legacySourceKey).toContain(identity.installationId);
    expect(stored?.legacySourceKey).toContain("job-1");
    expect(JSON.stringify(stored)).not.toContain(identity.installationToken);
    fetchMock.mockImplementation((url: string) => Promise.resolve(url.includes("/history?")
      ? json({ items: [item()], hasMore: false }) : json({ ...result(), videoTitle: "Changed remotely" })));
    expect(await importLegacyHistory({ confirmed: true, apiOrigin: origin, repository })).toMatchObject({ imported: 0, skipped: 1 });
    expect((await repository.getAnalysis(history.items[0].jobId))?.videoTitle).toBe("Existing history");
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:8000\/v1\/analyses\/(history\?|job-1\/result)/);
      expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit", headers: {
        Authorization: `Bearer ${identity.installationToken}`, "X-Veeky-Installation-Id": identity.installationId,
      } });
    }
    expect(set).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ imported: 1, scanned: 1 }));
  });

  it("does not retry authentication by registering an installation", async () => {
    fetchMock.mockResolvedValue(new Response('{"detail":{"code":"installation_auth_required"}}', { status: 401 }));
    await expect(importLegacyHistory({ confirmed: true, apiOrigin: origin, repository })).rejects.toThrow(/401|auth/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalled();
  });

  it.each([
    { platform: "youtube", sourceContentId: videoId, mediaIndex: 0 },
    { platform: "youtube", sourceContentId: "abc123", mediaIndex: 1 },
    { platform: "x", sourceContentId: "12345", mediaIndex: 0 },
    { platform: "x", sourceContentId: "0", mediaIndex: 1 },
    { platform: "x", sourceContentId: "18446744073709551616", mediaIndex: 1 },
  ])("rejects content references that the browser cannot resolve: %j", async (contentRef) => {
    fetchMock.mockResolvedValue(json({ items: [{ ...item(), contentRef, videoId: contentRef.platform === "youtube" ? contentRef.sourceContentId : null }], hasMore: false }));
    expect(await importLegacyHistory({ confirmed: true, apiOrigin: origin, repository })).toMatchObject({ imported: 0, rejected: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves X media indices supported by the backend and browser", async () => {
    const contentRef = parseContentRef("https://x.com/i/status/1234567890123456789/video/101")!;
    const metadata = { contentRef, videoId: null };
    fetchMock.mockResolvedValueOnce(json({ items: [{ ...item(), ...metadata }], hasMore: false }))
      .mockResolvedValueOnce(json({ ...result(), ...metadata }));
    expect(await importLegacyHistory({ confirmed: true, apiOrigin: origin, repository })).toMatchObject({ imported: 1, rejected: 0 });
    expect(await repository.getLatestCompleted(contentRef)).toMatchObject({ contentRef, contentId: contentKey(contentRef), videoId: null });
  });

  it("follows bounded history pagination and reports progress", async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(url.includes("/history?")
      ? json({ items: [item(url.includes("offset=0") ? "first" : "second")], hasMore: url.includes("offset=0") })
      : json(result(url.includes("first") ? "first" : "second"))));
    expect(await importLegacyHistory({ confirmed: true, apiOrigin: "http://localhost:8000", repository }))
      .toMatchObject({ imported: 2, pages: 2, scanned: 2 });
    expect(fetchMock.mock.calls.some(([url]) => url.includes("offset=1"))).toBe(true);
  });

  it.each([
    { partial: true }, { failureCode: "translation_failed" }, { durationMs: 14400001 },
    { transcript: [{ id: "s", startMs: -1, durationMs: 1, original: "x", translated: "y" }] },
    { chapters: [{ start_ms: 0, end_ms: 130000, title: "x", summary: "y" }] },
    { summaryPoints: [{ apiKey: "secret" }] },
    { contentRef: { ...ref, installationToken: "secret" } },
    { transcript: [{ id: "s", startMs: 0, durationMs: 1, original: "x", translated: "y", secret: "secret" }] },
    { jobId: "someone-else" }, { videoId: "different-video" },
    { contentRef: { ...ref, sourceContentId: "other-video" } },
    { llmConfig: { apiKey: "secret" } },
  ])("rejects invalid or incomplete result %j without storing it", async (changes) => {
    fetchMock.mockResolvedValueOnce(json({ items: [item()], hasMore: false })).mockResolvedValueOnce(json({ ...result(), ...changes }));
    expect(await importLegacyHistory({ confirmed: true, apiOrigin: origin, repository })).toMatchObject({ imported: 0, rejected: 1 });
    expect((await repository.getCompletedHistory({ limit: 10, offset: 0 })).items).toEqual([]);
  });

  it("rejects malformed history before fetching its result", async () => {
    fetchMock.mockResolvedValue(json({ items: [{ ...item(), completedAt: "invalid" }], hasMore: false }));
    expect(await importLegacyHistory({ confirmed: true, apiOrigin: origin, repository })).toMatchObject({ rejected: 1, imported: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds response bytes and never follows redirects", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { headers: { "Content-Length": "99999999" } }));
    await expect(importLegacyHistory({ confirmed: true, apiOrigin: origin, repository })).rejects.toThrow(/large|limit/i);
  });

  it("honors cancellation before reading credentials", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(importLegacyHistory({ confirmed: true, apiOrigin: origin, repository, signal: controller.signal })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("cancels a stalled response body without storing data", async () => {
    const controller = new AbortController();
    const cancelled = vi.fn();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    fetchMock.mockImplementation(() => {
      markStarted();
      return Promise.resolve(new Response(new ReadableStream({ cancel: cancelled })));
    });
    const pending = importLegacyHistory({ confirmed: true, apiOrigin: origin, repository, signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow(/cancel/i);
    await started;
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await assertion;
    expect(cancelled).toHaveBeenCalledOnce();
    expect((await repository.getCompletedHistory({ limit: 10, offset: 0 })).items).toEqual([]);
  });

  it("times out a request even if fetch ignores its abort signal", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const assertion = expect(importLegacyHistory({ confirmed: true, apiOrigin: origin, repository })).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(30_001);
    await assertion;
  });

  it("bounds streamed bytes even without a content length", async () => {
    fetchMock.mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); controller.close(); },
    })));
    await expect(importLegacyHistory({ confirmed: true, apiOrigin: origin, repository })).rejects.toThrow(/size limit/i);
  });

  it("bounds endlessly repeating pages and does not import duplicate source jobs", async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(url.includes("/history?")
      ? json({ items: [item()], hasMore: true }) : json(result())));
    await expect(importLegacyHistory({ confirmed: true, apiOrigin: origin, repository })).rejects.toThrow(/page limit/i);
    expect(fetchMock).toHaveBeenCalledTimes(101);
    expect((await repository.getCompletedHistory({ limit: 10, offset: 0 })).items).toHaveLength(1);
  });

  it("does not persist the current installation token echoed inside an otherwise allowed result field", async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [item()], hasMore: false }))
      .mockResolvedValueOnce(json({ ...result(), oneLineSummary: `Leaked ${identity.installationToken}` }));
    expect(await importLegacyHistory({ confirmed: true, apiOrigin: origin, repository })).toMatchObject({ imported: 0, rejected: 1 });
    expect((await repository.getCompletedHistory({ limit: 10, offset: 0 })).items).toEqual([]);
  });
});
