import { describe, expect, it, vi } from "vitest";
import { fetchCaptionTranscript, readYouTubePageMetadata, validateYouTubeMetadata } from "../src/local/youtube-browser";

const videoId = "abcdefghijk";
const metadata = () => ({ videoId, title: "Video", durationMs: 30_000, tracks: [{
  baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`,
  languageCode: "en", languageName: "English", isGenerated: false, isTranslatable: true,
}] });

describe("browser YouTube captions", () => {
  it("validates identity, finite duration and the four hour boundary", () => {
    expect(validateYouTubeMetadata({ ...metadata(), durationMs: 14_400_000 }, videoId).title).toBe("Video");
    expect(() => validateYouTubeMetadata({ ...metadata(), durationMs: 14_400_001 }, videoId)).toThrow("video_too_long");
    expect(() => validateYouTubeMetadata({ ...metadata(), videoId: "other" }, videoId)).toThrow("video_context_changed");
    expect(() => validateYouTubeMetadata({ ...metadata(), durationMs: Infinity }, videoId)).toThrow("video_metadata_unavailable");
  });
  it("rejects foreign or malformed caption destinations before fetching", async () => {
    const fetcher = vi.fn();
    for (const baseUrl of ["https://evil.example/api/timedtext", "https://www.youtube.com/redirect", "https://user@www.youtube.com/api/timedtext"]) {
      await expect(fetchCaptionTranscript({ ...metadata().tracks[0], baseUrl }, videoId, { fetcher })).rejects.toThrow("captions_unavailable");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("fetches and parses captions without backend or LLM credentials", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ events: [
      { tStartMs: 10, dDurationMs: 900, segs: [{ utf8: "Hello" }] },
    ] })));
    const segments = await fetchCaptionTranscript(metadata().tracks[0], videoId, { fetcher });
    expect(segments[0]).toMatchObject({ original: "Hello", startMs: 10, translated: null });
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "error", credentials: "include" });
    expect(fetcher.mock.calls[0][1].headers).toBeUndefined();
  });
  it("rejects empty captions and redirects instead of claiming they are readable", async () => {
    await expect(fetchCaptionTranscript(metadata().tracks[0], videoId, {
      fetcher: vi.fn().mockResolvedValue(new Response("")),
    })).rejects.toThrow("captions_unavailable");
  });
  it("extracts only the expected video's player fields, never arbitrary page objects", () => {
    const player = document.createElement("div") as HTMLDivElement & { getPlayerResponse: () => unknown };
    player.id = "movie_player";
    player.getPlayerResponse = () => ({
      videoDetails: { videoId, title: "Video", lengthSeconds: "30", secret: "never-return" },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
        baseUrl: metadata().tracks[0].baseUrl, languageCode: "en", name: { simpleText: "English" },
      }] } },
    });
    document.body.append(player);
    const result = readYouTubePageMetadata(videoId);
    expect(result).toMatchObject({ videoId, durationMs: 30_000, tracks: [{ languageCode: "en" }] });
    expect(JSON.stringify(result)).not.toContain("never-return");
    expect(readYouTubePageMetadata("different12")).toBeNull();
    player.remove();
  });
});
