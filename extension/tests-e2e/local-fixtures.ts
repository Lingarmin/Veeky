import type { Page } from "@playwright/test";

/** Seed only the isolated browser's durable history; no server fixture is involved. */
export async function seedCompletedHistory(page: Page, result: Record<string, unknown>) {
  await page.evaluate(async (record) => {
    const ready = await chrome.runtime.sendMessage({ type: "VEEKY_LOCAL_COMMAND", operation: "getHistory" });
    if (!ready?.ok) throw new Error("Local history unavailable");
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("veeky-local-analysis-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const ref = record.contentRef as { platform: string; sourceContentId: string; mediaIndex: number };
        const tx = db.transaction("analyses", "readwrite");
        tx.objectStore("analyses").add({ ...record, completedAt: "2026-10-27T09:40:00Z", contentKey: `${ref.platform}:${ref.sourceContentId}:${ref.mediaIndex}` });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }, result);
}
