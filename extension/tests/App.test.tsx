import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App } from "../src/sidepanel/App";
import type { AnalysisApi } from "../src/sidepanel/api";
import { browserBridge, type BrowserBridge } from "../src/sidepanel/browser";
import type { MediaUploadNotification } from "../src/shared/types";

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
    load: vi.fn(async (provider = "kimi") => provider === "deepseek"
      ? ({ provider: "deepseek" as const, apiUrl: "https://api.deepseek.com/v1", apiKey: "deepseek-key", model: "deepseek-chat" })
      : ({ provider: "kimi" as const, apiUrl: "https://api.example.com/v1", apiKey: "test-key", model: "kimi-k2.5" })),
    save: vi.fn(async () => undefined),
  };
}

function createEmptyLlmStore() {
  return {
    load: vi.fn(async (provider = "kimi") => provider === "deepseek"
      ? ({ provider: "deepseek" as const, apiUrl: "https://api.deepseek.com/v1", apiKey: "", model: "deepseek-chat" })
      : ({ provider: "kimi" as const, apiUrl: "", apiKey: "", model: "kimi-k2.5" })),
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
    getMediaCandidates: vi.fn(async () => [xCandidate]),
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
    browser.getActiveContext.mockResolvedValueOnce({
      tabId: 7,
      url: "https://x.com/owner/status/2075545587093807111",
      title: "X post",
      contentRef: null,
      videoId: null,
      analysis: null,
    });

    render(<App api={createApi()} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1} />);

    expect(await screen.findByText("请先播放当前视频 1 至 2 秒，再重试")).toBeInTheDocument();
  });

  it("asks the user to play an X video when inspection requires playback", async () => {
    const api = createApi();
    api.inspect.mockResolvedValueOnce(xInspection("play_required"));
    const user = userEvent.setup();
    render(<App api={api} browser={createXBrowser()} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "检查当前视频" }));

    expect(await screen.findByText("请先播放当前视频 1 至 2 秒，再重试")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "分析此视频" })).not.toBeInTheDocument();
  });

  it("shows a ready X inspection with automatic speech recognition", async () => {
    const api = createApi();
    api.inspect.mockResolvedValueOnce(xInspection());
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
    api.inspect.mockResolvedValueOnce(xInspection());
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
    await user.click(screen.getByRole("button", { name: "分析此视频" }));

    expect(await screen.findByText("正在获取 X 视频")).toBeInTheDocument();
    expect(browser.registerAnalysis).toHaveBeenCalledWith(7, xContentRef, "job-x");
    expect(browser.startMediaUpload).toHaveBeenCalledWith({
      tabId: 7, jobId: "job-x", contentRef: xContentRef, candidate: xCandidate,
    });
  });

  it("renders X upload progress and transcription status", async () => {
    const api = createApi();
    api.inspect.mockResolvedValueOnce(xInspection());
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
    await user.click(screen.getByRole("button", { name: "分析此视频" }));
    await waitFor(() => expect(browser.startMediaUpload).toHaveBeenCalled());
    onUpload?.({ type: "MEDIA_UPLOAD_PROGRESS", jobId: "job-x", uploadedBytes: 42, totalBytes: 100 });
    expect(await screen.findByText("正在上传视频 42%")).toBeInTheDocument();

    api.getStatus.mockResolvedValue({ jobId: "job-x", status: "transcribing", failureCode: null, failureDetail: null });
    await waitFor(() => expect(screen.getByText("正在识别语音")).toBeInTheDocument(), { timeout: 1500 });
  });

  it("retries START_MEDIA_UPLOAD when the background initially rejects it", async () => {
    const api = createApi();
    api.inspect.mockResolvedValueOnce(xInspection());
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
    await user.click(screen.getByRole("button", { name: "分析此视频" }));

    await waitFor(() => expect(browser.startMediaUpload).toHaveBeenCalledTimes(2));
  });

  it("retries media candidate lookup after no candidate is temporarily available", async () => {
    const api = createApi();
    api.inspect.mockResolvedValueOnce(xInspection());
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
    await user.click(screen.getByRole("button", { name: "分析此视频" }));
    expect(await screen.findByText("未检测到当前视频媒体，请确认视频可以正常播放")).toBeInTheDocument();
    expect(browser.startMediaUpload).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "重新检查" }));

    await waitFor(() => expect(browser.startMediaUpload).toHaveBeenCalledOnce());
    expect(browser.getMediaCandidates).toHaveBeenCalledTimes(3);
  });

  it("retries the same upload after MEDIA_UPLOAD_FAILED", async () => {
    const api = createApi();
    api.inspect.mockResolvedValueOnce(xInspection());
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
    api.inspect.mockResolvedValueOnce(xInspection());
    api.createAnalysis.mockResolvedValueOnce({
      jobId: "job-x", cacheHit: false, status: "queued",
      contentId: xContentId, contentRef: xContentRef, videoId: null,
    });
    api.getStatus.mockReturnValueOnce(pendingStatus.promise);
    const browser = createXBrowser();
    const user = userEvent.setup();
    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "检查当前视频" }));
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
    api.inspect.mockResolvedValueOnce(xInspection());
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
      .mockReturnValueOnce(pendingCandidates.promise);
    const user = userEvent.setup();
    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "检查当前视频" }));
    await user.click(screen.getByRole("button", { name: "分析此视频" }));
    await waitFor(() => expect(browser.getMediaCandidates).toHaveBeenCalledTimes(2));
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
    api.inspect.mockResolvedValueOnce(xInspection());
    api.getHistory.mockResolvedValueOnce({
      items: [{ ...historyItem, ...xResult, completedAt: "2026-09-05T09:40:00Z" }],
      hasMore: false,
    });
    api.getResult.mockResolvedValueOnce(xResult);
    const browser = createXBrowser();
    const user = userEvent.setup();
    render(<App api={api} browser={browser} llmStore={createLlmStore()} pollIntervalMs={1} />);

    await user.click(await screen.findByRole("button", { name: "检查当前视频" }));

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
    api.inspect.mockResolvedValueOnce(xInspection());
    api.getHistory
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
    expect(browser.getMediaCandidates).toHaveBeenCalledTimes(1);
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
    expect(await screen.findByRole("alert")).toHaveTextContent("本地分析服务未启动");
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

    expect(await screen.findByRole("alert")).toHaveTextContent("本地分析服务未启动");
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
    expect(screen.getByRole("button", { name: "返回历史记录" })).toBeInTheDocument();
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
    await user.click(await screen.findByRole("button", { name: "返回历史记录" }));

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
    await user.type(screen.getByLabelText("API URL"), "https://api.example.com/v1");
    await user.type(screen.getByLabelText("API Key"), "test-key");
    await user.click(screen.getByRole("button", { name: "测试连通" }));

    expect(api.testLlm).toHaveBeenCalledWith({ provider: "kimi", apiUrl: "https://api.example.com/v1", apiKey: "test-key", model: "kimi-k2.5" });
    expect(await screen.findByRole("status")).toHaveTextContent("连接成功");
    await user.click(screen.getByRole("button", { name: "保存配置" }));
    expect(store.save).toHaveBeenCalledWith({ provider: "kimi", apiUrl: "https://api.example.com/v1", apiKey: "test-key", model: "kimi-k2.5" });
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
      llmConfig: { provider: "kimi", apiUrl: "https://api.example.com/v1", apiKey: "test-key", model: "kimi-k2.5" },
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

    expect(await screen.findByText("原始字幕可用，翻译暂时失败。")).toBeInTheDocument();
    expect(screen.getByText("Pixels")).toBeInTheDocument();
    expect(screen.getByText("译文暂不可用")).toBeInTheDocument();
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
        apiUrl: "https://api.example.com/v1",
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
    expect(screen.getByText("概览已生成，逐字稿仍在翻译。")).toBeInTheDocument();
    expect(screen.getByText("概览已生成", { selector: ".result-source span" })).toBeInTheDocument();
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
