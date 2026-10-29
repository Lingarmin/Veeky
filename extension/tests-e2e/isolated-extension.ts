import { chromium } from "@playwright/test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Never reuse a personal Chrome profile or let an unmocked HTTP request escape. */
export async function launchIsolatedExtension() {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? chromium.executablePath();
  if (!existsSync(executablePath)) {
    throw new Error("Install Playwright Chromium or set PLAYWRIGHT_CHROMIUM_PATH");
  }
  const extensionPath = resolve(process.cwd(), "dist");
  const profilePath = mkdtempSync(join(tmpdir(), "veeky-isolated-e2e-"));
  const blockedRequests: string[] = [];
  let context;
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      executablePath,
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--disable-background-networking",
      ],
    });
    // Install first, before opening any page. Later test-specific routes override
    // this guard; the extension service worker currently performs no fetches.
    await context.route(/^https?:\/\//, async (route) => {
      blockedRequests.push(route.request().url());
      await route.abort("blockedbyclient");
    });
    return { context, profilePath, blockedRequests };
  } catch (error) {
    await context?.close();
    rmSync(profilePath, { recursive: true, force: true });
    throw error;
  }
}
