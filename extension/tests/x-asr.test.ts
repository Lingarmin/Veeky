import { describe, expect, it } from "vitest";
import { parseWhisperSegments } from "../src/local/x-asr";

describe("Whisper window timestamps", () => {
  it("offsets local window time and clips null/final timestamps to the video boundary", () => {
    expect(parseWhisperSegments({ chunks: [{ text: " Hello ", timestamp: [1, 3] }, { text: "End", timestamp: [4, null] }] }, 2, 60_000, 5_000)).toEqual([
      { id: "x:2:0", startMs: 61_000, durationMs: 2000, original: "Hello", translated: null },
      { id: "x:2:1", startMs: 64_000, durationMs: 1000, original: "End", translated: null },
    ]);
  });
  it("rejects invalid timings rather than persisting corrupt subtitles", () => {
    expect(() => parseWhisperSegments({ chunks: [{ text: "Bad", timestamp: [NaN, 3] }] }, 0, 0, 5000)).toThrow("local_asr_failed");
    expect(() => parseWhisperSegments({ text: "No timing" }, 0, 0, 5000)).toThrow();
  });
});
