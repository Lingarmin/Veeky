import { test, expect } from "@playwright/test";
import { rmSync } from "node:fs";
import { launchIsolatedExtension } from "./isolated-extension";

test("standalone YouTube analysis, official direct LLM, local history and panel reopen", async () => {
  const { context, profilePath, blockedRequests } = await launchIsolatedExtension();
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    await context.route("https://www.youtube.com/watch**", (route) => route.fulfill({ contentType: "text/html", body: `<title>Standalone video</title><div id="movie_player"></div><script>window.ytInitialPlayerResponse=${JSON.stringify({ videoDetails: { videoId: "dQw4w9WgXcQ", title: "Standalone video", lengthSeconds: "120" }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ", languageCode: "en", name: { simpleText: "English" } }] } } })}</script>` }));
    await context.route("https://www.youtube.com/api/timedtext**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "A useful idea." }] }] }) }));
    // Service-worker requests are not routed by Playwright page routing. Stub
    // only the official provider inside the isolated test worker; reject others.
    await worker.evaluate(() => {
      (globalThis as any).llmCalls = [];
      globalThis.fetch = async (url, init) => {
        if (String(url) !== "https://api.deepseek.com/v1/chat/completions") throw new Error("unexpected network request");
        const input = JSON.parse(String(init?.body));
        (globalThis as any).llmCalls.push({ url: String(url), headers: init?.headers });
        await new Promise((resolve) => setTimeout(resolve, 300));
        const data = JSON.parse(input.messages[1].content);
        const content = data.source_language
          ? { translations: data.segments.map((s: any) => ({ segment_id: s.segment_id, text: "一个有用的想法。" })) }
          : { one_line_summary: "介绍一个有用的想法。", summary_points: ["第一点", "第二点", "第三点"], chapters: [{ start_ms: 0, end_ms: 2000, title: "核心观点", summary: "作者用具体例子说明这个想法如何应用。" }], highlights: [{ start_ms: 0, end_ms: 2000, title: "值得了解的方法", summary: "这个片段讲述如何应用这个想法。", original_excerpt: "A useful idea.", translated_excerpt: "一个有用的想法。" }] };
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }] }), { headers: { "Content-Type": "application/json" } });
      };
    });
    const video = await context.newPage();
    await video.goto("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.evaluate(async () => {
      await chrome.storage.session.set({ "llmSessionConfigV2:deepseek": { provider: "deepseek", apiUrl: "https://api.deepseek.com/v1", apiKey: "fixture-key-only", model: "deepseek-chat" } });
      await chrome.storage.local.set({ selectedLlmProvider: "deepseek" });
    });
    const inspected = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "VEEKY_LOCAL_COMMAND", operation: "inspect", input: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } }));
    expect(inspected, JSON.stringify(inspected)).toMatchObject({ ok: true, value: { sourceStatus: "ready" } });
    // Offscreen documents are not Playwright pages. Attach CDP to their actual
    // target so the isolated test cannot send an unmocked caption request.
    const cdp = await context.browser()!.newBrowserCDPSession();
    const targets = await cdp.send("Target.getTargets");
    const offscreen = targets.targetInfos.find((target) => target.url === `chrome-extension://${extensionId}/offscreen.html`)!;
    expect(offscreen).toBeTruthy();
    const attached = await cdp.send("Target.attachToTarget", { targetId: offscreen.targetId, flatten: false });
    const mocked = new Promise<void>((resolve, reject) => {
      cdp.on("Target.receivedMessageFromTarget", (event) => {
        const response = JSON.parse(event.message);
        if (event.sessionId === attached.sessionId && response.id === 1) response.error ? reject(new Error(JSON.stringify(response.error))) : resolve();
      });
    });
    await cdp.send("Target.sendMessageToTarget", { sessionId: attached.sessionId, message: JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: `globalThis.fetch = async (url) => { if (!String(url).startsWith('https://www.youtube.com/api/timedtext?')) throw new Error('unexpected offscreen network request'); return new Response(JSON.stringify({events:[{tStartMs:0,dDurationMs:2000,segs:[{utf8:'A useful idea.'}]}]}), {headers:{'Content-Type':'application/json'}}); }` } }) });
    await mocked;
    await video.bringToFront();
    await panel.reload();
    await panel.getByRole("button", { name: "检查当前视频字幕" }).click();
    await panel.getByRole("button", { name: "分析此视频", exact: true }).click();
    const taskId = () => panel.evaluate(() => new Promise<string | undefined>((resolve, reject) => {
      const request = indexedDB.open("veeky-local-analysis-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction("tasks").objectStore("tasks").getAll();
        read.onsuccess = () => { db.close(); resolve(read.result[0]?.jobId); };
      };
    }));
    await expect.poll(taskId).toBeTruthy();
    const jobId = (await taskId())!;
    await panel.close();
    const reopened = await context.newPage();
    await reopened.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await expect.poll(async () => reopened.evaluate((id) => chrome.runtime.sendMessage({ type: "VEEKY_LOCAL_COMMAND", operation: "getStatus", input: id }), jobId)).toMatchObject({ ok: true, value: { status: "completed" } });
    const result = await reopened.evaluate((id) => chrome.runtime.sendMessage({ type: "VEEKY_LOCAL_COMMAND", operation: "getResult", input: id }), jobId);
    expect(result.value.transcript[0].translated).toBe("一个有用的想法。");
    await video.bringToFront();
    await reopened.reload();
    await expect(reopened.getByText("介绍一个有用的想法。", { exact: true })).toBeVisible();
    await reopened.getByRole("tab", { name: "逐字稿" }).click();
    await expect(reopened.getByText("一个有用的想法。", { exact: true })).toBeVisible();
    const history = await reopened.evaluate(() => chrome.runtime.sendMessage({ type: "VEEKY_LOCAL_COMMAND", operation: "getHistory" }));
    expect(history.value.items).toHaveLength(1);
    const calls = await worker.evaluate(() => (globalThis as any).llmCalls);
    expect(calls).toHaveLength(2);
    expect(blockedRequests).toEqual([]);
    const durable = await reopened.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
    expect(durable).not.toContain("fixture-key-only");
    await reopened.getByRole("button", { name: "历史记录", exact: true }).click();
    await expect(reopened.getByRole("heading", { name: "历史记录", exact: true })).toBeVisible();
    await expect(reopened.getByText("正在加载历史记录...", { exact: true })).toHaveCount(0);
    await expect(reopened.getByText(/已保存 \d+ \/|历史占用|任务与进度占用|存储空间不足/)).toHaveCount(0);
    await reopened.getByRole("button", { name: "打开 Standalone video", exact: true }).hover();
    await reopened.getByRole("button", { name: "删除 Standalone video", exact: true }).click();
    const beforeConfirm = await reopened.evaluate(() => chrome.runtime.sendMessage({ type: "VEEKY_LOCAL_COMMAND", operation: "getHistory" }));
    expect(beforeConfirm.value.items).toHaveLength(1);
    await reopened.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(reopened.getByText("还没有分析记录", { exact: true })).toBeVisible();
    const metadata = await reopened.evaluate(() => chrome.runtime.sendMessage({ type: "VEEKY_LOCAL_COMMAND", operation: "getStorageMetadata" }));
    expect(metadata.value.taskData).toMatchObject({ taskCount: 0, transcriptChunkCount: 0, summaryCheckpointCount: 0 });
  } finally {
    await context.close();
    rmSync(profilePath, { recursive: true, force: true });
  }
});
