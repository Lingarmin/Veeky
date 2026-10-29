import { expect, test } from "@playwright/test";
import { rmSync } from "node:fs";
import { launchIsolatedExtension } from "./isolated-extension";
import { seedCompletedHistory } from "./local-fixtures";

const officialProviders = [
  { provider: "kimi", label: "Kimi", apiUrl: "https://api.moonshot.cn/v1", model: "kimi-k2.5" },
  { provider: "deepseek", label: "DeepSeek", apiUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { provider: "hunyuan", label: "腾讯混元", apiUrl: "https://tokenhub.tencentmaas.com/v1", model: "hy3" },
  { provider: "qwen", label: "通义千问", apiUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { provider: "glm", label: "智谱 GLM", apiUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.7-flash" },
] as const;

test("history import uses a transient toast without shifting the record list", async ({}, testInfo) => {
  const { context, profilePath, blockedRequests } = await launchIsolatedExtension();
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
    await page.evaluate(async () => {
      await chrome.storage.local.set({
        "veeky.legacyHistoryImportCompleted.v1": true,
        "veeky.installationIdentity.v1": { installationId: "test-toast-installation", installationToken: "t".repeat(48) },
      });
    });
    await page.reload();
    await page.evaluate(() => {
      // Isolate optional permission and legacy responses; never contact a real service.
      Object.defineProperty(chrome.permissions, "request", { value: async () => true });
      Object.defineProperty(chrome.permissions, "remove", { value: async () => true });
      globalThis.fetch = async (input) => {
        if (String(input) !== "http://127.0.0.1:8000/v1/analyses/history?limit=50&offset=0") throw new Error("Unexpected import request");
        return new Response(JSON.stringify({ items: [], hasMore: false }), { headers: { "Content-Type": "application/json" } });
      };
    });
    await page.getByRole("button", { name: "历史记录", exact: true }).click();
    const entry = page.getByRole("button", { name: "导入", exact: true });
    await expect(entry).toBeEnabled();
    const emptyState = page.getByText("还没有分析记录", { exact: true });
    await expect(emptyState).toBeVisible();
    const before = (await emptyState.boundingBox())!;
    await page.clock.install();
    await entry.click();
    const toast = page.getByRole("complementary", { name: "历史导入提示" });
    await expect(toast).toContainText("导入完成。已导入 0 条");
    await expect(page.locator(".history-import-note")).toHaveCount(0);
    expect((await emptyState.boundingBox())!.y).toBe(before.y);
    for (const width of [360, 320]) {
      await page.setViewportSize({ width, height: 640 });
      const bounds = (await toast.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(16);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 16);
      await page.screenshot({ path: testInfo.outputPath(`history-import-toast-${width}.png`) });
    }
    await page.clock.fastForward(5000);
    await expect(toast).toHaveCount(0);
    await expect(page.getByText(/导入完成/)).toHaveCount(0);
    await entry.click();
    await expect(toast).toContainText("导入完成");
    await page.getByRole("button", { name: "关闭导入提示" }).click();
    await expect(toast).toHaveCount(0);
    expect(blockedRequests).toEqual([]);
  } finally {
    await context.close();
    rmSync(profilePath, { recursive: true, force: true });
  }
});

test("history keeps import in its heading and remembers prior migration without another request", async ({}, testInfo) => {
  const { context, profilePath, blockedRequests } = await launchIsolatedExtension();
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
    await page.getByRole("button", { name: "历史记录", exact: true }).click();
    const heading = page.locator(".history-heading");
    const entry = heading.getByRole("button", { name: "导入", exact: true });
    const consent = page.getByRole("checkbox", { name: /从旧本地服务导入/ });
    await expect(entry).toBeDisabled();
    await expect(heading.getByText("已完成", { exact: true })).toHaveCount(0);
    await expect(page.getByText("正在加载历史记录...", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/历史占用|任务与进度占用|存储空间不足/)).toHaveCount(0);
    await expect(entry.locator("svg.lucide-import")).toHaveCount(1);
    await expect(consent).toBeVisible();
    await consent.check();
    await expect(entry).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("history-before-import.png") });

    // Upgrade an already-imported record from before the preference existed.
    await seedCompletedHistory(page, {
      jobId: "import:previous-installation:old-job", legacySourceKey: "old-job",
      contentRef: { platform: "youtube", sourceContentId: "aircAruvnKk", mediaIndex: 1 },
      videoId: "aircAruvnKk", videoTitle: "神经网络入门", durationMs: 754_000,
      sourceLanguage: "en", targetLanguage: "zh-Hans", isGenerated: false,
      oneLineSummary: "历史记录测试", summaryPoints: [], chapters: [], highlights: [],
      transcript: [{ id: "segment-1", startMs: 0, durationMs: 1_000, original: "Hello", translated: "你好" }],
      partial: false, failureCode: null, modelName: "deepseek", modelVersion: "test",
    });
    await page.getByRole("button", { name: "返回当前视频" }).click();
    await page.getByRole("button", { name: "历史记录", exact: true }).click();
    await expect(page.getByRole("button", { name: "打开 神经网络入门" })).toBeVisible();
    await expect(consent).toHaveCount(0);
    await expect(entry).toBeEnabled();
    await expect.poll(() => page.evaluate(async () =>
      (await chrome.storage.local.get("veeky.legacyHistoryImportCompleted.v1"))["veeky.legacyHistoryImportCompleted.v1"],
    )).toBe(true);

    await page.reload();
    await page.getByRole("button", { name: "历史记录", exact: true }).click();
    await expect(consent).toHaveCount(0);
    await expect(entry).toBeEnabled();
    await expect(page.getByRole("button", { name: "导入旧历史记录", exact: true })).toHaveCount(0);
    for (const width of [360, 320]) {
      await page.setViewportSize({ width, height: 640 });
      const headingBounds = (await heading.boundingBox())!;
      const entryBounds = (await entry.boundingBox())!;
      const titleBounds = (await heading.getByRole("heading", { name: "历史记录", exact: true }).boundingBox())!;
      expect(entryBounds.x).toBeGreaterThanOrEqual(titleBounds.x + titleBounds.width);
      expect(entryBounds.x + entryBounds.width).toBeLessThanOrEqual(width);
      expect(Math.abs(entryBounds.x + entryBounds.width - headingBounds.x - headingBounds.width)).toBeLessThan(1);
      expect(Math.abs(headingBounds.y + headingBounds.height / 2 - entryBounds.y - entryBounds.height / 2)).toBeLessThan(1);
      await entry.focus();
      await expect(entry).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath(`history-import-completed-${width}.png`) });
    }
    expect(blockedRequests).toEqual([]);
  } finally {
    await context.close();
    rmSync(profilePath, { recursive: true, force: true });
  }
});

test("history reveals an icon-only delete action per hovered or focused record", async ({}, testInfo) => {
  const { context, profilePath, blockedRequests } = await launchIsolatedExtension();
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
    for (const [index, title] of ["Neural networks explained", "Designing a video translation tool"].entries()) {
      await seedCompletedHistory(page, {
        jobId: `hover-history-${index}`,
        contentRef: { platform: "youtube", sourceContentId: "aircAruvnKk", mediaIndex: 1 },
        videoId: "aircAruvnKk", videoTitle: title, durationMs: 754_000,
        sourceLanguage: "en", targetLanguage: "zh-Hans", isGenerated: false,
        oneLineSummary: "历史记录测试", summaryPoints: [], chapters: [], highlights: [],
        transcript: [{ id: "segment-1", startMs: 0, durationMs: 1_000, original: "Hello", translated: "你好" }],
        partial: false, failureCode: null, modelName: "deepseek", modelVersion: "test",
      });
    }
    await page.getByRole("button", { name: "历史记录", exact: true }).click();
    const first = page.getByRole("button", { name: "打开 Neural networks explained", exact: true });
    const second = page.getByRole("button", { name: "打开 Designing a video translation tool", exact: true });
    const deleteFirst = page.getByRole("button", { name: "删除 Neural networks explained", exact: true });
    const deleteSecond = page.getByRole("button", { name: "删除 Designing a video translation tool", exact: true });
    await page.mouse.move(0, 0);
    await expect(deleteFirst).toHaveCSS("opacity", "0");
    await expect(deleteSecond).toHaveCSS("opacity", "0");
    await expect(deleteFirst).toHaveText("");
    await expect(deleteFirst.locator("svg.lucide-trash2")).toHaveCount(1);
    const beforeHover = await second.boundingBox();
    await page.screenshot({ path: testInfo.outputPath("history-default.png") });

    await first.hover();
    await expect(deleteFirst).toHaveCSS("opacity", "1");
    await expect(deleteSecond).toHaveCSS("opacity", "0");
    const rowBounds = (await first.boundingBox())!;
    const deleteBounds = (await deleteFirst.boundingBox())!;
    expect(Math.abs(rowBounds.y + rowBounds.height / 2 - deleteBounds.y - deleteBounds.height / 2)).toBeLessThan(2);
    expect(deleteBounds.width).toBeLessThanOrEqual(36);
    expect(await second.boundingBox()).toEqual(beforeHover);
    await page.screenshot({ path: testInfo.outputPath("history-hover.png") });
    await deleteFirst.hover();
    await expect(deleteFirst).toHaveCSS("opacity", "1");
    await second.hover();
    await expect(deleteFirst).toHaveCSS("opacity", "0");
    await expect(deleteSecond).toHaveCSS("opacity", "1");
    await page.mouse.move(0, 0);
    await expect(deleteSecond).toHaveCSS("opacity", "0");

    // Keyboard users can discover the action without needing a pointer.
    await first.focus();
    await expect(deleteFirst).toHaveCSS("opacity", "1");
    await page.keyboard.press("Tab");
    await expect(deleteFirst).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "历史记录", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "确认删除", exact: true })).toBeVisible();
    await expect(first).toBeVisible();
    await page.mouse.move(0, 0);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.getByRole("button", { name: "确认删除", exact: true })).toHaveCount(0);
    await expect(first).toBeVisible();

    await first.hover();
    await deleteFirst.click();
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(first).toHaveCount(0);
    await expect(second).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "历史记录", exact: true }).click();
    await expect(first).toHaveCount(0);
    await expect(second).toBeVisible();
    await page.setViewportSize({ width: 320, height: 480 });
    await second.hover();
    await expect(deleteSecond).toHaveCSS("opacity", "1");
    const narrowBounds = (await deleteSecond.boundingBox())!;
    expect(narrowBounds.x + narrowBounds.width).toBeLessThanOrEqual(320);
    expect(blockedRequests).toEqual([]);
  } finally {
    await context.close();
    rmSync(profilePath, { recursive: true, force: true });
  }
});

test("settings info icon shows anchored help on hover and click without shifting the form", async ({}, testInfo) => {
  const { context, profilePath, blockedRequests } = await launchIsolatedExtension();
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
    await page.getByRole("button", { name: "LLM 设置", exact: true }).click();
    const toggle = page.getByRole("button", { name: "使用说明", exact: true });
    const help = page.locator("#llm-settings-help");
    await expect(toggle).toHaveText("");
    await expect(toggle.locator("svg.lucide-info")).toHaveCount(1);
    const notes = [
      page.getByText(/默认仅本次使用/),
      page.getByText(/测试会从插件直连/),
      page.getByText(/API Key 仅由扩展内部/),
      page.getByText(/字幕会发送给你选择的官方 LLM/),
    ];
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(help).toBeHidden();
    for (const note of notes) await expect(note).toBeHidden();
    await expect(page.getByRole("checkbox", { name: "记住在此设备" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /启用实验性 X 本机语音识别/ })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("settings-collapsed.png"), fullPage: true });
    const buttonBounds = await page.getByRole("button", { name: "测试连通", exact: true }).boundingBox();
    await toggle.hover();
    await expect(help).toBeVisible();
    expect(await page.getByRole("button", { name: "测试连通", exact: true }).boundingBox()).toEqual(buttonBounds);
    await help.hover();
    await expect(help).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(help).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    for (const note of notes) await expect(note).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("settings-expanded.png"), fullPage: true });
    await page.mouse.move(0, 0);
    await expect(help).toBeVisible();
    await toggle.press("Enter");
    await expect(help).toBeHidden();
    await toggle.press("Space");
    await expect(help).toBeVisible();
    await toggle.press("Escape");
    await expect(help).toBeHidden();
    for (const viewport of [{ width: 320, height: 480 }, { width: 360, height: 640 }]) {
      await page.setViewportSize(viewport);
      await toggle.scrollIntoViewIfNeeded();
      await toggle.click();
      await expect(help).toBeVisible();
      const bounds = (await help.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
      await page.mouse.click(0, 0);
      await expect(help).toBeHidden();
    }
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await page.getByRole("button", { name: "LLM 设置", exact: true }).click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(help).toBeHidden();
    expect(blockedRequests).toEqual([]);
  } finally {
    await context.close();
    rmSync(profilePath, { recursive: true, force: true });
  }
});

test("blocks unmatched HTTP requests before opening the extension", async () => {
  const { context, profilePath, blockedRequests } = await launchIsolatedExtension();
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
    const urls = [
      "http://127.0.0.1:8000/unmocked-test-only",
      "https://unmatched.invalid/test-only",
      "https://api.moonshot.cn/v1/chat/completions",
    ];
    for (const url of urls) {
      const outcome = await page.evaluate(async (target) => {
        try { await fetch(target); return "escaped"; } catch { return "blocked"; }
      }, url);
      expect(outcome).toBe("blocked");
    }
    // Non-allowlisted targets can be rejected by CSP before network routing.
    expect(blockedRequests).not.toContain("https://unmatched.invalid/test-only");
    expect(blockedRequests).toContain("https://api.moonshot.cn/v1/chat/completions");
  } finally {
    await context.close();
    rmSync(profilePath, { recursive: true, force: true });
  }
});

test("keeps all five official providers isolated and persists the selected provider", async () => {
  const { context, profilePath, blockedRequests } = await launchIsolatedExtension();
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
    await page.getByRole("button", { name: "LLM 设置", exact: true }).click();
    await expect(page.getByLabel("Provider").locator("option")).toHaveText(officialProviders.map(({ label }) => label));
    for (const config of officialProviders) {
      await page.getByLabel("Provider").selectOption(config.provider);
      await expect(page.getByLabel("API URL", { exact: true })).toHaveValue(config.apiUrl);
      await expect(page.getByLabel("API URL", { exact: true })).not.toBeEditable();
      await expect(page.getByLabel("模型", { exact: true })).toHaveValue(config.model);
      await expect(page.getByLabel("模型", { exact: true })).toBeEditable();
      await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("");
      await page.getByLabel("API Key", { exact: true }).fill(`FAKE-E2E-NOT-A-REAL-KEY-${config.provider}`);
      await page.getByLabel("模型", { exact: true }).fill(`test-only-${config.provider}-model`);
      await page.getByRole("button", { name: "保存配置", exact: true }).click();
      await page.getByRole("button", { name: "LLM 设置", exact: true }).click();
      await expect(page.getByLabel("Provider")).toHaveValue(config.provider);
    }
    await page.reload();
    await page.getByRole("button", { name: "LLM 设置", exact: true }).click();
    await expect(page.getByLabel("Provider")).toHaveValue("glm");
    for (const config of officialProviders) {
      await page.getByLabel("Provider").selectOption(config.provider);
      await expect(page.getByLabel("API Key", { exact: true })).toHaveValue(`FAKE-E2E-NOT-A-REAL-KEY-${config.provider}`);
      await expect(page.getByLabel("模型", { exact: true })).toHaveValue(`test-only-${config.provider}-model`);
      await expect(page.getByLabel("API URL", { exact: true })).toHaveValue(config.apiUrl);
    }
    const saved = await worker.evaluate(() => chrome.storage.local.get(["llmConfigs", "selectedLlmProvider"]));
    expect(saved.selectedLlmProvider).toBe("glm");
    expect(saved.llmConfigs).toBeUndefined();
    const session = await worker.evaluate(() => chrome.storage.session.get(null));
    expect(session).toMatchObject(Object.fromEntries(officialProviders.map((config) => [`llmSessionConfigV2:${config.provider}`, {
      provider: config.provider,
      apiUrl: config.apiUrl,
      apiKey: `FAKE-E2E-NOT-A-REAL-KEY-${config.provider}`,
      model: `test-only-${config.provider}-model`,
    }])));
    expect(blockedRequests).toEqual([]);
  } finally {
    await context.close();
    rmSync(profilePath, { recursive: true, force: true });
  }
});

test("quarantines a legacy relay key until explicit save and tests only the fresh official config", async () => {
  const { context, profilePath, blockedRequests } = await launchIsolatedExtension();
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const legacy = {
      llmConfigs: {
        kimi: { provider: "kimi", apiUrl: "https://legacy-relay.invalid/v1", apiKey: "FAKE-E2E-LEGACY-RELAY-KEY", model: "legacy-model" },
        hunyuan: { provider: "hunyuan", apiUrl: "https://api.hunyuan.cloud.tencent.com/v1", apiKey: "FAKE-E2E-OLD-HUNYUAN-KEY", model: "old-hunyuan-model" },
      },
      selectedLlmProvider: "kimi",
      testOwnedHistory: ["FAKE-E2E-HISTORY-SENTINEL"],
      testOwnedIdentity: "FAKE-E2E-IDENTITY-SENTINEL",
    };
    await worker.evaluate((value) => chrome.storage.local.set(value), legacy);
    const payloads: unknown[] = [];
    await context.route("https://api.moonshot.cn/v1/chat/completions", (route) => {
      expect(route.request().method()).toBe("POST");
      payloads.push(route.request().postDataJSON());
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] }),
      });
    });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
    await page.getByRole("button", { name: "LLM 设置", exact: true }).click();
    await expect(page.getByLabel("API URL", { exact: true })).toHaveValue(officialProviders[0].apiUrl);
    await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("");
    await expect(page.getByText(/已隔离/)).toBeVisible();
    await expect(page.getByLabel("模型", { exact: true })).toHaveValue("legacy-model");
    await page.getByRole("button", { name: "测试连通", exact: true }).click();
    expect(payloads).toHaveLength(0);
    await page.getByLabel("Provider").selectOption("hunyuan");
    await expect(page.getByLabel("API URL", { exact: true })).toHaveValue(officialProviders[2].apiUrl);
    await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("");
    await expect(page.getByText(/2026-09-30.*TokenHub/)).toBeVisible();
    expect(await worker.evaluate((keys) => chrome.storage.local.get(keys), Object.keys(legacy))).toEqual(legacy);
    await page.getByLabel("Provider").selectOption("kimi");
    await expect(page.getByLabel("API Key", { exact: true })).toBeEnabled();
    await page.getByLabel("API Key", { exact: true }).fill("FAKE-E2E-FRESH-OFFICIAL-KIMI-KEY");
    await page.getByLabel("模型", { exact: true }).fill("test-only-custom-kimi-model");
    expect(await worker.evaluate((keys) => chrome.storage.local.get(keys), Object.keys(legacy))).toEqual(legacy);
    await page.getByRole("button", { name: "保存配置", exact: true }).click();
    await page.getByRole("button", { name: "LLM 设置", exact: true }).click();
    await page.getByRole("button", { name: "测试连通", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("连接成功，配置已保存");
    const expectedConfig = { provider: "kimi", apiUrl: officialProviders[0].apiUrl, apiKey: "FAKE-E2E-FRESH-OFFICIAL-KIMI-KEY", model: "test-only-custom-kimi-model" };
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ model: expectedConfig.model });
    expect(JSON.stringify(payloads)).not.toContain(expectedConfig.apiKey);
    expect(await worker.evaluate((keys) => chrome.storage.local.get(keys), Object.keys(legacy))).toEqual(legacy);
    expect(blockedRequests).toEqual([]);
  } finally {
    await context.close();
    rmSync(profilePath, { recursive: true, force: true });
  }
});

test("preserves malformed legacy storage while saving a new session configuration", async () => {
  const { context, profilePath, blockedRequests } = await launchIsolatedExtension();
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const legacy = {
      llmConfigs: ["FAKE-E2E-MALFORMED-RAW-CONTAINER"],
      kimiLlmConfig: { apiUrl: "https://legacy-relay.invalid/v1", apiKey: "FAKE-E2E-LEGACY-KEY" },
      selectedLlmProvider: "qwen",
      testOwnedHistory: ["FAKE-E2E-HISTORY-UNCHANGED"],
      testOwnedIdentity: "FAKE-E2E-IDENTITY-UNCHANGED",
      testOwnedPreferences: { targetLanguage: "zh-Hans" },
    };
    await worker.evaluate((value) => chrome.storage.local.set(value), legacy);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
    await page.getByRole("button", { name: "LLM 设置", exact: true }).click();
    await expect(page.getByLabel("Provider")).toHaveValue("qwen");
    await expect(page.getByLabel("API URL", { exact: true })).toHaveValue(officialProviders[3].apiUrl);
    await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("");
    await expect(page.getByText(/旧 API Key 已隔离/)).toBeVisible();
    expect(await worker.evaluate((keys) => chrome.storage.local.get(keys), Object.keys(legacy))).toEqual(legacy);
    await page.getByLabel("API Key", { exact: true }).fill("FAKE-E2E-FRESH-QWEN-KEY");
    await page.getByRole("button", { name: "保存配置", exact: true }).click();
    await page.getByRole("button", { name: "LLM 设置", exact: true }).click();
    expect(await worker.evaluate((keys) => chrome.storage.local.get(keys), Object.keys(legacy))).toEqual(legacy);
    expect(await worker.evaluate(() => chrome.storage.session.get("llmSessionConfigV2:qwen"))).toMatchObject({
      "llmSessionConfigV2:qwen": { apiKey: "FAKE-E2E-FRESH-QWEN-KEY" },
    });
    expect(blockedRequests).toEqual([]);
  } finally {
    await context.close();
    rmSync(profilePath, { recursive: true, force: true });
  }
});

test("keeps the panel enabled only on the analyzed video tab", async () => {
  const { context, profilePath } = await launchIsolatedExtension();

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
  const { context, profilePath } = await launchIsolatedExtension();

  try {
    const savedResult = {
        jobId: "job-history",
        contentId: "33333333-3333-4333-8333-333333333333",
        contentRef: {
          platform: "youtube",
          sourceContentId: "aircAruvnKk",
          mediaIndex: 1,
        },
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
      };

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
    await seedCompletedHistory(extensionPage, savedResult);
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

    const back = extensionPage.getByRole("button", { name: "返回", exact: true });
    const retry = extensionPage.getByRole("button", { name: "重新分析" });
    await expect(back).toBeVisible();
    const backBox = await back.boundingBox();
    const retryBox = await retry.boundingBox();
    expect(backBox).not.toBeNull();
    expect(retryBox).not.toBeNull();
    expect(backBox!.x + backBox!.width).toBeLessThan(retryBox!.x);
    expect(Math.abs(backBox!.y + backBox!.height / 2 - retryBox!.y - retryBox!.height / 2)).toBeLessThan(2);

    await back.click();
    await expect(extensionPage.getByRole("heading", { name: "历史记录" })).toBeVisible();
    await expect(extensionPage.getByRole("button", { name: "打开 Neural networks", exact: true })).toBeVisible();
    await extensionPage.getByRole("button", { name: "返回当前视频" }).click();
    await expect(extensionPage.getByRole("heading", { name: "选择要分析的视频" })).toBeVisible();

    await extensionPage.getByRole("button", { name: "历史记录", exact: true }).click();
    await extensionPage.getByRole("button", { name: "打开 Neural networks", exact: true }).click();
    await expect(extensionPage.getByText("视频解释神经网络如何识别手写数字。")).toBeVisible();
    await extensionPage.getByRole("button", { name: "选择视频" }).click();
    await expect(extensionPage.getByRole("heading", { name: "选择要分析的视频" })).toBeVisible();
    await extensionPage.getByRole("tab", { name: "输入其他 YouTube 链接" }).click();
    await expect(extensionPage.getByLabel("YouTube 链接")).toBeVisible();
    await expect(extensionPage.getByText("视频解释神经网络如何识别手写数字。")).toHaveCount(0);
    expect(videoPage.url()).toBe(videoUrlBeforeSeek);
  } finally {
    await context.close();
    rmSync(profilePath, { recursive: true, force: true });
  }
});

test("shows the four-hour limit error before analysis can start", async () => {
  const { context, profilePath } = await launchIsolatedExtension();

  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;

    const videoPage = await context.newPage();
    await videoPage.route("**/*", (route) => route.fulfill({
      contentType: "text/html",
      body: '<title>Long video</title><video></video><script>window.ytInitialPlayerResponse={videoDetails:{videoId:"aircAruvnKk",title:"Long video",lengthSeconds:"14401"}}</script>',
    }));
    await videoPage.goto("https://www.youtube.com/watch?v=aircAruvnKk");

    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await videoPage.bringToFront();
    await extensionPage.reload();
    await extensionPage.getByRole("button", { name: "检查当前视频字幕" }).click();

    await expect(extensionPage.getByText("此视频时长过长，无法分析。")).toBeVisible();
    await expect(extensionPage.getByRole("button", { name: "分析此视频" })).toHaveCount(0);
  } finally {
    await context.close();
    rmSync(profilePath, { recursive: true, force: true });
  }
});

test("renders translated subtitles as an X video advances", async () => {
  const { context, profilePath } = await launchIsolatedExtension();

  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const xPage = await context.newPage();
    await xPage.route("**/*", (route) => route.fulfill({
      contentType: "text/html",
      body: `
        <title>X video</title>
        <article>
          <a href="/viktoroddy/status/2075545587093807111/video/1">
            <div data-testid="videoPlayer"><video></video></div>
          </a>
        </article>
      `,
    }));
    const xUrl = "https://x.com/viktoroddy/status/2075545587093807111/video/1";
    await xPage.goto(xUrl);
    await xPage.locator("video").evaluate((video) => {
      Object.defineProperty(video, "duration", { configurable: true, value: 10 });
      video.dispatchEvent(new Event("play"));
    });

    const xTabId = await worker.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find((item) => item.url === url);
      if (tab?.id === undefined) throw new Error("X video tab not found");
      return tab.id;
    }, xUrl);
    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    const contentRef = {
      platform: "x" as const,
      sourceContentId: "2075545587093807111",
      mediaIndex: 1,
    };

    await extensionPage.evaluate(
      ({ tabId, ref }) => chrome.runtime.sendMessage({
        type: "SET_SUBTITLES",
        tabId,
        contentRef: ref,
        segments: [{
          id: "segment-1",
          startMs: 1000,
          durationMs: 2000,
          original: "Original subtitle",
          translated: "预期的中文字幕",
        }],
      }),
      { tabId: xTabId, ref: contentRef },
    );

    await xPage.locator("video").evaluate((video) => {
      (video as HTMLVideoElement).currentTime = 1.5;
      video.dispatchEvent(new Event("timeupdate"));
    });
    const overlay = xPage.locator(".veeky-subtitle-overlay");
    await expect(overlay).toHaveText("预期的中文字幕");
    const layout = await overlay.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        parentTestId: element.parentElement?.dataset.testid,
        lineClamp: style.webkitLineClamp,
        boxOrient: style.webkitBoxOrient,
        overflow: style.overflow,
      };
    });
    expect(layout).toEqual({
      parentTestId: "videoPlayer",
      lineClamp: "2",
      boxOrient: "vertical",
      overflow: "hidden",
    });
    await expect(xPage.getByText("Original subtitle")).toHaveCount(0);
  } finally {
    await context.close();
    rmSync(profilePath, { recursive: true, force: true });
  }
});

test("restores X history and renders its translated subtitles automatically", async () => {
  const { context, profilePath } = await launchIsolatedExtension();

  const contentRef = {
    platform: "x" as const,
    sourceContentId: "2075545587093807111",
    mediaIndex: 1,
  };
  const contentId = "x:2075545587093807111:1";
  const result = {
    jobId: "job-x-history",
    contentId,
    contentRef,
    videoId: null,
    videoTitle: "X video history",
    durationMs: 10_000,
    sourceLanguage: "en",
    targetLanguage: "zh-Hans",
    isGenerated: true,
    oneLineSummary: "已经恢复的 X 视频摘要。",
    summaryPoints: ["历史记录无需重新分析"],
    chapters: [],
    highlights: [],
    transcript: [{
      id: "segment-1",
      startMs: 1000,
      durationMs: 2000,
      original: "Restored subtitle",
      translated: "自动恢复的字幕",
    }],
    partial: false,
    failureCode: null,
    modelName: "kimi-k2.5",
    modelVersion: "v1",
  };

  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const xPage = await context.newPage();
    await xPage.route("**/*", (route) => route.fulfill({
      contentType: "text/html",
      body: `
        <title>X video history</title>
        <article>
          <a href="/viktoroddy/status/2075545587093807111/video/1">
            <div data-testid="videoPlayer"><video></video></div>
          </a>
        </article>
      `,
    }));
    const xUrl = "https://x.com/viktoroddy/status/2075545587093807111/video/1";
    await xPage.goto(xUrl);
    await xPage.locator("video").evaluate((video) => {
      Object.defineProperty(video, "duration", { configurable: true, value: 10 });
      video.dispatchEvent(new Event("play"));
    });

    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedCompletedHistory(extensionPage, result);
    await xPage.bringToFront();
    await extensionPage.reload();
    await expect(extensionPage.getByText("已经恢复的 X 视频摘要。")).toBeVisible();

    await xPage.locator("video").evaluate((video) => {
      (video as HTMLVideoElement).currentTime = 1.5;
      video.dispatchEvent(new Event("timeupdate"));
    });
    await expect(xPage.locator(".veeky-subtitle-overlay")).toHaveText("自动恢复的字幕");
  } finally {
    await context.close();
    rmSync(profilePath, { recursive: true, force: true });
  }
});
