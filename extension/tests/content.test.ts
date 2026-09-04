import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { installXPlayerTracker } from "../src/content/x-player";
import { contentKey, parseContentRef } from "../src/shared/content";
import type { ContentRef } from "../src/shared/types";

const STATUS_ID = "2075545587093807111";

function setPlayerState(video: HTMLVideoElement, paused: boolean, duration = 12.5): void {
  Object.defineProperties(video, {
    paused: { configurable: true, value: paused },
    duration: { configurable: true, value: duration },
  });
}

function renderStatus(options: { mediaCount?: number; reply?: boolean; modal?: boolean } = {}) {
  const mediaCount = options.mediaCount ?? 1;
  document.body.innerHTML = `
    <main>
      <article data-testid="tweet" id="current-status">
        <a href="/owner/status/${STATUS_ID}">status</a>
        ${Array.from({ length: mediaCount }, (_, index) => `<video id="main-${index + 1}"></video>`).join("")}
      </article>
      ${options.reply ? `
        <article data-testid="tweet" id="reply">
          <a href="/someone/status/2075545587093807222">reply</a>
          <video id="reply-video"></video>
        </article>
      ` : ""}
    </main>
    ${options.modal ? `
      <div role="dialog" id="media-modal">
        <a href="/owner/status/${STATUS_ID}/video/2">media</a>
        <video id="modal-video"></video>
      </div>
    ` : ""}
  `;
}

async function flushMutations(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/");
});

describe("content references", () => {
  it.each([
    ["https://www.youtube.com/watch?v=aircAruvnKk", "aircAruvnKk"],
    ["https://youtu.be/aircAruvnKk?t=20", "aircAruvnKk"],
    ["https://www.youtube.com/shorts/aircAruvnKk", "aircAruvnKk"],
  ])("parses a supported YouTube URL", (url, sourceContentId) => {
    expect(parseContentRef(url)).toEqual({
      platform: "youtube",
      sourceContentId,
      mediaIndex: 1,
    });
  });

  it("parses an explicit X video route", () => {
    expect(
      parseContentRef("https://x.com/viktoroddy/status/2075545587093807111/video/1"),
    ).toEqual({
      platform: "x",
      sourceContentId: "2075545587093807111",
      mediaIndex: 1,
    });
  });

  it.each([
    "https://www.youtube.com:443/watch?v=aircAruvnKk",
    "https://www.youtube.com/watch?v=aircAruvnKk#t=20",
    "https://x.com:443/viktoroddy/status/2075545587093807111/video/1",
    "https://x.com/viktoroddy/status/2075545587093807111/video/1#player",
  ])("accepts harmless page URL syntax: %s", (url) => {
    expect(parseContentRef(url)).not.toBeNull();
  });

  it("does not parse legacy Twitter or a bare X status route", () => {
    expect(parseContentRef("https://twitter.com/u/status/2075545587093807111/video/1")).toBeNull();
    expect(parseContentRef("https://x.com/u/status/2075545587093807111")).toBeNull();
  });

  it.each([
    "http://x.com/u/status/2075545587093807111/video/1",
    "https://x.com.evil.example/u/status/2075545587093807111/video/1",
    "https://user@x.com/u/status/2075545587093807111/video/1",
    "https://x.com:444/u/status/2075545587093807111/video/1",
    "https://x.com/u/status/٢٠٧٥٥٤٥٥٨٧٠٩٣٨٠٧١١١/video/1",
    "https://x.com/u/status/0/video/1",
    "https://x.com/u/status/18446744073709551616/video/1",
    "https://x.com/u/status/2075545587093807111/video/0",
    "https://x.com/u/status/2075545587093807111/video/2147483648",
    "https://x.com/u/status/2075545587093807111/video/1/extra",
    "https://x.com/u/status/2075545587093807111/photo/1",
  ])("rejects an invalid X URL: %s", (url) => {
    expect(parseContentRef(url)).toBeNull();
  });

  it.each([
    "http://www.youtube.com/watch?v=aircAruvnKk",
    "https://www.youtube.com.evil.example/watch?v=aircAruvnKk",
    "https://user@www.youtube.com/watch?v=aircAruvnKk",
    "https://www.youtube.com:444/watch?v=aircAruvnKk",
    "https://youtu.be/aircAruvnKk/extra",
    "https://www.youtube.com/shorts/aircAruvnKk/extra",
  ])("rejects an invalid YouTube URL: %s", (url) => {
    expect(parseContentRef(url)).toBeNull();
  });

  it("builds an unambiguous platform and media key", () => {
    expect(contentKey({
      platform: "x",
      sourceContentId: "2075545587093807111",
      mediaIndex: 2,
    })).toBe("x:2075545587093807111:2");
  });

  it("has a real content-script entry for the next implementation task", () => {
    expect(existsSync(resolve(process.cwd(), "src/content/index.ts"))).toBe(true);
  });
});

describe("X active player tracking", () => {
  it("reports only the playing video belonging to the current status", () => {
    window.history.replaceState({}, "", `/owner/status/${STATUS_ID}/video/2`);
    renderStatus({ mediaCount: 2, reply: true });
    const onActive = vi.fn();
    const onInactive = vi.fn();
    const teardown = installXPlayerTracker({ onActive, onInactive });

    const reply = document.querySelector<HTMLVideoElement>("#reply-video")!;
    setPlayerState(reply, false, 20);
    reply.dispatchEvent(new Event("play"));
    expect(onActive).not.toHaveBeenCalled();

    const main = document.querySelector<HTMLVideoElement>("#main-2")!;
    setPlayerState(main, false, 95.25);
    main.dispatchEvent(new Event("play"));
    expect(onActive).toHaveBeenCalledOnce();
    expect(onActive).toHaveBeenCalledWith({
      platform: "x",
      sourceContentId: STATUS_ID,
      mediaIndex: 2,
    }, 95_250);

    teardown();
  });

  it("rejects a quoted-post video nested inside the current article", () => {
    window.history.replaceState({}, "", `/owner/status/${STATUS_ID}`);
    document.body.innerHTML = `
      <article>
        <a href="/owner/status/${STATUS_ID}">current status</a>
        <video id="current-video"></video>
        <a id="quoted-post" href="/quoted/status/2075545587093807222">
          <video id="quoted-video"></video>
        </a>
      </article>
    `;
    const onActive = vi.fn();
    const teardown = installXPlayerTracker({ onActive, onInactive: vi.fn() });
    const quoted = document.querySelector<HTMLVideoElement>("#quoted-video")!;
    setPlayerState(quoted, false);

    quoted.dispatchEvent(new Event("play"));

    expect(onActive).not.toHaveBeenCalled();
    teardown();
  });

  it("derives a media index for a bare status only after its player becomes active", () => {
    window.history.replaceState({}, "", `/owner/status/${STATUS_ID}`);
    renderStatus({ mediaCount: 2 });
    const onActive = vi.fn();
    const teardown = installXPlayerTracker({ onActive, onInactive: vi.fn() });

    expect(onActive).not.toHaveBeenCalled();
    const second = document.querySelector<HTMLVideoElement>("#main-2")!;
    setPlayerState(second, false, Number.NaN);
    second.dispatchEvent(new Event("play"));

    expect(onActive).toHaveBeenCalledWith({
      platform: "x",
      sourceContentId: STATUS_ID,
      mediaIndex: 2,
    }, 0);
    teardown();
  });

  it("keeps the explicit route index when X renders only the current media player", () => {
    window.history.replaceState({}, "", `/owner/status/${STATUS_ID}/video/2`);
    renderStatus({ mediaCount: 1 });
    const onActive = vi.fn();
    const teardown = installXPlayerTracker({ onActive, onInactive: vi.fn() });
    const video = document.querySelector<HTMLVideoElement>("#main-1")!;
    setPlayerState(video, false);

    video.dispatchEvent(new Event("play"));

    expect(onActive).toHaveBeenCalledWith(expect.objectContaining({ mediaIndex: 2 }), 12_500);
    teardown();
  });

  it("prefers the current status media modal and updates duration on metadata", () => {
    window.history.replaceState({}, "", `/owner/status/${STATUS_ID}/video/2`);
    renderStatus({ modal: true });
    const onActive = vi.fn();
    const teardown = installXPlayerTracker({ onActive, onInactive: vi.fn() });
    const modal = document.querySelector<HTMLVideoElement>("#modal-video")!;
    setPlayerState(modal, false, 0);

    modal.dispatchEvent(new Event("play"));
    expect(onActive).toHaveBeenLastCalledWith(expect.objectContaining({ mediaIndex: 2 }), 0);

    setPlayerState(modal, false, 42);
    modal.dispatchEvent(new Event("loadedmetadata"));
    expect(onActive).toHaveBeenLastCalledWith(expect.objectContaining({ mediaIndex: 2 }), 42_000);
    teardown();
  });

  it("clears the selection on pause and SPA route changes", () => {
    window.history.replaceState({}, "", `/owner/status/${STATUS_ID}/video/1`);
    renderStatus();
    const onInactive = vi.fn();
    const teardown = installXPlayerTracker({ onActive: vi.fn(), onInactive });
    const video = document.querySelector<HTMLVideoElement>("#main-1")!;
    const ref: ContentRef = { platform: "x", sourceContentId: STATUS_ID, mediaIndex: 1 };
    setPlayerState(video, false);
    video.dispatchEvent(new Event("play"));

    setPlayerState(video, true);
    video.dispatchEvent(new Event("pause"));
    expect(onInactive).toHaveBeenLastCalledWith(ref);

    setPlayerState(video, false);
    video.dispatchEvent(new Event("play"));
    window.history.pushState({}, "", "/other/status/2075545587093807333/video/1");
    expect(onInactive).toHaveBeenLastCalledWith(ref);
    teardown();
  });

  it("rebinds a replacement player without duplicate listeners or notifications", async () => {
    window.history.replaceState({}, "", `/owner/status/${STATUS_ID}`);
    renderStatus();
    const onActive = vi.fn();
    const onInactive = vi.fn();
    const teardown = installXPlayerTracker({ onActive, onInactive });
    const article = document.querySelector<HTMLElement>("#current-status")!;
    const oldVideo = document.querySelector<HTMLVideoElement>("#main-1")!;
    setPlayerState(oldVideo, false);
    oldVideo.dispatchEvent(new Event("play"));

    oldVideo.remove();
    const replacement = document.createElement("video");
    replacement.id = "replacement";
    setPlayerState(replacement, false, 30);
    article.append(replacement);
    await flushMutations();

    expect(onInactive).toHaveBeenCalledOnce();
    expect(onActive).toHaveBeenCalledTimes(2);
    expect(onActive).toHaveBeenLastCalledWith(expect.objectContaining({ mediaIndex: 1 }), 30_000);

    article.append(document.createElement("span"));
    await flushMutations();
    replacement.dispatchEvent(new Event("play"));
    expect(onActive).toHaveBeenCalledTimes(2);
    teardown();
  });

  it("teardown removes player, observer, popstate, and history hooks", async () => {
    window.history.replaceState({}, "", `/owner/status/${STATUS_ID}/video/1`);
    renderStatus();
    const originalPushState = window.history.pushState;
    const onActive = vi.fn();
    const onInactive = vi.fn();
    const teardown = installXPlayerTracker({ onActive, onInactive });
    const video = document.querySelector<HTMLVideoElement>("#main-1")!;
    setPlayerState(video, false);
    video.dispatchEvent(new Event("play"));

    teardown();
    expect(window.history.pushState).toBe(originalPushState);
    onActive.mockClear();
    onInactive.mockClear();
    video.dispatchEvent(new Event("pause"));
    window.dispatchEvent(new PopStateEvent("popstate"));
    document.body.append(document.createElement("video"));
    await flushMutations();

    expect(onActive).not.toHaveBeenCalled();
    expect(onInactive).not.toHaveBeenCalled();
  });
});
