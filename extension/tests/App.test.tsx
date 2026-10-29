import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App } from "../src/sidepanel/App";
import type { AnalysisApi } from "../src/sidepanel/api";
import { browserBridge, type BrowserBridge } from "../src/sidepanel/browser";
import type { MediaCandidate, MediaUploadNotification } from "../src/shared/types";
import { browserLlmConfigStore, defaultLlmConfig } from "../src/sidepanel/llm";
import type { LlmConfig, LlmProvider } from "../src/sidepanel/llm";
import * as legacyImport from "../src/local/legacy-import";
import type { LocalStorageMetadata } from "../src/local/storage";

const youtubeContentId = "33333333-3333-4333-8333-333333333333";
const youtubeContentRef = {
  platform: "youtube" as const,
  sourceContentId: "aircAruvnKk",
  mediaIndex: 1,
};
const xContentId = "55555555-5555-4555-8555-555555555555";
const xContentRef = {
  platform: "x" as const,
  sourceContentId: "2075545587093807111",
  mediaIndex: 1,
};
const xCandidate = {
  url: "https://video.twimg.com/amplify_video/123/file.mp4",
  kind: "mp4" as const,
  capturedAt: 1_788_419_200_000,
};

function createApi() {
  return {
    inspect: vi.fn<AnalysisApi["inspect"]>(async () => ({
      contentId: youtubeContentId,
      contentRef: youtubeContentRef,
      videoId: "aircAruvnKk",
      durationMs: 2000,
      sourceStatus: "ready",
      transcriptSource: "youtube_caption",
      availableLanguages: [
        { languageCode: "en", languageName: "English", isGenerated: false, isTranslatable: true },
      ],
      tracks: [
        { languageCode: "en", languageName: "English", isGenerated: false, isTranslatable: true },
      ],
      selectedLanguage: "en",
    })),
    testLlm: vi.fn<AnalysisApi["testLlm"]>(async () => ({ ok: true, message: "连接成功" })),
    createAnalysis: vi.fn<AnalysisApi["createAnalysis"]>(async () => ({
      jobId: "job-1",
      cacheHit: false,
      status: "queued",
      contentId: youtubeContentId,
      contentRef: youtubeContentRef,
      videoId: "aircAruvnKk",
    })),
    getHistory: vi.fn<AnalysisApi["getHistory"]>(async () => ({ items: [], hasMore: false })),
    getStatus: vi.fn<AnalysisApi["getStatus"]>(async () => ({
      jobId: "job-1", status: "completed", failureCode: null, failureDetail: null,
    })),
    getResult: vi.fn<AnalysisApi["getResult"]>(async () => ({
      jobId: "job-1",
      contentId: youtubeContentId,
      contentRef: youtubeContentRef,
      videoId: "aircAruvnKk",
      videoTitle: "But what is a neural network?",
      durationMs: 2000,
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
      isGenerated: false,
      oneLineSummary: "视频解释神经网络如何识别手写数字。",
      summaryPoints: ["输入层保存像素值"],
      chapters: [{ start_ms: 0, end_ms: 2000, title: "输入层", summary: "从像素开始" }],
      highlights: [],
      transcript: [
        { id: "one", startMs: 0, durationMs: 1000, original: "Pixels", translated: "像素" },
      ],
      partial: false,
      failureCode: null,
      modelName: "fake",
      modelVersion: "test",
    })),
  } satisfies AnalysisApi;
}

function createLlmStore() {
  return {
    load: vi.fn(async (provider: LlmProvider = "kimi") => ({ ...defaultLlmConfig(provider), apiKey: provider === "kimi" ? "test-key" : `${provider}-key` })),
    save: vi.fn(async () => undefined),
  };
}

function createEmptyLlmStore() {
  return {
    load: vi.fn(async (provider: LlmProvider = "kimi") => defaultLlmConfig(provider)),
    save: vi.fn(async () => undefined),
  };
}

function createBrowser() {
  return {
    getActiveContext: vi.fn<BrowserBridge["getActiveContext"]>(async () => ({
      tabId: 7,
      url: "https://www.youtube.com/watch?v=aircAruvnKk",
      title: "But what is a neural network?",
      videoId: "aircAruvnKk",
      analysis: null,
    })),
    registerAnalysis: vi.fn<BrowserBridge["registerAnalysis"]>(async () => undefined),
    seek: vi.fn<BrowserBridge["seek"]>(async () => undefined),
    getMediaCandidates: vi.fn<BrowserBridge["getMediaCandidates"]>(async () => [xCandidate]),
    startMediaUpload: vi.fn(async () => true),
    showSubtitles: vi.fn(async () => undefined),
    onMediaUpload: vi.fn<BrowserBridge["onMediaUpload"]>(() => () => undefined),
  };
}

function createXBrowser() {
  return {
    ...createBrowser(),
    getActiveContext: vi.fn<BrowserBridge["getActiveContext"]>(async () => ({
      tabId: 7,
      url: "https://x.com/owner/status/2075545587093807111/video/1",
      title: "X video",
      contentRef: xContentRef,
      durationMs: 30_000,
      videoId: null,
      analysis: null,
    })),
  };
}

function createProcessingBrowser() {
  const browser = createBrowser();
  browser.getActiveContext.mockResolvedValue({
    tabId: 7,
    url: "https://www.youtube.com/watch?v=aircAruvnKk",
    title: "But what is a neural network?",
    contentRef: youtubeContentRef,
    videoId: "aircAruvnKk",
    analysis: {
      tabId: 7,
      contentRef: youtubeContentRef,
      videoId: "aircAruvnKk",
      jobId: "job-processing",
    },
  });
  return browser;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function xInspection(sourceStatus: "ready" | "play_required" | "media_required" = "ready") {
  return {
    contentId: xContentId,
    contentRef: xContentRef,
    videoId: null,
    durationMs: 30_000,
    sourceStatus,
    transcriptSource: "faster_whisper" as const,
    availableLanguages: [],
    tracks: [],
    selectedLanguage: "auto",
  };
}

function mockAutomaticThenManualInspection(
  api: ReturnType<typeof createApi>,
  manualInspection = xInspection(),
) {
  api.inspect
    .mockResolvedValueOnce(xInspection("media_required"))
    .mockResolvedValueOnce(manualInspection);
}

const historyItem = {
  jobId: "job-history",
  contentId: youtubeContentId,
  contentRef: youtubeContentRef,
  videoId: "aircAruvnKk",
  videoTitle: "Neural networks",
  durationMs: 754_000,
  sourceLanguage: "en",
  targetLanguage: "zh-Hans",
  completedAt: "2026-08-11T09:40:00Z",
  modelName: "deepseek",
  modelVersion: "deepseek-v4-flash",
};

describe("history storage notices", () => {
  function metadata(): LocalStorageMetadata {
    return {
      history: { recordCount: 6, bytes: 700_000, maxRecords: 1000, maxBytes: 100 * 1024 ** 2 },
      taskData: { taskCount: 0, transcriptChunkCount: 0, summaryCheckpointCount: 0, bytes: 0, maxBytes: 256 * 1024 ** 2, maxTaskBytes: 64 * 1024 ** 2 },
      model: { maxBytes: 1024 ** 3 },
      browser: { usageBytes: null, quotaBytes: null },
    };
  }

  async function openHistory(storage: LocalStorageMetadata) {
    const api = {
      ...createApi(),
      getHistory: vi.fn(async () => ({ items: [historyItem], hasMore: false })),
      getStorageMetadata: vi.fn(async () => storage),
    };
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={createLlmStore()} />);
    await user.click(screen.getByRole("button", { name: "历史记录" }));
    await screen.findByRole("heading", { name: "历史记录" });
    await waitFor(() => expect(screen.queryByText("正在加载历史记录...")).not.toBeInTheDocument());
  }

  it("hides the completed label and persistent storage explanations when capacity is available", async () => {
    await openHistory(metadata());
    expect(screen.queryByText("已完成", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryAllByText(/已保存 \d+ \/|历史占用|任务与进度占用|存储空间不足/)).toHaveLength(0);
    expect(screen.getByRole("button", { name: "打开 Neural networks" })).toBeInTheDocument();
  });

  it.each([
    ["record count", 0.899, false], ["record count", 0.9, true], ["record count", 1, true], ["record count", 1.1, true],
    ["history bytes", 0.899, false], ["history bytes", 0.9, true], ["history bytes", 1, true], ["history bytes", 1.1, true],
    ["task bytes", 0.899, false], ["task bytes", 0.9, true], ["task bytes", 1, true], ["task bytes", 1.1, true],
  ] as const)("only prompts cleanup for %s at usage %s (visible=%s)", async (limit, ratio, visible) => {
    const storage = metadata();
    if (limit === "record count") storage.history.recordCount = Math.floor(storage.history.maxRecords * ratio);
    if (limit === "history bytes") storage.history.bytes = Math.ceil(storage.history.maxBytes * ratio);
    if (limit === "task bytes") storage.taskData.bytes = Math.ceil(storage.taskData.maxBytes * ratio);
    await openHistory(storage);
    const historyNotice = screen.queryByText("历史记录存储空间不足，请清理不再需要的记录。");
    const taskNotice = screen.queryByText("任务与进度存储空间不足，请在上方放弃不再需要的暂停任务。");
    expect(Boolean(historyNotice)).toBe(visible && limit !== "task bytes");
    expect(Boolean(taskNotice)).toBe(visible && limit === "task bytes");
    expect(screen.queryAllByText(/已保存 \d+ \/|历史占用|任务与进度占用/)).toHaveLength(0);
  });
});

describe("standalone migration consent", () => {
  it.each([true, false])("keeps a resumed task visible when current tab matches=%s", async (matches) => {
    vi.stubGlobal("chrome", { storage: { local: { get: async () => ({}) } } });
    try {
      const task = { jobId: "paused-1", videoTitle: "Paused video", contentRef: youtubeContentRef, failureCode: "analysis_interrupted" };
      let resumed = false;
      const base = createApi();
      const api = {
        ...base,
        resume: vi.fn(async () => { resumed = true; return { ...await base.createAnalysis({} as never), jobId: task.jobId }; }),
        getRecoverableTasks: vi.fn(async () => resumed ? [] : [task]),
      };
      const browser = matches ? createBrowser() : createXBrowser();
      browser.registerAnalysis.mockRejectedValue(new Error("Tab closed"));
      const user = userEvent.setup();
      render(<App api={api} browser={browser} llmStore={createLlmStore()} />);
      await screen.findByRole("button", { name: matches ? "检查当前视频字幕" : "检查当前视频" });
      await user.click(await screen.findByRole("button", { name: "继续此任务" }));
      await screen.findByText("视频解释神经网络如何识别手写数字。");
      expect(api.getStatus).toHaveBeenCalledWith(task.jobId);
      if (matches) expect(browser.registerAnalysis).toHaveBeenCalledWith(7, youtubeContentRef, task.jobId);
      else expect(browser.registerAnalysis).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("keeps recoverable work until discard is explicitly confirmed", async () => {
    vi.stubGlobal("chrome", { storage: { local: { get: async () => ({}) } } });
    try {
    const task = { jobId: "paused-1", videoTitle: "Paused video", contentRef: youtubeContentRef, failureCode: "analysis_interrupted" };
    const discardRecoverableTask = vi.fn(async () => undefined);
    const api = { ...createApi(), resume: vi.fn(), getRecoverableTasks: vi.fn(async () => [task]), discardRecoverableTask };
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={createLlmStore()} />);
    await user.click(await screen.findByRole("button", { name: "放弃任务" }));
    expect(discardRecoverableTask).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByRole("button", { name: "继续此任务" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "放弃任务" }));
    await user.click(screen.getByRole("button", { name: "确认放弃任务" }));
    expect(discardRecoverableTask).toHaveBeenCalledWith("paused-1");
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "可恢复任务" })).not.toBeInTheDocument());
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([true, false])("requires consent and handles optional permission granted=%s", async (granted) => {
    const request = vi.fn(async () => granted);
    const remove = vi.fn(async () => true);
    const set = vi.fn(async () => {});
    vi.stubGlobal("chrome", { permissions: { request, remove }, storage: { local: { get: async () => ({}), set } } });
    const imported = vi.spyOn(legacyImport, "importLegacyHistory").mockResolvedValue({ pages: 1, scanned: 1, imported: 1, skipped: 0, rejected: 0 });
    try {
      const api = { ...createApi(), resume: vi.fn(), getRecoverableTasks: vi.fn(async () => []) };
      const user = userEvent.setup();
      render(<App api={api} browser={createBrowser()} llmStore={createLlmStore()} />);
      await screen.findByRole("button", { name: "检查当前视频字幕" });
      await user.click(screen.getByRole("button", { name: "历史记录" }));
      const button = await screen.findByRole("button", { name: "导入" });
      expect(button.querySelector("svg.lucide-import")).not.toBeNull();
      expect(screen.getByRole("heading", { name: "历史记录" }).closest(".view-heading")).toContainElement(button);
      expect(button).toBeDisabled();
      expect(request).not.toHaveBeenCalled();
      expect(imported).not.toHaveBeenCalled();
      await user.click(screen.getByRole("checkbox", { name: /从旧本地服务导入/ }));
      await user.click(button);
      expect(request).toHaveBeenCalledWith({ origins: ["http://127.0.0.1:8000/*"] });
      if (granted) {
        await waitFor(() => expect(remove).toHaveBeenCalledWith({ origins: ["http://127.0.0.1:8000/*"] }));
        expect(imported).toHaveBeenCalledWith(expect.objectContaining({ confirmed: true, apiOrigin: "http://127.0.0.1:8000", signal: expect.any(AbortSignal) }));
        expect(await screen.findByText(/导入完成。已导入 1 条/)).toBeInTheDocument();
        expect(screen.queryByRole("checkbox", { name: /从旧本地服务导入/ })).not.toBeInTheDocument();
        expect(set).toHaveBeenCalledWith({ "veeky.legacyHistoryImportCompleted.v1": true });
      } else {
        expect(imported).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        expect(await screen.findByText("未授权访问旧本地服务，未导入记录。")).toBeInTheDocument();
        expect(screen.getByRole("checkbox", { name: /从旧本地服务导入/ })).toBeInTheDocument();
        expect(set).not.toHaveBeenCalled();
      }
    } finally { imported.mockRestore(); vi.unstubAllGlobals(); }
  });

  function migrationFixture(initial: Record<string, unknown> = {}) {
    const stored = { ...initial };
    const set = vi.fn(async (values: Record<string, unknown>) => { Object.assign(stored, values); });
    const request = vi.fn(async () => true);
    const remove = vi.fn(async () => true);
    vi.stubGlobal("chrome", { permissions: { request, remove }, storage: { local: { get: async () => ({ ...stored }), set } } });
    const api = { ...createApi(), resume: vi.fn(), getRecoverableTasks: vi.fn(async () => []) };
    const imported = vi.spyOn(legacyImport, "importLegacyHistory").mockResolvedValue({ pages: 1, scanned: 1, imported: 1, skipped: 0, rejected: 0 });
    const user = userEvent.setup();
    const open = async () => {
      const view = render(<App api={api} browser={createBrowser()} llmStore={createLlmStore()} />);
      await screen.findByRole("button", { name: "检查当前视频字幕" });
      await user.click(screen.getByRole("button", { name: "历史记录" }));
      return view;
    };
    return { api, user, imported, request, remove, set, open };
  }

  it.each(["success", "failed", "cancelled", "denied"])("shows %s import feedback in a toast that expires after five seconds", async (outcome) => {
    const fixture = migrationFixture({ "veeky.legacyHistoryImportCompleted.v1": true });
    if (outcome === "denied") fixture.request.mockResolvedValue(false);
    if (outcome === "failed") fixture.imported.mockRejectedValue(new Error("offline"));
    if (outcome === "cancelled") fixture.imported.mockImplementation(({ signal }) => new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    try {
      await fixture.open();
      vi.useFakeTimers();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "导入" })); });
      if (outcome === "cancelled") await act(async () => { fireEvent.click(screen.getByRole("button", { name: "停止导入" })); });
      const message = screen.getByText(outcome === "success" ? /导入完成/ : outcome === "failed" ? /导入未完成/ : outcome === "cancelled" ? /导入已停止/ : /未授权访问旧本地服务/);
      expect(screen.getByRole("complementary", { name: "历史导入提示" })).toContainElement(message);
      expect(message.closest(".history-import-note")).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
      expect(message).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(screen.queryByRole("complementary", { name: "历史导入提示" })).not.toBeInTheDocument();
      expect(message).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "历史记录" })).toBeInTheDocument();
    } finally { vi.useRealTimers(); fixture.imported.mockRestore(); vi.unstubAllGlobals(); }
  });

  it("keeps the import progress toast and stop action available until the import settles", async () => {
    const fixture = migrationFixture({ "veeky.legacyHistoryImportCompleted.v1": true });
    fixture.imported.mockImplementation(({ signal, onProgress }) => new Promise((_, reject) => {
      onProgress?.({ pages: 1, scanned: 2, imported: 1, skipped: 1, rejected: 0 });
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    try {
      await fixture.open();
      vi.useFakeTimers();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "导入" })); });
      const notice = screen.getByRole("complementary", { name: "历史导入提示" });
      expect(notice).toHaveTextContent("已导入 1 条，已存在 1 条");
      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
      expect(notice).toBeInTheDocument();
      expect(notice).toContainElement(screen.getByRole("button", { name: "停止导入" }));
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "停止导入" })); });
      expect(notice).toHaveTextContent("导入已停止");
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(notice).not.toBeInTheDocument();
    } finally {
      const stop = screen.queryByRole("button", { name: "停止导入" });
      if (stop) await act(async () => { fireEvent.click(stop); });
      vi.useRealTimers(); fixture.imported.mockRestore(); vi.unstubAllGlobals();
    }
  });

  it("lets the user dismiss the import toast without removing history", async () => {
    const fixture = migrationFixture({ "veeky.legacyHistoryImportCompleted.v1": true });
    fixture.api.getHistory.mockImplementation(async (options) => ({
      items: options?.videoId || options?.contentId ? [] : [historyItem], hasMore: false,
    }));
    try {
      await fixture.open();
      await fixture.user.click(screen.getByRole("button", { name: "导入" }));
      await screen.findByText(/导入完成/);
      await fixture.user.click(screen.getByRole("button", { name: "关闭导入提示" }));
      expect(screen.queryByRole("complementary", { name: "历史导入提示" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "打开 Neural networks" })).toBeInTheDocument();
    } finally { fixture.imported.mockRestore(); vi.unstubAllGlobals(); }
  });

  it("gives each repeated import toast a fresh expiration timer", async () => {
    const fixture = migrationFixture({ "veeky.legacyHistoryImportCompleted.v1": true });
    try {
      await fixture.open();
      vi.useFakeTimers();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "导入" })); });
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "导入" })); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(screen.getByRole("complementary", { name: "历史导入提示" })).toHaveTextContent("导入完成");
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      expect(screen.queryByRole("complementary", { name: "历史导入提示" })).not.toBeInTheDocument();
    } finally { vi.useRealTimers(); fixture.imported.mockRestore(); vi.unstubAllGlobals(); }
  });

  it("remembers a successful import across remounts and allows explicit repeat imports", async () => {
    const fixture = migrationFixture();
    try {
      const first = await fixture.open();
      await fixture.user.click(screen.getByRole("checkbox", { name: /从旧本地服务导入/ }));
      await fixture.user.click(screen.getByRole("button", { name: "导入" }));
      await screen.findByText(/导入完成/);
      first.unmount();
      await fixture.open();
      expect(screen.queryByRole("checkbox", { name: /从旧本地服务导入/ })).not.toBeInTheDocument();
      expect(fixture.imported).toHaveBeenCalledTimes(1);
      expect(fixture.request).toHaveBeenCalledTimes(1);
      await fixture.user.click(screen.getByRole("button", { name: "导入" }));
      await waitFor(() => expect(fixture.imported).toHaveBeenCalledTimes(2));
      await screen.findByText(/导入完成/);
    } finally { fixture.imported.mockRestore(); vi.unstubAllGlobals(); }
  });

  it("recognizes old imported records without starting another import", async () => {
    const fixture = migrationFixture();
    fixture.api.getHistory.mockImplementation(async (options) => ({
      items: options?.videoId || options?.contentId ? [] : [{ ...historyItem, jobId: "import:old-installation:old-job" }], hasMore: false,
    }));
    try {
      await fixture.open();
      await screen.findByRole("button", { name: "打开 Neural networks" });
      expect(screen.queryByRole("checkbox", { name: /从旧本地服务导入/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "导入" })).toBeEnabled();
      expect(fixture.imported).not.toHaveBeenCalled();
      expect(fixture.request).not.toHaveBeenCalled();
    } finally { fixture.imported.mockRestore(); vi.unstubAllGlobals(); }
  });

  it.each(["failed", "cancelled"])("keeps first-import consent visible when import is %s", async (outcome) => {
    const fixture = migrationFixture();
    fixture.imported.mockImplementation(({ signal }) => new Promise((_, reject) => {
      if (outcome === "failed") reject(new Error("offline"));
      else signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    try {
      await fixture.open();
      await fixture.user.click(screen.getByRole("checkbox", { name: /从旧本地服务导入/ }));
      await fixture.user.click(screen.getByRole("button", { name: "导入" }));
      if (outcome === "cancelled") await fixture.user.click(await screen.findByRole("button", { name: "停止导入" }));
      await screen.findByText(outcome === "failed" ? /导入未完成/ : /导入已停止/);
      expect(screen.getByRole("checkbox", { name: /从旧本地服务导入/ })).toBeInTheDocument();
      expect(fixture.set).not.toHaveBeenCalled();
      expect(fixture.remove).toHaveBeenCalledWith({ origins: ["http://127.0.0.1:8000/*"] });
    } finally { fixture.imported.mockRestore(); vi.unstubAllGlobals(); }
  });

  it("does not report imported records as failed if saving the preference fails", async () => {
    const fixture = migrationFixture();
    fixture.set.mockRejectedValue(new Error("storage unavailable"));
    try {
      await fixture.open();
      await fixture.user.click(screen.getByRole("checkbox", { name: /从旧本地服务导入/ }));
      await fixture.user.click(screen.getByRole("button", { name: "导入" }));
      await screen.findByText(/导入完成/);
      expect(screen.queryByText(/导入未完成/)).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox", { name: /从旧本地服务导入/ })).not.toBeInTheDocument();
    } finally { fixture.imported.mockRestore(); vi.unstubAllGlobals(); }
  });
});

describe("Official LLM settings", () => {
  it("keeps explanatory copy behind one keyboard-accessible info icon", async () => {
    const user = userEvent.setup();
    const api = createApi();
    const store = createLlmStore();
    render(<App api={api} browser={createBrowser()} llmStore={store} />);
    await user.click(await screen.findByRole("button", { name: "LLM 设置" }));
    const help = screen.getByRole("button", { name: "使用说明" });
    expect(help.textContent).toBe("");
    expect(help.querySelector("svg.lucide-info")).not.toBeNull();
    const notes = [
      screen.getByText(/默认仅本次使用/),
      screen.getByText(/测试会从插件直连/),
      screen.getByText(/API Key 仅由扩展内部/),
      screen.getByText(/字幕会发送给你选择的官方 LLM/),
    ];
    expect(help).toHaveAttribute("aria-expanded", "false");
    for (const note of notes) expect(note).not.toBeVisible();
    expect(screen.getByRole("checkbox", { name: "记住在此设备" })).toBeVisible();
    expect(screen.getByRole("button", { name: "测试连通" })).toBeVisible();
    expect(screen.getByRole("button", { name: "保存配置" })).toBeVisible();

    await user.click(help);
    expect(help).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(help.getAttribute("aria-controls")!)).toBeVisible();
    for (const note of notes) expect(note).toBeVisible();
    await user.keyboard("{Enter}");
    expect(help).toHaveAttribute("aria-expanded", "false");
    for (const note of notes) expect(note).not.toBeVisible();
    await user.keyboard(" ");
    expect(help).toHaveAttribute("aria-expanded", "true");
    expect(api.testLlm).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "返回" }));
    await user.click(screen.getByRole("button", { name: "LLM 设置" }));
    expect(screen.getByRole("button", { name: "使用说明" })).toHaveAttribute("aria-expanded", "false");
  });

  it("previews help on hover and keeps it open while the pointer reads the popup", async () => {
    const user = userEvent.setup();
    render(<App api={createApi()} browser={createBrowser()} llmStore={createLlmStore()} />);
    await user.click(await screen.findByRole("button", { name: "LLM 设置" }));
    const icon = screen.getByRole("button", { name: "使用说明" });
    await user.hover(icon);
    const popup = await screen.findByRole("dialog", { name: "LLM 使用说明" });
    expect(popup).toBeVisible();
    await user.hover(popup);
    expect(popup).toBeVisible();
    await user.unhover(popup);
    await waitFor(() => expect(popup).not.toBeVisible());
    expect(icon).toHaveAttribute("aria-expanded", "false");
  });

  it("pins clicked help and dismisses it with Escape, an outside click or keyboard focus", async () => {
    const user = userEvent.setup();
    render(<App api={createApi()} browser={createBrowser()} llmStore={createLlmStore()} />);
    await user.click(await screen.findByRole("button", { name: "LLM 设置" }));
    const icon = screen.getByRole("button", { name: "使用说明" });
    await user.click(icon);
    const popup = screen.getByRole("dialog", { name: "LLM 使用说明" });
    await user.hover(screen.getByRole("heading", { name: "配置 LLM" }));
    expect(popup).toBeVisible();
    await user.keyboard("{Escape}");
    expect(popup).not.toBeVisible();
    expect(icon).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(popup).toBeVisible();
    await user.click(screen.getByLabelText("API Key"));
    expect(popup).not.toBeVisible();
    await user.click(icon);
    await user.tab();
    expect(popup).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(popup).not.toBeVisible();
    expect(icon).toHaveFocus();
    await user.keyboard(" ");
    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: "测试连通" })).toHaveFocus();
    expect(popup).not.toBeVisible();
  });

  it("defaults to session keys and saves the remember preference without sending it to the provider", async () => {
    const user = userEvent.setup();
    const store = createLlmStore();
    const api = createApi();
    render(<App api={api} browser={createBrowser()} llmStore={store} />);
    await user.click(await screen.findByRole("button", { name: "LLM 设置" }));
    expect(screen.getByRole("checkbox", { name: "记住在此设备" })).not.toBeChecked();
    expect(screen.getByText(/仅本次使用/)).toBeInTheDocument();
    expect(screen.getByText(/字幕会发送给.*官方 LLM.*翻译和摘要/)).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "记住在此设备" }));
    await user.click(screen.getByRole("button", { name: "测试连通" }));
    await waitFor(() => expect(store.save).toHaveBeenCalledWith(expect.objectContaining({ rememberOnDevice: true })));
    expect(api.testLlm).toHaveBeenCalledWith({ ...defaultLlmConfig("kimi"), apiKey: "test-key" });
    expect(api.testLlm.mock.calls[0][0]).not.toHaveProperty("rememberOnDevice");
  });

  it("shows five providers, a readonly URL, editable model and probe warning", async () => {
    const user = userEvent.setup();
    render(<App api={createApi()} browser={createBrowser()} llmStore={createLlmStore()} />);
    await user.click(await screen.findByRole("button", { name: "LLM 设置" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Kimi", "DeepSeek", "腾讯混元", "通义千问", "智谱 GLM"]);
    expect(screen.getByLabelText("API URL")).toHaveAttribute("readonly");
    expect(screen.getByText(/仅支持.*官方.*不支持.*中转/)).toBeInTheDocument();
    expect(screen.getByText(/少量费用.*不保证.*长任务/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Provider"), "hunyuan");
    expect(screen.getByLabelText("API URL")).toHaveValue("https://tokenhub.tencentmaas.com/v1");
    expect(screen.getByText(/2026-09-30.*TokenHub/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText("模型"));
    await user.type(screen.getByLabelText("模型"), "editable-model");
    expect(screen.getByLabelText("模型")).toHaveValue("editable-model");
  });

  it("quarantines a real stored relay key until a new official key is explicitly tested", async () => {
    const raw = { kimiLlmConfig: { apiUrl: "https://relay.example/v1", apiKey: "old-relay-key", model: "kimi-k2.5" } };
    const stored = structuredClone(raw) as Record<string, unknown>;
    const set = vi.fn(async (values: Record<string, unknown>) => { Object.assign(stored, values); });
    const sessionData: Record<string, unknown> = {};
    vi.stubGlobal("chrome", { storage: {
      local: {
        get: vi.fn(async () => structuredClone(stored)), set,
        setAccessLevel: vi.fn(async () => undefined),
        remove: vi.fn(async (key: string) => { delete stored[key]; }),
      },
      session: {
        get: vi.fn(async () => structuredClone(sessionData)),
        set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(sessionData, values); }),
        setAccessLevel: vi.fn(async () => undefined),
      },
    } });
    try {
      const api = createApi();
      const user = userEvent.setup();
      render(<App api={api} browser={createBrowser()} llmStore={browserLlmConfigStore} />);
      await user.click(await screen.findByRole("button", { name: "检查当前视频字幕" }));
      await user.click(screen.getByRole("button", { name: "分析此视频" }));
      expect(await screen.findByText(/旧配置.*已隔离.*官方 API Key/)).toBeInTheDocument();
      expect(screen.getByLabelText("API Key")).toHaveValue("");
      await user.click(screen.getByRole("button", { name: "保存配置" }));
      await user.click(screen.getByRole("button", { name: "测试连通" }));
      expect(set).not.toHaveBeenCalled();
      expect(api.testLlm).not.toHaveBeenCalled();
      expect(api.createAnalysis).not.toHaveBeenCalled();
      expect(stored).toEqual(raw);
      await user.type(screen.getByLabelText("API Key"), "new-official-key");
      await user.click(screen.getByRole("button", { name: "测试连通" }));
      await waitFor(() => expect(api.testLlm).toHaveBeenCalledWith({ ...defaultLlmConfig("kimi"), apiKey: "new-official-key" }));
      expect(await screen.findByRole("status")).toHaveTextContent("连接成功");
      expect(stored.kimiLlmConfig).toEqual(raw.kimiLlmConfig);
    } finally { vi.unstubAllGlobals(); }
  });

  it("keeps the latest provider when independent loads finish out of order", async () => {
    const deepseek = deferred<LlmConfig>();
    const qwen = deferred<LlmConfig>();
    const store = createLlmStore();
    store.load.mockImplementation(async (provider = "kimi") => provider === "deepseek" ? deepseek.promise : provider === "qwen" ? qwen.promise : { ...defaultLlmConfig(provider), apiKey: "kimi-key" });
    const user = userEvent.setup();
    render(<App api={createApi()} browser={createBrowser()} llmStore={store} />);
    await user.click(await screen.findByRole("button", { name: "LLM 设置" }));
    await user.selectOptions(screen.getByLabelText("Provider"), "deepseek");
    expect(screen.getByLabelText("Provider")).toHaveValue("deepseek");
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Provider"), "qwen");
    await act(async () => qwen.resolve({ ...defaultLlmConfig("qwen"), apiKey: "qwen-key" }));
    await act(async () => deepseek.resolve({ ...defaultLlmConfig("deepseek"), apiKey: "deepseek-key" }));
    expect(screen.getByLabelText("Provider")).toHaveValue("qwen");
    expect(screen.getByLabelText("API Key")).toHaveValue("qwen-key");
  });

  it("ignores late initial configuration after the user selects another provider", async () => {
    const initial = deferred<LlmConfig>();
    const store = createLlmStore();
    store.load.mockReturnValueOnce(initial.promise);
    const user = userEvent.setup();
    render(<App api={createApi()} browser={createBrowser()} llmStore={store} />);
    await user.click(await screen.findByRole("button", { name: "LLM 设置" }));
    await user.selectOptions(screen.getByLabelText("Provider"), "deepseek");
    await act(async () => initial.resolve({ ...defaultLlmConfig("kimi"), apiKey: "late-kimi" }));
    expect(screen.getByLabelText("Provider")).toHaveValue("deepseek");
    expect(screen.getByLabelText("API Key")).toHaveValue("deepseek-key");
  });

  it.each(["provider", "model", "key"])("ignores a successful probe after the %s changes", async (field) => {
    const pending = deferred<{ ok: boolean; message: string }>();
    const api = createApi();
    api.testLlm.mockReturnValueOnce(pending.promise);
    const store = createLlmStore();
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={store} />);
    await user.click(await screen.findByRole("button", { name: "LLM 设置" }));
    await user.click(screen.getByRole("button", { name: "测试连通" }));
    if (field === "provider") await user.selectOptions(screen.getByLabelText("Provider"), "deepseek");
    else await user.type(screen.getByLabelText(field === "model" ? "模型" : "API Key"), "changed");
    await act(async () => pending.resolve({ ok: true, message: "connected" }));
    expect(store.save).not.toHaveBeenCalled();
    expect(screen.queryByText(/连接成功/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "测试连通" })).toBeEnabled();
  });

  it("does not close another provider's settings when an earlier save completes", async () => {
    const pending = deferred<undefined>();
    const store = createLlmStore();
    store.save.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    render(<App api={createApi()} browser={createBrowser()} llmStore={store} />);
    await user.click(await screen.findByRole("button", { name: "LLM 设置" }));
    await user.click(screen.getByRole("button", { name: "保存配置" }));
    await user.selectOptions(screen.getByLabelText("Provider"), "deepseek");
    await act(async () => pending.resolve(undefined));
    expect(screen.getByLabelText("Provider")).toHaveValue("deepseek");
    expect(screen.getByLabelText("API Key")).toHaveValue("deepseek-key");
  });

  it.each(["save", "test"])("handles storage failure after %s without exposing the error or showing success", async (action) => {
    const store = createLlmStore();
    store.save.mockRejectedValueOnce(new Error("private-key-value"));
    const user = userEvent.setup();
    render(<App api={createApi()} browser={createBrowser()} llmStore={store} />);
    await user.click(await screen.findByRole("button", { name: "LLM 设置" }));
    await user.click(screen.getByRole("button", { name: action === "save" ? "保存配置" : "测试连通" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/保存失败.*重试/);
    expect(screen.getByRole("status")).not.toHaveClass("success");
    expect(screen.queryByText(/private-key-value|连接成功/)).not.toBeInTheDocument();
  });

  it("finishes a provider load even when settings are closed and reopened", async () => {
    const pending = deferred<LlmConfig>();
    const store = createLlmStore();
    store.load.mockImplementation(async (provider = "kimi") => provider === "deepseek" ? pending.promise : { ...defaultLlmConfig(provider), apiKey: "kimi-key" });
    const user = userEvent.setup();
    render(<App api={createApi()} browser={createBrowser()} llmStore={store} />);
    await user.click(await screen.findByRole("button", { name: "LLM 设置" }));
    await user.selectOptions(screen.getByLabelText("Provider"), "deepseek");
    await user.click(screen.getByRole("button", { name: "返回" }));
    await act(async () => pending.resolve({ ...defaultLlmConfig("deepseek"), apiKey: "deepseek-key" }));
    await user.click(screen.getByRole("button", { name: "LLM 设置" }));
    expect(screen.getByLabelText("API Key")).toHaveValue("deepseek-key");
    expect(screen.getByRole("button", { name: "测试连通" })).toBeEnabled();
  });

  it("ignores an old probe after leaving settings through history and reopening", async () => {
    const pending = deferred<{ ok: boolean; message: string }>();
    const api = createApi();
    api.testLlm.mockReturnValueOnce(pending.promise);
    const store = createLlmStore();
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={store} />);
    await user.click(await screen.findByRole("button", { name: "LLM 设置" }));
    await user.click(screen.getByRole("button", { name: "测试连通" }));
    await user.click(screen.getByRole("button", { name: "历史记录" }));
    await user.click(screen.getByRole("button", { name: "LLM 设置" }));
    await act(async () => pending.resolve({ ok: true, message: "connected" }));
    expect(store.save).not.toHaveBeenCalled();
    expect(screen.queryByText(/连接成功/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "测试连通" })).toBeEnabled();
  });

  it("blocks reanalysis when an old relay profile is quarantined", async () => {
    const api = createApi();
    api.getHistory.mockResolvedValueOnce({ items: [historyItem], hasMore: false });
    const store = createLlmStore();
    store.load.mockResolvedValueOnce({ ...defaultLlmConfig("kimi"), apiKey: "", migrationNotice: "旧配置已隔离，请填写官方 API Key" });
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={store} />);
    await user.click(await screen.findByRole("button", { name: "重新分析" }));
    expect(await screen.findByText(/旧配置已隔离/)).toBeInTheDocument();
    expect(api.createAnalysis).not.toHaveBeenCalled();
  });

  it("blocks retry after switching to a quarantined provider profile", async () => {
    const api = createApi();
    api.getStatus.mockResolvedValueOnce({ jobId: "job-1", status: "failed", failureCode: "llm_credentials_expired", failureDetail: null });
    const store = createLlmStore();
    store.load.mockImplementation(async (provider = "kimi") => ({ ...defaultLlmConfig(provider), apiKey: provider === "kimi" ? "valid-key" : "", ...(provider === "deepseek" ? { migrationNotice: "旧配置已隔离，请填写官方 API Key" } : {}) }));
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={store} pollIntervalMs={1} />);
    await user.click(await screen.findByRole("button", { name: "检查当前视频字幕" }));
    await user.click(screen.getByRole("button", { name: "分析此视频" }));
    await screen.findByRole("button", { name: "重试" });
    await user.click(screen.getByRole("button", { name: "LLM 设置" }));
    await user.selectOptions(screen.getByLabelText("Provider"), "deepseek");
    await user.click(screen.getByRole("button", { name: "返回" }));
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText(/旧配置已隔离/)).toBeInTheDocument();
    expect(api.createAnalysis).toHaveBeenCalledTimes(1);
  });

  it("handles failed initial storage reads with empty credentials and actionable copy", async () => {
    const store = createLlmStore();
    store.load.mockRejectedValueOnce(new Error("private-key-value"));
    const user = userEvent.setup();
    render(<App api={createApi()} browser={createBrowser()} llmStore={store} />);
    await user.click(await screen.findByRole("button", { name: "LLM 设置" }));
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    expect(await screen.findByRole("status")).toHaveTextContent(/读取.*失败.*重试/);
    expect(screen.queryByText("private-key-value")).not.toBeInTheDocument();
  });
});

describe("Side Panel", () => {
  it("treats an existing background upload slot as a non-fatal START rejection", async () => {
    const originalChrome = globalThis.chrome;
    Object.assign(globalThis, {
      chrome: { runtime: { sendMessage: vi.fn(async () => ({ ok: false })) } },
    });
    try {
      await expect(browserBridge.startMediaUpload({
        tabId: 7,
        jobId: "job-x",
        contentRef: xContentRef,
        candidate: xCandidate,
      })).resolves.toBe(false);
    } finally {
      Object.assign(globalThis, { chrome: originalChrome });
    }
  });

  it("asks for playback on a bare X status before a player is selected", async () => {
    const browser = createXBrowser();
    const api = createApi();
    browser.getActiveContext.mockResolvedValueOnce({
      tabId: 7,
      url: "https://x.com/owner/status/2075545587093807111",
      title: "X post",
      contentRef: null,
      videoId: null,
      analysis: null,
    });

    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1} />);

    expect(await screen.findByText("请先播放当前视频 1 至 2 秒，再重试")).toBeInTheDocument();
    expect(api.inspect).not.toHaveBeenCalled();
    expect(api.getHistory).not.toHaveBeenCalled();
  });

  it("automatically restores completed X history for the active player", async () => {
    const api = createApi();
    const browser = createXBrowser();
    const xResult = {
      ...(await api.getResult("fixture")),
      jobId: "job-x-history",
      contentId: xContentId,
      contentRef: xContentRef,
      videoId: null,
      videoTitle: "X video",
      sourceLanguage: "en",
    };
    api.inspect.mockResolvedValueOnce(xInspection("media_required"));
    api.getHistory.mockResolvedValueOnce({
      items: [{ ...historyItem, ...xResult, completedAt: "2026-09-05T09:40:00Z" }],
      hasMore: false,
    });
    api.getResult.mockResolvedValueOnce(xResult);

    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1} />);

    expect(await screen.findByText("X video")).toBeInTheDocument();
    expect(api.inspect).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://x.com/owner/status/2075545587093807111/video/1",
      activeMediaIndex: 1,
      clientDurationMs: 30_000,
    }));
    expect(api.getHistory).toHaveBeenCalledWith({ contentId: xContentId, limit: 1, offset: 0 });
    expect(api.createAnalysis).not.toHaveBeenCalled();
    expect(browser.showSubtitles).toHaveBeenCalledWith(7, xContentRef, [
      expect.objectContaining({ translated: "像素" }),
    ]);
  });

  it("asks the user to play an X video when inspection requires playback", async () => {
    const api = createApi();
    mockAutomaticThenManualInspection(api, xInspection("play_required"));
    const user = userEvent.setup();
    render(<App api={api} browser={createXBrowser()} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "检查当前视频" }));

    expect(await screen.findByText("请先播放当前视频 1 至 2 秒，再重试")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "分析此视频" })).not.toBeInTheDocument();
  });

  it("shows a ready X inspection with automatic speech recognition", async () => {
    const api = createApi();
    mockAutomaticThenManualInspection(api);
    const browser = createXBrowser();
    const user = userEvent.setup();
    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "检查当前视频" }));

    expect(api.inspect).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://x.com/owner/status/2075545587093807111/video/1",
      activeMediaIndex: 1,
      clientDurationMs: 30_000,
      mediaCandidates: [xCandidate],
    }));
    expect(await screen.findByText("语音将自动识别")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "分析此视频" })).toBeInTheDocument();
  });

  it("uploads the selected X media after polling reaches waiting_for_media", async () => {
    const api = createApi();
    mockAutomaticThenManualInspection(api);
    api.createAnalysis.mockResolvedValueOnce({
      jobId: "job-x", cacheHit: false, status: "queued",
      contentId: xContentId, contentRef: xContentRef, videoId: null,
    });
    api.getStatus
      .mockResolvedValueOnce({ jobId: "job-x", status: "waiting_for_media", failureCode: null, failureDetail: null })
      .mockResolvedValueOnce({ jobId: "job-x", status: "transcribing", failureCode: null, failureDetail: null });
    const browser = createXBrowser();
    const user = userEvent.setup();
    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1000} />);

    await user.click(await screen.findByRole("button", { name: "检查当前视频" }));
    await user.click(screen.getByRole("checkbox", { name: /允许下载并缓存 Whisper small/ }));
    await user.click(screen.getByRole("button", { name: "分析此视频" }));

    expect(await screen.findByText("正在获取 X 视频")).toBeInTheDocument();
    expect(browser.registerAnalysis).toHaveBeenCalledWith(7, xContentRef, "job-x");
    expect(browser.startMediaUpload).toHaveBeenCalledWith({
      tabId: 7, jobId: "job-x", contentRef: xContentRef, candidates: [xCandidate],
    });
  });

  it("passes every ordered X media candidate to the upload fallback", async () => {
    const api = createApi();
    mockAutomaticThenManualInspection(api);
    api.createAnalysis.mockResolvedValueOnce({
      jobId: "job-x", cacheHit: false, status: "queued",
      contentId: xContentId, contentRef: xContentRef, videoId: null,
    });
    api.getStatus.mockResolvedValue({
      jobId: "job-x", status: "waiting_for_media", failureCode: null, failureDetail: null,
    });
    const browser = createXBrowser();
    const hlsCandidate = {
      url: "https://video.twimg.com/amplify_video/123/pl/master_playlist.m3u8",
      kind: "hls" as const,
      capturedAt: xCandidate.capturedAt - 1,
    };
    browser.getMediaCandidates.mockResolvedValue([xCandidate, hlsCandidate] satisfies MediaCandidate[]);
    const user = userEvent.setup();
    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1000} />);

    await user.click(await screen.findByRole("button", { name: "检查当前视频" }));
    await user.click(screen.getByRole("checkbox", { name: /允许下载并缓存 Whisper small/ }));
    await user.click(screen.getByRole("button", { name: "分析此视频" }));

    await waitFor(() => expect(browser.startMediaUpload).toHaveBeenCalledWith({
      tabId: 7,
      jobId: "job-x",
      contentRef: xContentRef,
      candidates: [xCandidate, hlsCandidate],
    }));
  });

  it("renders X upload progress and transcription status", async () => {
    const api = createApi();
    mockAutomaticThenManualInspection(api);
    api.createAnalysis.mockResolvedValueOnce({
      jobId: "job-x", cacheHit: false, status: "queued",
      contentId: xContentId, contentRef: xContentRef, videoId: null,
    });
    api.getStatus.mockResolvedValue({ jobId: "job-x", status: "waiting_for_media", failureCode: null, failureDetail: null });
    const browser = createXBrowser();
    let onUpload: ((message: MediaUploadNotification) => void) | undefined;
    browser.onMediaUpload.mockImplementation((listener) => { onUpload = listener; return () => undefined; });
    const user = userEvent.setup();
    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1000} />);

    await user.click(await screen.findByRole("button", { name: "检查当前视频" }));
    await user.click(screen.getByRole("checkbox", { name: /允许下载并缓存 Whisper small/ }));
    await user.click(screen.getByRole("button", { name: "分析此视频" }));
    await waitFor(() => expect(browser.startMediaUpload).toHaveBeenCalled());
    onUpload?.({ type: "MEDIA_UPLOAD_PROGRESS", jobId: "job-x", uploadedBytes: 42, totalBytes: 100 });
    expect(await screen.findByText("正在上传视频 42%")).toBeInTheDocument();

    api.getStatus.mockResolvedValue({ jobId: "job-x", status: "transcribing", failureCode: null, failureDetail: null });
    await waitFor(() => expect(screen.getByText("正在识别语音")).toBeInTheDocument(), { timeout: 1500 });
  });

  it("retries START_MEDIA_UPLOAD when the background initially rejects it", async () => {
    const api = createApi();
    mockAutomaticThenManualInspection(api);
    api.createAnalysis.mockResolvedValueOnce({
      jobId: "job-x", cacheHit: false, status: "queued",
      contentId: xContentId, contentRef: xContentRef, videoId: null,
    });
    api.getStatus.mockResolvedValue({
      jobId: "job-x", status: "waiting_for_media", failureCode: null, failureDetail: null,
    });
    const browser = createXBrowser();
    browser.startMediaUpload.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const user = userEvent.setup();
    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "检查当前视频" }));
    await user.click(screen.getByRole("checkbox", { name: /允许下载并缓存 Whisper small/ }));
    await user.click(screen.getByRole("button", { name: "分析此视频" }));

    await waitFor(() => expect(browser.startMediaUpload).toHaveBeenCalledTimes(2));
  });

  it("retries media candidate lookup after no candidate is temporarily available", async () => {
    const api = createApi();
    mockAutomaticThenManualInspection(api);
    api.createAnalysis.mockResolvedValueOnce({
      jobId: "job-x", cacheHit: false, status: "queued",
      contentId: xContentId, contentRef: xContentRef, videoId: null,
    });
    api.getStatus.mockResolvedValue({
      jobId: "job-x", status: "waiting_for_media", failureCode: null, failureDetail: null,
    });
    const browser = createXBrowser();
    browser.getMediaCandidates
      .mockResolvedValueOnce([xCandidate])
      .mockResolvedValueOnce([xCandidate])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([xCandidate]);
    browser.getActiveContext.mockResolvedValueOnce({
      tabId: 7,
      url: "https://x.com/owner/status/2075545587093807111/video/1",
      title: "X video",
      contentRef: xContentRef,
      durationMs: 30_000,
      videoId: null,
      analysis: null,
    }).mockResolvedValueOnce({
      tabId: 7,
      url: "https://x.com/owner/status/2075545587093807111/video/1",
      title: "X video",
      contentRef: xContentRef,
      durationMs: 30_000,
      videoId: null,
      analysis: { tabId: 7, contentRef: xContentRef, jobId: "job-x" },
    });
    const user = userEvent.setup();
    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "检查当前视频" }));
    await user.click(screen.getByRole("checkbox", { name: /允许下载并缓存 Whisper small/ }));
    await user.click(screen.getByRole("button", { name: "分析此视频" }));
    expect(await screen.findByText("未检测到当前视频媒体，请确认视频可以正常播放")).toBeInTheDocument();
    expect(browser.startMediaUpload).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "重新检查" }));

    await waitFor(() => expect(browser.startMediaUpload).toHaveBeenCalledOnce());
    expect(browser.getMediaCandidates).toHaveBeenCalledTimes(4);
  });

  it("retries the same upload after MEDIA_UPLOAD_FAILED", async () => {
    const api = createApi();
    mockAutomaticThenManualInspection(api);
    api.createAnalysis.mockResolvedValueOnce({
      jobId: "job-x", cacheHit: false, status: "queued",
      contentId: xContentId, contentRef: xContentRef, videoId: null,
    });
    api.getStatus.mockResolvedValue({
      jobId: "job-x", status: "waiting_for_media", failureCode: null, failureDetail: null,
    });
    const browser = createXBrowser();
    let onUpload: ((message: MediaUploadNotification) => void) | undefined;
    browser.onMediaUpload.mockImplementation((listener) => { onUpload = listener; return () => undefined; });
    const user = userEvent.setup();
    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "检查当前视频" }));
    await user.click(screen.getByRole("checkbox", { name: /允许下载并缓存 Whisper small/ }));
    await user.click(screen.getByRole("button", { name: "分析此视频" }));
    await waitFor(() => expect(browser.startMediaUpload).toHaveBeenCalledOnce());
    onUpload?.({ type: "MEDIA_UPLOAD_FAILED", jobId: "job-x", code: "media_upload_interrupted" });
    expect(await screen.findByText("视频上传中断，请重新开始")).toBeInTheDocument();

    browser.getActiveContext.mockResolvedValueOnce({
      ...(await browser.getActiveContext()),
      analysis: { tabId: 7, contentRef: xContentRef, jobId: "job-x" },
    });
    await user.click(screen.getByRole("button", { name: "重新检查" }));

    await waitFor(() => expect(browser.startMediaUpload).toHaveBeenCalledTimes(2));
  });

  it("ignores a delayed status response after opening history", async () => {
    const pendingStatus = deferred<Awaited<ReturnType<AnalysisApi["getStatus"]>>>();
    const api = createApi();
    mockAutomaticThenManualInspection(api);
    api.createAnalysis.mockResolvedValueOnce({
      jobId: "job-x", cacheHit: false, status: "queued",
      contentId: xContentId, contentRef: xContentRef, videoId: null,
    });
    api.getStatus.mockReturnValueOnce(pendingStatus.promise);
    const browser = createXBrowser();
    const user = userEvent.setup();
    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "检查当前视频" }));
    await user.click(screen.getByRole("checkbox", { name: /允许下载并缓存 Whisper small/ }));
    await user.click(screen.getByRole("button", { name: "分析此视频" }));
    await waitFor(() => expect(api.getStatus).toHaveBeenCalledWith("job-x"));
    await user.click(screen.getByRole("button", { name: "历史记录" }));
    expect(await screen.findByRole("heading", { name: "历史记录" })).toBeInTheDocument();

    pendingStatus.resolve({
      jobId: "job-x", status: "waiting_for_media", failureCode: null, failureDetail: null,
    });
    await Promise.resolve();

    expect(screen.getByRole("heading", { name: "历史记录" })).toBeInTheDocument();
    expect(browser.startMediaUpload).not.toHaveBeenCalled();
  });

  it("ignores a delayed candidate response after opening history", async () => {
    const pendingCandidates = deferred<Array<typeof xCandidate>>();
    const api = createApi();
    mockAutomaticThenManualInspection(api);
    api.createAnalysis.mockResolvedValueOnce({
      jobId: "job-x", cacheHit: false, status: "queued",
      contentId: xContentId, contentRef: xContentRef, videoId: null,
    });
    api.getStatus.mockResolvedValueOnce({
      jobId: "job-x", status: "waiting_for_media", failureCode: null, failureDetail: null,
    });
    const browser = createXBrowser();
    browser.getMediaCandidates
      .mockResolvedValueOnce([xCandidate])
      .mockResolvedValueOnce([xCandidate])
      .mockReturnValueOnce(pendingCandidates.promise);
    const user = userEvent.setup();
    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "检查当前视频" }));
    await user.click(screen.getByRole("checkbox", { name: /允许下载并缓存 Whisper small/ }));
    await user.click(screen.getByRole("button", { name: "分析此视频" }));
    await waitFor(() => expect(browser.getMediaCandidates).toHaveBeenCalledTimes(3));
    await user.click(screen.getByRole("button", { name: "历史记录" }));

    pendingCandidates.resolve([xCandidate]);
    await Promise.resolve();

    expect(await screen.findByRole("heading", { name: "历史记录" })).toBeInTheDocument();
    expect(browser.startMediaUpload).not.toHaveBeenCalled();
  });

  it("reuses a completed X history result and sends translated subtitles", async () => {
    const api = createApi();
    const xResult = {
      ...(await api.getResult("fixture")),
      jobId: "job-x-history",
      contentId: xContentId,
      contentRef: xContentRef,
      videoId: null,
      videoTitle: "X video",
      sourceLanguage: "auto",
    };
    api.inspect.mockResolvedValueOnce(xInspection("media_required"));
    api.getHistory.mockResolvedValueOnce({
      items: [{ ...historyItem, ...xResult, completedAt: "2026-09-05T09:40:00Z" }],
      hasMore: false,
    });
    api.getResult.mockResolvedValueOnce(xResult);
    const browser = createXBrowser();
    const user = userEvent.setup();
    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1} />);

    expect(await screen.findByText("视频解释神经网络如何识别手写数字。")).toBeInTheDocument();
    expect(api.createAnalysis).not.toHaveBeenCalled();
    expect(browser.showSubtitles).toHaveBeenCalledWith(7, xContentRef, [
      expect.objectContaining({ translated: "像素" }),
    ]);
  });

  it("reanalyzes an X result with its ContentRef", async () => {
    const api = createApi();
    const xResult = {
      ...(await api.getResult("fixture")),
      jobId: "job-x-history",
      contentId: xContentId,
      contentRef: xContentRef,
      videoId: null,
      videoTitle: "X video",
      sourceLanguage: "auto",
    };
    const browser = createXBrowser();
    browser.getActiveContext.mockResolvedValueOnce({
      ...(await browser.getActiveContext()),
      analysis: { tabId: 7, contentRef: xContentRef, jobId: "job-x-history" },
    });
    api.getStatus.mockResolvedValueOnce({ jobId: "job-x-history", status: "completed", failureCode: null, failureDetail: null });
    api.getResult.mockResolvedValueOnce(xResult);
    const user = userEvent.setup();
    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "重新分析" }));

    expect(api.createAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      contentRef: xContentRef,
      sourceLanguage: "auto",
      force: true,
    }));
    expect(browser.registerAnalysis).toHaveBeenCalledWith(7, xContentRef, "job-1");
  });

  it("blocks historical X video B before creating a job for current video A", async () => {
    const historicalRef = { ...xContentRef, sourceContentId: "2075545587093807222" };
    const api = createApi();
    const historicalResult = {
      ...(await api.getResult("fixture")),
      jobId: "job-b-history",
      contentId: "66666666-6666-4666-8666-666666666666",
      contentRef: historicalRef,
      videoId: null,
      videoTitle: "Historical X video B",
      sourceLanguage: "auto",
    };
    mockAutomaticThenManualInspection(api);
    api.getHistory
      .mockResolvedValueOnce({ items: [], hasMore: false })
      .mockResolvedValueOnce({ items: [], hasMore: false })
      .mockResolvedValueOnce({
        items: [{ ...historyItem, ...historicalResult, completedAt: "2026-09-05T09:40:00Z" }],
        hasMore: false,
      });
    api.getResult.mockResolvedValueOnce(historicalResult);
    const browser = createXBrowser();
    const user = userEvent.setup();
    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "检查当前视频" }));
    expect(await screen.findByText("当前 X 视频")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "历史记录" }));
    await user.click(await screen.findByRole("button", { name: "打开 Historical X video B" }));
    await user.click(await screen.findByRole("button", { name: "重新分析" }));

    expect(api.createAnalysis).not.toHaveBeenCalled();
    expect(browser.getMediaCandidates).toHaveBeenCalledTimes(2);
    expect(browser.registerAnalysis).not.toHaveBeenCalled();
    expect(api.getStatus).not.toHaveBeenCalled();
    expect(await screen.findByText("请先打开并播放要重新分析的 X 视频，然后重试")).toBeInTheDocument();
  });
  it("accepts content references in the analysis API contract", async () => {
    const api = createApi();

    await api.createAnalysis({
      contentRef: youtubeContentRef,
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
      title: "Neural networks",
      llmConfig: await createLlmStore().load(),
    });

    expect(api.createAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      contentRef: youtubeContentRef,
    }));
  });

  it("keeps header actions without repeating the Veeky brand", async () => {
    render(<App api={createApi()} browser={createBrowser()} llmStore={createLlmStore()} pollIntervalMs={1} />);

    expect(screen.queryByText("Veeky")).not.toBeInTheDocument();
    expect(screen.queryByText("视频内容解析")).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Veeky Logo" })).not.toBeInTheDocument();
    const settings = screen.getByRole("button", { name: "LLM 设置" });
    const refresh = screen.getByRole("button", { name: "选择视频" });
    const history = screen.getByRole("button", { name: "历史记录" });
    expect(settings.closest(".header-actions-left")).toContainElement(refresh);
    expect(history.closest(".header-actions-right")).toContainElement(history);
  });

  it("opens completed analysis history from the header", async () => {
    const api = {
      ...createApi(),
      getHistory: vi.fn(async () => ({ items: [historyItem], hasMore: false })),
    } as unknown as AnalysisApi;
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "历史记录" }));

    expect(await screen.findByRole("heading", { name: "历史记录" })).toBeInTheDocument();
    expect(screen.getByText("Neural networks")).toBeInTheDocument();
    expect(screen.getByText(/视频时长 12:34/)).toBeInTheDocument();
  });

  it("shows an empty state when there are no completed analyses", async () => {
    const api = createApi();
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "历史记录" }));

    expect(await screen.findByText("还没有分析记录")).toBeInTheDocument();
  });

  it("retries the initial history request after an error", async () => {
    const api = createApi();
    api.getHistory
      .mockResolvedValueOnce({ items: [], hasMore: false })
      .mockRejectedValueOnce(Object.assign(new Error("offline"), { code: "api_unavailable" }))
      .mockResolvedValueOnce({ items: [historyItem], hasMore: false });
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "历史记录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("旧版历史记录");
    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText("Neural networks")).toBeInTheDocument();
  });

  it("loads additional history pages", async () => {
    const olderItem = {
      ...historyItem,
      jobId: "job-older",
      videoId: "3eExfC63uSc",
      videoTitle: "Older analysis",
      completedAt: "2026-08-10T09:40:00Z",
    };
    const api = createApi();
    api.getHistory
      .mockResolvedValueOnce({ items: [], hasMore: false })
      .mockResolvedValueOnce({ items: [historyItem], hasMore: true })
      .mockResolvedValueOnce({ items: [olderItem], hasMore: false });
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "历史记录" }));
    await user.click(await screen.findByRole("button", { name: "加载更多" }));

    expect(await screen.findByText("Older analysis")).toBeInTheDocument();
    expect(screen.getByText("Neural networks")).toBeInTheDocument();
    expect(api.getHistory).toHaveBeenLastCalledWith({ limit: 20, offset: 1 });
    expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();
  });

  it("keeps loaded history rows when loading another page fails", async () => {
    const api = createApi();
    api.getHistory
      .mockResolvedValueOnce({ items: [], hasMore: false })
      .mockResolvedValueOnce({ items: [historyItem], hasMore: true })
      .mockRejectedValueOnce(Object.assign(new Error("offline"), { code: "api_unavailable" }));
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "历史记录" }));
    await user.click(await screen.findByRole("button", { name: "加载更多" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("旧版历史记录");
    expect(screen.getByText("Neural networks")).toBeInTheDocument();
  });

  it("opens a history result without inspecting or creating an analysis", async () => {
    const api = {
      ...createApi(),
      getHistory: vi.fn(async () => ({ items: [historyItem], hasMore: false })),
    } as unknown as AnalysisApi;
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "历史记录" }));
    await user.click(await screen.findByRole("button", { name: /Neural networks/ }));

    expect(await screen.findByText("视频解释神经网络如何识别手写数字。")).toBeInTheDocument();
    expect(api.getResult).toHaveBeenCalledWith("job-history");
    expect(api.inspect).not.toHaveBeenCalled();
    expect(api.createAnalysis).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新分析" }).closest(".result-toolbar")).not.toBeNull();
    expect(screen.getByRole("button", { name: "返回" }).compareDocumentPosition(screen.getByRole("button", { name: "重新分析" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("returns from a saved result to the retained history list", async () => {
    const api = {
      ...createApi(),
      getHistory: vi.fn(async () => ({ items: [historyItem], hasMore: false })),
    } as unknown as AnalysisApi;
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "历史记录" }));
    await user.click(await screen.findByRole("button", { name: /Neural networks/ }));
    await user.click(await screen.findByRole("button", { name: "返回" }));

    expect(await screen.findByRole("heading", { name: "历史记录" })).toBeInTheDocument();
    expect(screen.getByText("Neural networks")).toBeInTheDocument();
  });

  it("reanalyzes a saved result as a new forced analysis", async () => {
    const api = {
      ...createApi(),
      getHistory: vi.fn(async () => ({ items: [historyItem], hasMore: false })),
    } as unknown as AnalysisApi;
    const browser = createBrowser();
    const user = userEvent.setup();
    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "历史记录" }));
    await user.click(await screen.findByRole("button", { name: /Neural networks/ }));
    await user.click(await screen.findByRole("button", { name: "重新分析" }));

    expect(api.createAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      videoId: "aircAruvnKk",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
      title: "But what is a neural network?",
      force: true,
    }));
    expect(browser.registerAnalysis).toHaveBeenCalledWith(7, youtubeContentRef, "job-1");
  });

  it("automatically opens the newest completed result for the current video", async () => {
    const api = {
      ...createApi(),
      getHistory: vi.fn(async () => ({ items: [historyItem], hasMore: false })),
    } as unknown as AnalysisApi;
    render(<App api={api} browser={createBrowser()} llmStore={createLlmStore()} pollIntervalMs={1} />);

    expect(await screen.findByText("视频解释神经网络如何识别手写数字。")).toBeInTheDocument();
    expect(api.getResult).toHaveBeenCalledWith("job-history");
    expect(api.inspect).not.toHaveBeenCalled();
    expect(api.createAnalysis).not.toHaveBeenCalled();
  });

  it.each(["history", "registered"] as const)("returns to video selection from an automatically restored %s result", async (source) => {
    const api = createApi();
    const browser = createBrowser();
    if (source === "history") {
      api.getHistory.mockResolvedValue({ items: [historyItem], hasMore: false });
    } else {
      browser.getActiveContext.mockResolvedValue({
        tabId: 7,
        url: "https://www.youtube.com/watch?v=aircAruvnKk",
        title: "But what is a neural network?",
        videoId: "aircAruvnKk",
        analysis: { tabId: 7, videoId: "aircAruvnKk", jobId: "job-1" },
      });
    }
    const user = userEvent.setup();
    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1} />);
    await screen.findByText("视频解释神经网络如何识别手写数字。");
    const resultReads = api.getResult.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "选择视频" }));

    expect(await screen.findByRole("heading", { name: "选择要分析的视频" })).toBeInTheDocument();
    expect(screen.queryByText("视频解释神经网络如何识别手写数字。")).not.toBeInTheDocument();
    expect(api.getResult).toHaveBeenCalledTimes(resultReads);
    expect(api.inspect).not.toHaveBeenCalled();
    expect(api.createAnalysis).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: "输入其他 YouTube 链接" }));
    expect(screen.getByLabelText("YouTube 链接")).toBeInTheDocument();
  });

  it("loads the history list when returning from an automatically restored result", async () => {
    const api = createApi();
    api.getHistory.mockResolvedValue({ items: [historyItem], hasMore: false });
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={createLlmStore()} pollIntervalMs={1} />);
    await screen.findByText("视频解释神经网络如何识别手写数字。");

    await user.click(screen.getByRole("button", { name: "返回" }));

    expect(await screen.findByRole("heading", { name: "历史记录" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Neural networks/ })).toBeInTheDocument();
    expect(api.getHistory).toHaveBeenLastCalledWith({ limit: 20, offset: 0 });
  });

  it("returns from history to video selection without restoring the current saved result", async () => {
    const api = createApi();
    api.getHistory.mockResolvedValue({ items: [historyItem], hasMore: false });
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={createLlmStore()} pollIntervalMs={1} />);
    await screen.findByText("视频解释神经网络如何识别手写数字。");
    await user.click(screen.getByRole("button", { name: "历史记录" }));
    await screen.findByRole("button", { name: /Neural networks/ });

    await user.click(screen.getByRole("button", { name: "返回当前视频" }));

    expect(await screen.findByRole("heading", { name: "选择要分析的视频" })).toBeInTheDocument();
    expect(api.getResult).toHaveBeenCalledTimes(1);
    expect(api.createAnalysis).not.toHaveBeenCalled();
  });

  it("provides a return to video selection after a new analysis completes", async () => {
    const api = createApi();
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={createLlmStore()} pollIntervalMs={1} />);
    await user.click(await screen.findByRole("button", { name: "检查当前视频字幕" }));
    await user.click(screen.getByRole("button", { name: "分析此视频" }));
    await screen.findByText("视频解释神经网络如何识别手写数字。");

    await user.click(screen.getByRole("button", { name: "返回" }));

    expect(await screen.findByRole("heading", { name: "选择要分析的视频" })).toBeInTheDocument();
    expect(api.createAnalysis).toHaveBeenCalledTimes(1);
  });

  it("guides the user to configure LLM before starting analysis", async () => {
    const api = createApi();
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={createEmptyLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "检查当前视频字幕" }));
    await user.click(screen.getByRole("button", { name: "分析此视频" }));

    expect(await screen.findByRole("heading", { name: "配置 LLM" })).toBeInTheDocument();
    expect(api.createAnalysis).not.toHaveBeenCalled();
  });

  it("tests and saves the configured Kimi connection", async () => {
    const api = createApi();
    const store = createEmptyLlmStore();
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={store} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: /先配置 LLM/ }));
    expect(screen.getByLabelText("API URL")).toHaveValue("https://api.moonshot.cn/v1");
    await user.type(screen.getByLabelText("API Key"), "test-key");
    await user.click(screen.getByRole("button", { name: "测试连通" }));

    expect(api.testLlm).toHaveBeenCalledWith({ provider: "kimi", apiUrl: "https://api.moonshot.cn/v1", apiKey: "test-key", model: "kimi-k2.5" });
    expect(await screen.findByRole("status")).toHaveTextContent("连接成功");
    await user.click(screen.getByRole("button", { name: "保存配置" }));
    expect(store.save).toHaveBeenCalledWith({ provider: "kimi", apiUrl: "https://api.moonshot.cn/v1", apiKey: "test-key", model: "kimi-k2.5", rememberOnDevice: false });
  });

  it("waits for the user to choose the current video before checking captions", async () => {
    const api = createApi();
    const browser = createBrowser();
    const llmStore = createLlmStore();
    const user = userEvent.setup();
    render(<App api={api} browser={browser} llmStore={llmStore} pollIntervalMs={1} />);

    expect(await screen.findByRole("heading", { name: "选择要分析的视频" })).toBeInTheDocument();
    expect(api.inspect).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "检查当前视频字幕" }));
    expect(await screen.findByLabelText("源字幕")).toHaveValue("en");
    await user.click(screen.getByRole("button", { name: "分析此视频" }));

    expect(await screen.findByText("视频解释神经网络如何识别手写数字。")).toBeInTheDocument();
    expect(browser.registerAnalysis).toHaveBeenCalledWith(7, youtubeContentRef, "job-1");
    expect(api.createAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      llmConfig: { provider: "kimi", apiUrl: "https://api.moonshot.cn/v1", apiKey: "test-key", model: "kimi-k2.5" },
    }));
    expect(screen.getByText("输入层")).toBeInTheDocument();
    expect(screen.getByText("从像素开始")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "逐字稿" }));
    expect(screen.getByText("像素")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "0:00" }));
    expect(browser.seek).toHaveBeenCalledWith(7, youtubeContentRef, 0);
  });

  it("shows repeated title, summary, and excerpts only once", async () => {
    const api = createApi();
    api.getResult.mockResolvedValueOnce({
      ...(await api.getResult("fixture")),
      chapters: [
        { start_ms: 0, end_ms: 1000, title: "构建设计系统", summary: "构建设计系统。" },
      ],
      highlights: [
        {
          start_ms: 0,
          end_ms: 1000,
          title: "整理参考界面",
          summary: "整理参考界面。",
          translated_excerpt: "整理参考界面",
          original_excerpt: "整理参考界面",
        },
      ],
    });
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "检查当前视频字幕" }));
    await user.click(screen.getByRole("button", { name: "分析此视频" }));

    expect(await screen.findByText("构建设计系统")).toBeInTheDocument();
    expect(screen.getAllByText(/构建设计系统/)).toHaveLength(1);
    expect(screen.getAllByText(/整理参考界面/)).toHaveLength(1);
  });

  it("switches to the saved DeepSeek profile before testing it", async () => {
    const api = createApi();
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "LLM 设置" }));
    await user.selectOptions(screen.getByLabelText("Provider"), "deepseek");
    await user.click(screen.getByRole("button", { name: "测试连通" }));

    expect(api.testLlm).toHaveBeenCalledWith({
      provider: "deepseek", apiUrl: "https://api.deepseek.com/v1", apiKey: "deepseek-key", model: "deepseek-chat",
    });
  });

  it("shows a specific message when no captions are available", async () => {
    const api = createApi();
    api.inspect.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "no_caption_track" }));
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "检查当前视频字幕" }));
    expect(await screen.findByText("该视频暂无可读取字幕")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "分析此视频" })).not.toBeInTheDocument());
  });

  it("automatically restores a completed registered analysis", async () => {
    const api = createApi();
    const browser = createBrowser();
    browser.getActiveContext.mockResolvedValueOnce({
      tabId: 7,
      url: "https://www.youtube.com/watch?v=aircAruvnKk",
      title: "But what is a neural network?",
      videoId: "aircAruvnKk",
      analysis: { tabId: 7, videoId: "aircAruvnKk", jobId: "job-1" },
    });

    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1} />);

    expect(await screen.findByText("视频解释神经网络如何识别手写数字。")).toBeInTheDocument();
    expect(api.inspect).not.toHaveBeenCalled();
    expect(api.getStatus).toHaveBeenCalledWith("job-1");
  });

  it("keeps the YouTube transcript stage in the processing view", async () => {
    const api = createApi();
    api.getStatus.mockResolvedValue({
      jobId: "job-1", status: "fetching_transcript", failureCode: null, failureDetail: null,
    });
    const browser = createBrowser();
    browser.getActiveContext.mockResolvedValueOnce({
      tabId: 7,
      url: "https://www.youtube.com/watch?v=aircAruvnKk",
      title: "But what is a neural network?",
      contentRef: youtubeContentRef,
      videoId: "aircAruvnKk",
      analysis: { tabId: 7, contentRef: youtubeContentRef, videoId: "aircAruvnKk", jobId: "job-1" },
    });

    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1000} />);

    expect(await screen.findByText("读取字幕")).toBeInTheDocument();
    expect(screen.queryByText("获取视频")).not.toBeInTheDocument();
  });

  it.each(["youtube", "x"] as const)(
    "keeps %s polling active while settings are opened and closed",
    async (platform) => {
      const pendingStatus = deferred<Awaited<ReturnType<AnalysisApi["getStatus"]>>>();
      const api = createApi();
      const completedResult = {
        ...(await api.getResult("fixture")),
        ...(platform === "x" ? {
          contentId: xContentId,
          contentRef: xContentRef,
          videoId: null,
          videoTitle: "X video",
          sourceLanguage: "auto",
        } : {}),
      };
      api.getResult.mockClear();
      api.getResult.mockResolvedValue(completedResult);
      api.getStatus
        .mockResolvedValueOnce({
          jobId: "job-processing", status: "analyzing", failureCode: null, failureDetail: null,
        })
        .mockReturnValueOnce(pendingStatus.promise);
      const browser = platform === "x" ? createXBrowser() : createBrowser();
      browser.getActiveContext.mockResolvedValueOnce(platform === "x" ? {
        tabId: 7,
        url: "https://x.com/owner/status/2075545587093807111/video/1",
        title: "X video",
        contentRef: xContentRef,
        durationMs: 30_000,
        videoId: null,
        analysis: { tabId: 7, contentRef: xContentRef, jobId: "job-processing" },
      } : {
        tabId: 7,
        url: "https://www.youtube.com/watch?v=aircAruvnKk",
        title: "But what is a neural network?",
        contentRef: youtubeContentRef,
        videoId: "aircAruvnKk",
        analysis: {
          tabId: 7,
          contentRef: youtubeContentRef,
          videoId: "aircAruvnKk",
          jobId: "job-processing",
        },
      });
      const user = userEvent.setup();
      render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1} />);

      expect(await screen.findByText(platform === "x" ? "获取视频" : "读取字幕")).toBeInTheDocument();
      await waitFor(() => expect(api.getStatus).toHaveBeenCalledTimes(2));
      await user.click(screen.getByRole("button", { name: "LLM 设置" }));
      expect(await screen.findByRole("heading", { name: "配置 LLM" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "返回" }));

      pendingStatus.resolve({
        jobId: "job-processing", status: "completed", failureCode: null, failureDetail: null,
      });

      expect(await screen.findByText("视频解释神经网络如何识别手写数字。", {}, { timeout: 500 })).toBeInTheDocument();
      expect(api.getResult).toHaveBeenCalledWith("job-processing");
    },
  );

  it("continues creating an analysis after settings are opened and closed", async () => {
    const pendingCreate = deferred<Awaited<ReturnType<AnalysisApi["createAnalysis"]>>>();
    const api = createApi();
    api.createAnalysis.mockReturnValueOnce(pendingCreate.promise);
    const browser = createBrowser();
    const user = userEvent.setup();
    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "检查当前视频字幕" }));
    await user.click(screen.getByRole("button", { name: "分析此视频" }));
    await waitFor(() => expect(api.createAnalysis).toHaveBeenCalledOnce());

    await user.click(screen.getByRole("button", { name: "LLM 设置" }));
    await user.click(await screen.findByRole("button", { name: "返回" }));
    pendingCreate.resolve({
      jobId: "job-1",
      cacheHit: false,
      status: "queued",
      contentId: youtubeContentId,
      contentRef: youtubeContentRef,
      videoId: "aircAruvnKk",
    });

    expect(await screen.findByText("视频解释神经网络如何识别手写数字。")).toBeInTheDocument();
    expect(browser.registerAnalysis).toHaveBeenCalledWith(7, youtubeContentRef, "job-1");
  });

  it("continues registering an analysis after settings are opened and closed", async () => {
    const pendingRegistration = deferred<void>();
    const api = createApi();
    const browser = createBrowser();
    browser.registerAnalysis.mockReturnValueOnce(pendingRegistration.promise);
    const user = userEvent.setup();
    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "检查当前视频字幕" }));
    await user.click(screen.getByRole("button", { name: "分析此视频" }));
    await waitFor(() => expect(browser.registerAnalysis).toHaveBeenCalledWith(7, youtubeContentRef, "job-1"));

    await user.click(screen.getByRole("button", { name: "LLM 设置" }));
    await user.click(await screen.findByRole("button", { name: "返回" }));
    pendingRegistration.resolve();

    expect(await screen.findByText("视频解释神经网络如何识别手写数字。")).toBeInTheDocument();
    expect(api.getStatus).toHaveBeenCalledWith("job-1");
  });

  it("returns to a result that completes while settings are being saved", async () => {
    const pendingCreate = deferred<Awaited<ReturnType<AnalysisApi["createAnalysis"]>>>();
    const pendingSave = deferred<undefined>();
    const api = createApi();
    api.createAnalysis.mockReturnValueOnce(pendingCreate.promise);
    const store = createLlmStore();
    store.save.mockReturnValueOnce(pendingSave.promise);
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={store} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "检查当前视频字幕" }));
    await user.click(screen.getByRole("button", { name: "分析此视频" }));
    await waitFor(() => expect(api.createAnalysis).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "LLM 设置" }));
    await user.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(store.save).toHaveBeenCalledOnce());

    pendingCreate.resolve({
      jobId: "job-1",
      cacheHit: false,
      status: "queued",
      contentId: youtubeContentId,
      contentRef: youtubeContentRef,
      videoId: "aircAruvnKk",
    });
    await waitFor(() => expect(api.getResult).toHaveBeenCalledWith("job-1"));
    pendingSave.resolve(undefined);

    expect(await screen.findByText("视频解释神经网络如何识别手写数字。")).toBeInTheDocument();
  });

  it("opens a completed job only on request after leaving settings for video selection", async () => {
    const pendingStatus = deferred<Awaited<ReturnType<AnalysisApi["getStatus"]>>>();
    const api = createApi();
    api.getStatus
      .mockResolvedValueOnce({
        jobId: "job-processing", status: "analyzing", failureCode: null, failureDetail: null,
      })
      .mockReturnValueOnce(pendingStatus.promise)
      .mockResolvedValueOnce({
        jobId: "job-processing", status: "completed", failureCode: null, failureDetail: null,
      });
    const browser = createProcessingBrowser();
    const user = userEvent.setup();
    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1000} />);

    await waitFor(() => expect(api.getStatus).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "LLM 设置" }));
    await user.click(screen.getByRole("button", { name: "选择视频" }));

    expect(await screen.findByRole("heading", { name: "选择要分析的视频" })).toBeInTheDocument();
    pendingStatus.resolve({
      jobId: "job-processing", status: "completed", failureCode: null, failureDetail: null,
    });
    await act(async () => { await pendingStatus.promise; });
    expect(screen.getByRole("heading", { name: "选择要分析的视频" })).toBeInTheDocument();
    expect(api.getResult).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "查看当前分析" }));

    expect(await screen.findByText("视频解释神经网络如何识别手写数字。")).toBeInTheDocument();
    expect(api.getResult).toHaveBeenCalledWith("job-processing");
  });

  it("opens a history result after leaving settings for history", async () => {
    const pendingStatus = deferred<Awaited<ReturnType<AnalysisApi["getStatus"]>>>();
    const api = createApi();
    api.getStatus
      .mockResolvedValueOnce({
        jobId: "job-processing", status: "analyzing", failureCode: null, failureDetail: null,
      })
      .mockReturnValueOnce(pendingStatus.promise);
    api.getHistory.mockResolvedValueOnce({
      items: [{ ...historyItem, jobId: "job-processing" }],
      hasMore: false,
    });
    const browser = createProcessingBrowser();
    const user = userEvent.setup();
    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1000} />);

    await waitFor(() => expect(api.getStatus).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "LLM 设置" }));
    await user.click(screen.getByRole("button", { name: "历史记录" }));
    await user.click(await screen.findByRole("button", { name: "打开 Neural networks" }));

    expect(await screen.findByText("视频解释神经网络如何识别手写数字。")).toBeInTheDocument();
    expect(api.getResult).toHaveBeenCalledWith("job-processing");
  });

  it("can reopen a completed job after polling leaves settings for translation", async () => {
    const pendingStatus = deferred<Awaited<ReturnType<AnalysisApi["getStatus"]>>>();
    const api = createApi();
    const completeResult = await api.getResult("fixture");
    api.getResult.mockClear();
    api.getResult
      .mockResolvedValueOnce({
        ...completeResult,
        oneLineSummary: "概览已经生成，字幕仍在翻译。",
        partial: true,
      })
      .mockResolvedValueOnce(completeResult);
    api.getStatus
      .mockResolvedValueOnce({
        jobId: "job-processing", status: "analyzing", failureCode: null, failureDetail: null,
      })
      .mockReturnValueOnce(pendingStatus.promise)
      .mockResolvedValueOnce({
        jobId: "job-processing", status: "completed", failureCode: null, failureDetail: null,
      });
    const browser = createProcessingBrowser();
    const user = userEvent.setup();
    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1000} />);

    await waitFor(() => expect(api.getStatus).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "LLM 设置" }));
    pendingStatus.resolve({
      jobId: "job-processing", status: "translating", failureCode: null, failureDetail: null,
    });
    expect(await screen.findByText("概览已经生成，字幕仍在翻译。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "选择视频" }));

    expect(await screen.findByRole("heading", { name: "选择要分析的视频" })).toBeInTheDocument();
    expect(api.getResult).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "查看当前分析" }));

    expect(await screen.findByText("视频解释神经网络如何识别手写数字。")).toBeInTheDocument();
  });

  it("can reopen a completed job after polling leaves settings for an error", async () => {
    const pendingStatus = deferred<Awaited<ReturnType<AnalysisApi["getStatus"]>>>();
    const api = createApi();
    api.getStatus
      .mockResolvedValueOnce({
        jobId: "job-processing", status: "analyzing", failureCode: null, failureDetail: null,
      })
      .mockReturnValueOnce(pendingStatus.promise)
      .mockResolvedValueOnce({
        jobId: "job-processing", status: "completed", failureCode: null, failureDetail: null,
      });
    api.getHistory.mockResolvedValueOnce({ items: [], hasMore: false });
    const browser = createProcessingBrowser();
    const user = userEvent.setup();
    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1000} />);

    await waitFor(() => expect(api.getStatus).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "LLM 设置" }));
    pendingStatus.resolve({
      jobId: "job-processing",
      status: "failed",
      failureCode: "analysis_unavailable",
      failureDetail: "failed",
    });
    await user.click(await screen.findByRole("button", { name: "重新检查" }));

    expect(await screen.findByText("视频解释神经网络如何识别手写数字。")).toBeInTheDocument();
  });

  it("resumes an unfinished registered analysis before checking history", async () => {
    const api = createApi();
    api.getStatus.mockResolvedValue({
      jobId: "job-1", status: "translating", failureCode: null, failureDetail: null,
    });
    api.getResult.mockRejectedValue(Object.assign(new Error("pending"), { code: "analysis_not_complete" }));
    const browser = createBrowser();
    browser.getActiveContext.mockResolvedValueOnce({
      tabId: 7,
      url: "https://www.youtube.com/watch?v=aircAruvnKk",
      title: "But what is a neural network?",
      videoId: "aircAruvnKk",
      analysis: { tabId: 7, videoId: "aircAruvnKk", jobId: "job-1" },
    });
    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1000} />);

    expect(await screen.findByText("正在读这条视频")).toBeInTheDocument();
    expect(api.getStatus).toHaveBeenCalledWith("job-1");
    expect(api.getHistory).not.toHaveBeenCalled();
  });

  it("falls back to completed history when a registered task failed", async () => {
    const api = createApi();
    api.getStatus.mockResolvedValueOnce({
      jobId: "job-failed", status: "failed", failureCode: "analysis_unavailable", failureDetail: "failed",
    });
    api.getHistory.mockResolvedValueOnce({ items: [historyItem], hasMore: false });
    const browser = createBrowser();
    browser.getActiveContext.mockResolvedValueOnce({
      tabId: 7,
      url: "https://www.youtube.com/watch?v=aircAruvnKk",
      title: "But what is a neural network?",
      videoId: "aircAruvnKk",
      analysis: { tabId: 7, videoId: "aircAruvnKk", jobId: "job-failed" },
    });

    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1} />);

    expect(await screen.findByText("视频解释神经网络如何识别手写数字。")).toBeInTheDocument();
    expect(api.getResult).toHaveBeenCalledWith("job-history");
  });

  it("shows the original transcript when translation fails", async () => {
    const api = createApi();
    api.getStatus.mockResolvedValueOnce({
      jobId: "job-1",
      status: "failed",
      failureCode: "translation_failed",
      failureDetail: "offline",
    });
    api.getResult.mockResolvedValueOnce({
      ...(await api.getResult("fixture")),
      oneLineSummary: "翻译暂时失败，摘要尚未生成。",
      summaryPoints: [],
      chapters: [],
      highlights: [],
      transcript: [
        { id: "one", startMs: 0, durationMs: 1000, original: "Pixels", translated: null },
      ],
      partial: true,
      failureCode: "translation_failed",
    });
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "检查当前视频字幕" }));
    await user.click(screen.getByRole("button", { name: "分析此视频" }));

    expect(screen.getByText("Pixels")).toBeInTheDocument();
    expect(screen.getByText("译文暂不可用")).toBeInTheDocument();
    expect(screen.queryByText("分析完成")).not.toBeInTheDocument();
    expect(screen.queryByText(/译为/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新分析" })).toBeInTheDocument();
  });

  it("retries expired task credentials with the locally stored LLM key", async () => {
    const api = createApi();
    api.getStatus
      .mockResolvedValueOnce({
        jobId: "job-1",
        status: "failed",
        failureCode: "llm_credentials_expired",
        failureDetail: null,
      })
      .mockResolvedValueOnce({
        jobId: "job-2",
        status: "completed",
        failureCode: null,
        failureDetail: null,
      });
    api.createAnalysis
      .mockResolvedValueOnce({
        jobId: "job-1", cacheHit: false, status: "queued",
        contentId: youtubeContentId, contentRef: youtubeContentRef, videoId: "aircAruvnKk",
      })
      .mockResolvedValueOnce({
        jobId: "job-2", cacheHit: false, status: "queued",
        contentId: youtubeContentId, contentRef: youtubeContentRef, videoId: "aircAruvnKk",
      });
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "检查当前视频字幕" }));
    await user.click(screen.getByRole("button", { name: "分析此视频" }));
    expect(await screen.findByText("任务凭据已过期，请点击重试。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => expect(api.createAnalysis).toHaveBeenCalledTimes(2));
    expect(api.createAnalysis).toHaveBeenLastCalledWith(expect.objectContaining({
      videoId: "aircAruvnKk",
      force: true,
      llmConfig: {
        provider: "kimi",
        apiUrl: "https://api.moonshot.cn/v1",
        apiKey: "test-key",
        model: "kimi-k2.5",
      },
    }));
    expect(screen.queryByRole("heading", { name: "LLM 设置" })).not.toBeInTheDocument();
  });

  it("shows the overview while subtitle translation continues", async () => {
    const api = createApi();
    api.getStatus.mockResolvedValue({
      jobId: "job-1",
      status: "translating",
      failureCode: null,
      failureDetail: null,
    });
    api.getResult.mockResolvedValue({
      ...(await api.getResult("fixture")),
      oneLineSummary: "视频先介绍输入层，再解释连接权重。",
      summaryPoints: ["输入像素", "连接权重", "激活计算"],
      partial: true,
      failureCode: null,
      transcript: [
        { id: "one", startMs: 0, durationMs: 1000, original: "Pixels", translated: null },
      ],
    });
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={createLlmStore()} pollIntervalMs={1000} />);

    await user.click(await screen.findByRole("button", { name: "检查当前视频字幕" }));
    await user.click(screen.getByRole("button", { name: "分析此视频" }));

    expect(await screen.findByText("视频先介绍输入层，再解释连接权重。")).toBeInTheDocument();
    expect(screen.queryByText("分析完成")).not.toBeInTheDocument();
    expect(screen.queryByText(/译为/)).not.toBeInTheDocument();
  });

  it("让用户重试仅保留原始字幕的分析", async () => {
    const api = createApi();
    api.getStatus.mockResolvedValueOnce({
      jobId: "job-1",
      status: "failed",
      failureCode: "translation_failed",
      failureDetail: "timeout",
    });
    api.getResult.mockResolvedValueOnce({
      ...(await api.getResult("fixture")),
      oneLineSummary: "翻译暂时失败，摘要尚未生成。",
      summaryPoints: [],
      chapters: [],
      highlights: [],
      partial: true,
      failureCode: "translation_failed",
    });
    const user = userEvent.setup();
    render(<App api={api} browser={createBrowser()} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "检查当前视频字幕" }));
    await user.click(screen.getByRole("button", { name: "分析此视频" }));
    await user.click(await screen.findByRole("button", { name: "重新分析" }));

    expect(api.createAnalysis).toHaveBeenCalledTimes(2);
    expect(api.createAnalysis).toHaveBeenLastCalledWith(expect.objectContaining({
      videoId: "aircAruvnKk",
      force: true,
    }));
  });

  it("checks a replacement YouTube link and opens it when analysis starts", async () => {
    const api = createApi();
    api.inspect.mockResolvedValueOnce({
      contentId: "44444444-4444-4444-8444-444444444444",
      contentRef: { platform: "youtube", sourceContentId: "BpOsHF5Oj_I", mediaIndex: 1 },
      videoId: "BpOsHF5Oj_I",
      durationMs: 120_000,
      sourceStatus: "ready",
      transcriptSource: "youtube_caption",
      availableLanguages: [
        { languageCode: "en", languageName: "English", isGenerated: true, isTranslatable: true },
      ],
      tracks: [{ languageCode: "en", languageName: "English", isGenerated: true, isTranslatable: true }],
      selectedLanguage: "en",
    });
    api.getResult.mockResolvedValueOnce({
      ...(await api.getResult("fixture")),
      videoId: "BpOsHF5Oj_I",
      contentRef: { platform: "youtube", sourceContentId: "BpOsHF5Oj_I", mediaIndex: 1 },
      transcript: [
        { id: "replacement", startMs: 4_000, durationMs: 1_000, original: "Replacement", translated: "替换视频" },
      ],
    });
    const browser = createBrowser();
    const user = userEvent.setup();
    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("tab", { name: "输入其他 YouTube 链接" }));
    await user.type(screen.getByLabelText("YouTube 链接"), "https://www.youtube.com/watch?v=BpOsHF5Oj_I");
    await user.click(screen.getByRole("button", { name: "检查此链接字幕" }));

    expect(api.inspect).toHaveBeenCalledWith("https://www.youtube.com/watch?v=BpOsHF5Oj_I");
    expect(await screen.findByText("已检测替换视频")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "分析并打开此视频" }));

    const replacementRef = { platform: "youtube", sourceContentId: "BpOsHF5Oj_I", mediaIndex: 1 } as const;
    expect(browser.seek).toHaveBeenCalledWith(7, replacementRef, 0);
    expect(browser.registerAnalysis).toHaveBeenCalledWith(7, replacementRef, "job-1");
    await user.click(await screen.findByRole("tab", { name: "逐字稿" }));
    await user.click(screen.getByRole("button", { name: "0:04" }));
    expect(browser.seek).toHaveBeenLastCalledWith(7, replacementRef, 4_000);
  });
});
