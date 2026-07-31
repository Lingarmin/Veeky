import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App } from "../src/sidepanel/App";
import type { AnalysisApi } from "../src/sidepanel/api";
import type { BrowserBridge } from "../src/sidepanel/browser";

function createApi() {
  return {
    inspect: vi.fn<AnalysisApi["inspect"]>(async () => ({
      videoId: "aircAruvnKk",
      durationMs: 2000,
      tracks: [
        { languageCode: "en", languageName: "English", isGenerated: false, isTranslatable: true },
      ],
      selectedLanguage: "en",
    })),
    createAnalysis: vi.fn<AnalysisApi["createAnalysis"]>(async () => ({ jobId: "job-1", cacheHit: false, status: "queued" })),
    getStatus: vi.fn<AnalysisApi["getStatus"]>(async () => ({
      jobId: "job-1", status: "completed", failureCode: null, failureDetail: null,
    })),
    getResult: vi.fn<AnalysisApi["getResult"]>(async () => ({
      jobId: "job-1",
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
  };
}

describe("Side Panel", () => {
  it("inspects captions, starts analysis, and renders the result", async () => {
    const api = createApi();
    const browser = createBrowser();
    const user = userEvent.setup();
    render(<App api={api} browser={browser} pollIntervalMs={1} />);

    expect(await screen.findByLabelText("源字幕")).toHaveValue("en");
    await user.click(screen.getByRole("button", { name: "分析此视频" }));

    expect(await screen.findByText("视频解释神经网络如何识别手写数字。")).toBeInTheDocument();
    expect(browser.registerAnalysis).toHaveBeenCalledWith(7, "aircAruvnKk", "job-1");
    await user.click(screen.getByRole("tab", { name: "逐字稿" }));
    expect(screen.getByText("像素")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "0:00" }));
    expect(browser.seek).toHaveBeenCalledWith(7, "aircAruvnKk", 0);
  });

  it("shows a specific message when no captions are available", async () => {
    const api = createApi();
    api.inspect.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "no_caption_track" }));
    render(<App api={api} browser={createBrowser()} pollIntervalMs={1} />);

    expect(await screen.findByText("该视频暂无可读取字幕")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "分析此视频" })).not.toBeInTheDocument());
  });

  it("restores an existing result without inspecting captions again", async () => {
    const api = createApi();
    const browser = createBrowser();
    browser.getActiveContext.mockResolvedValueOnce({
      tabId: 7,
      url: "https://www.youtube.com/watch?v=aircAruvnKk",
      title: "But what is a neural network?",
      videoId: "aircAruvnKk",
      analysis: { tabId: 7, videoId: "aircAruvnKk", jobId: "job-1" },
    });

    render(<App api={api} browser={browser} pollIntervalMs={1} />);

    expect(await screen.findByText("视频解释神经网络如何识别手写数字。")).toBeInTheDocument();
    expect(api.inspect).not.toHaveBeenCalled();
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
    render(<App api={api} browser={createBrowser()} pollIntervalMs={1} />);

    await screen.findByRole("button", { name: "分析此视频" });
    await user.click(screen.getByRole("button", { name: "分析此视频" }));

    expect(await screen.findByText("原始字幕可用，翻译和摘要尚未完成。")).toBeInTheDocument();
    expect(screen.getByText("Pixels")).toBeInTheDocument();
    expect(screen.getByText("译文暂不可用")).toBeInTheDocument();
  });
});
