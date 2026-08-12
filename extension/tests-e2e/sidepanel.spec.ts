import { chromium, expect, test } from "@playwright/test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("keeps the panel enabled only on the analyzed video tab", async () => {
  const extensionPath = resolve(process.cwd(), "dist");
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
    ?? chromium.executablePath();
  test.skip(
    !existsSync(executablePath),
    "Install Playwright Chromium or set PLAYWRIGHT_CHROMIUM_PATH",
  );
  const profilePath = mkdtempSync(join(tmpdir(), "xian-kan-chrome-"));
  const context = await chromium.launchPersistentContext(profilePath, {
    executablePath,
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;

    const videoPage = await context.newPage();
    await videoPage.route("**/*", (route) => route.fulfill({
      contentType: "text/html",
      body: '<title>Video</title><video class="html5-main-video"></video>',
    }));
    const videoUrl = "https://www.youtube.com/watch?v=aircAruvnKk";
    await videoPage.goto(videoUrl);

    const otherPage = await context.newPage();
    await otherPage.route("**/*", (route) => route.fulfill({
      contentType: "text/html",
      body: "<title>Other</title>",
    }));
    await otherPage.goto("https://example.com/");

    const videoTabId = await worker.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find((item) => item.url === url);
      if (tab?.id === undefined) throw new Error("Video tab not found");
      return tab.id;
    }, videoUrl);
    const otherTabId = await worker.evaluate(async () => {
      const tab = (await chrome.tabs.query({})).find(
        (item) => item.url === "https://example.com/",
      );
      if (tab?.id === undefined) throw new Error("Other tab not found");
      return tab.id;
    });

    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await extensionPage.evaluate(
      ({ tabId }) => chrome.runtime.sendMessage({
        type: "REGISTER_ANALYSIS",
        tabId,
        videoId: "aircAruvnKk",
        jobId: "job-1",
      }),
      { tabId: videoTabId },
    );

    const videoUrlBeforeSeek = videoPage.url();
    await extensionPage.evaluate(
      ({ tabId }) => chrome.runtime.sendMessage({
        type: "SEEK_VIDEO",
        tabId,
        videoId: "aircAruvnKk",
        startMs: 72_500,
      }),
      { tabId: videoTabId },
    );
    await expect.poll(
      () => videoPage.locator("video.html5-main-video").evaluate((video) => (video as HTMLVideoElement).currentTime),
    ).toBeCloseTo(72.5, 1);
    expect(videoPage.url()).toBe(videoUrlBeforeSeek);

    await otherPage.bringToFront();
    await expect.poll(
      () => worker.evaluate(
        (tabId) => chrome.sidePanel.getOptions({ tabId }),
        otherTabId,
      ),
    ).toMatchObject({ enabled: false });

    await videoPage.bringToFront();
    await expect.poll(
      () => worker.evaluate(
        (tabId) => chrome.sidePanel.getOptions({ tabId }),
        videoTabId,
      ),
    ).toMatchObject({ enabled: true, path: "sidepanel.html" });

    await videoPage.goto("https://example.org/");
    await expect.poll(
      () => worker.evaluate(
        (tabId) => chrome.sidePanel.getOptions({ tabId }),
        videoTabId,
      ),
    ).toMatchObject({ enabled: false });
  } finally {
    await context.close();
    rmSync(profilePath, { recursive: true, force: true });
  }
});

test("restores saved analysis and seeks the existing player without reloading", async () => {
  const extensionPath = resolve(process.cwd(), "dist");
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
    ?? chromium.executablePath();
  test.skip(
    !existsSync(executablePath),
    "Install Playwright Chromium or set PLAYWRIGHT_CHROMIUM_PATH",
  );
  const profilePath = mkdtempSync(join(tmpdir(), "xian-kan-history-"));
  const context = await chromium.launchPersistentContext(profilePath, {
    executablePath,
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    await context.route("http://127.0.0.1:8000/v1/analyses/history**", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [{
          jobId: "job-history",
          videoId: "aircAruvnKk",
          videoTitle: "Neural networks",
          durationMs: 754_000,
          sourceLanguage: "en",
          targetLanguage: "zh-Hans",
          completedAt: "2026-08-11T09:40:00Z",
          modelName: "deepseek",
          modelVersion: "deepseek-v4-flash",
        }],
        hasMore: false,
      }),
    }));
    await context.route("http://127.0.0.1:8000/v1/analyses/job-history/result", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        jobId: "job-history",
        videoId: "aircAruvnKk",
        videoTitle: "Neural networks",
        durationMs: 754_000,
        sourceLanguage: "en",
        targetLanguage: "zh-Hans",
        isGenerated: false,
        oneLineSummary: "视频解释神经网络如何识别手写数字。",
        summaryPoints: ["输入层保存像素值"],
        chapters: [],
        highlights: [],
        transcript: [{
          id: "segment-1",
          startMs: 72_500,
          durationMs: 1_000,
          original: "Pixels",
          translated: "像素",
        }],
        partial: false,
        failureCode: null,
        modelName: "deepseek",
        modelVersion: "deepseek-v4-flash",
      }),
    }));

    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;

    const videoPage = await context.newPage();
    await videoPage.route("**/*", (route) => route.fulfill({
      contentType: "text/html",
      body: '<title>Neural networks</title><video class="html5-main-video"></video>',
    }));
    const videoUrl = "https://www.youtube.com/watch?v=aircAruvnKk";
    await videoPage.goto(videoUrl);

    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await videoPage.bringToFront();
    await extensionPage.reload();

    await expect(extensionPage.getByText("视频解释神经网络如何识别手写数字。")).toBeVisible();
    await extensionPage.getByRole("tab", { name: "逐字稿" }).click();
    const videoUrlBeforeSeek = videoPage.url();
    await extensionPage.getByRole("button", { name: "1:12" }).click();

    await expect.poll(
      () => videoPage.locator("video.html5-main-video").evaluate((video) => (video as HTMLVideoElement).currentTime),
    ).toBeCloseTo(72.5, 1);
    expect(videoPage.url()).toBe(videoUrlBeforeSeek);
  } finally {
    await context.close();
    rmSync(profilePath, { recursive: true, force: true });
  }
});
