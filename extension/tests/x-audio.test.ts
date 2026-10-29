// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createMediaFetcher, createMediaRetryPolicy, mixAudioWindow, validateMediaUrl } from "../src/local/x-audio";
import { localError } from "../src/local/youtube-browser";
import { ALL_FORMATS, Input, UrlSource } from "mediabunny";

describe("local X audio", () => {
  it("allows only HTTPS X media, including every nested playlist request", () => {
    expect(validateMediaUrl("https://video.twimg.com/a/file.m3u8").hostname).toBe("video.twimg.com");
    for (const url of ["http://video.twimg.com/a", "https://video.twimg.com.evil.test/a", "https://u@video.twimg.com/a", "https://video.twimg.com:444/a", "https://evil.test/a"]) {
      expect(() => validateMediaUrl(url)).toThrow("unsupported_media_candidate");
    }
  });
  it("does not send credentials or follow redirects and strips incoming headers", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2])));
    const fetchMedia = createMediaFetcher(new AbortController().signal, fetcher, 10);
    const response = await fetchMedia("https://video.twimg.com/a", { headers: { Authorization: "secret", Range: "bytes=0-1" } });
    expect((await response.arrayBuffer()).byteLength).toBe(2);
    const init = fetcher.mock.calls[0][1];
    expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(init.headers).toEqual({ range: "bytes=0-1" });
    await expect(fetchMedia("https://evil.test/a")).rejects.toThrow("unsupported_media_candidate");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("bounds aggregate streamed bytes and honors cancellation", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockImplementation(async () => new Response(new Uint8Array(4)));
    const fetchMedia = createMediaFetcher(controller.signal, fetcher, 6);
    await (await fetchMedia("https://video.twimg.com/a")).arrayBuffer();
    await expect((await fetchMedia("https://video.twimg.com/b")).arrayBuffer()).rejects.toThrow("media_too_large");
    controller.abort();
    await expect(fetchMedia("https://video.twimg.com/c")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("never retries terminal media failures or cancellation", () => {
    const controller = new AbortController();
    const retry = createMediaRetryPolicy(controller.signal);
    for (const code of ["media_too_large", "media_url_expired", "unsupported_media_candidate"]) {
      expect(retry(1, localError(code))).toBeNull();
    }
    controller.abort();
    expect(retry(1, new TypeError("network disconnected"))).toBeNull();
  });
  it("bounds real Mediabunny stream retries even when its attempt counter resets", async () => {
    const retry = createMediaRetryPolicy(new AbortController().signal);
    const attempts: number[] = [];
    const fetcher = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError("network disconnected")); },
    }), { status: 206, headers: { "Content-Range": "bytes 0-7/8" } }));
    const source = new UrlSource("https://video.twimg.com/file.mp4", {
      fetchFn: fetcher,
      getRetryDelay: (attempt, error) => {
        attempts.push(attempt);
        // Keep this regression bounded even if the production policy regresses.
        if (attempts.length > 5) return null;
        return retry(attempt, error) === null ? null : 0;
      },
    });
    const input = new Input({ source, formats: ALL_FORMATS });
    const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(input.getFormat()).rejects.toThrow("network disconnected");
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(attempts).toEqual([1, 1, 1]);
    } finally { input.dispose(); logging.mockRestore(); }
  });
  it("mixes stereo and resamples only samples in the requested bounded window", () => {
    const buffer = { sampleRate: 32000, length: 32000, numberOfChannels: 2,
      getChannelData: (channel: number) => new Float32Array(32000).fill(channel ? 0.25 : 0.75),
    } as AudioBuffer;
    const output = new Float32Array(16000);
    mixAudioWindow(output, 1, { buffer, timestamp: 0.5, duration: 1 });
    expect(output[0]).toBeCloseTo(0.5);
    expect(output[7999]).toBeCloseTo(0.5);
    expect(output[8000]).toBe(0);
  });
});
