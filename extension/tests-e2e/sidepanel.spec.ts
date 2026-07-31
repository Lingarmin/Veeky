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
      body: "<title>Video</title>",
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
