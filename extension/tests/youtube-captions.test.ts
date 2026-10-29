import { describe, expect, it } from "vitest";

import {
  normalizeYouTubeVideoId,
  parseYouTubeCaptions,
  secondsToMilliseconds,
  selectYouTubeCaptionTrack,
  type YouTubeCaptionTrack,
} from "../src/local/youtube-captions";

describe("normalizeYouTubeVideoId", () => {
  it.each([
    ["aircAruvnKk", "aircAruvnKk"],
    ["https://www.youtube.com/watch?v=aircAruvnKk&t=12", "aircAruvnKk"],
    ["https://youtu.be/aircAruvnKk", "aircAruvnKk"],
    ["https://www.youtube.com/shorts/aircAruvnKk", "aircAruvnKk"],
  ])("accepts a valid YouTube ID or URL: %s", (input, expected) => {
    expect(normalizeYouTubeVideoId(input)).toBe(expected);
  });

  it.each([
    "",
    "not-a-video-id",
    "https://youtube.com.evil.example/watch?v=aircAruvnKk",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/embed/aircAruvnKk",
    "http://www.youtube.com/watch?v=aircAruvnKk",
    "https://user@www.youtube.com/watch?v=aircAruvnKk",
  ])("rejects invalid YouTube identifiers and URLs: %s", (input) => {
    expect(normalizeYouTubeVideoId(input)).toBeNull();
  });
});

describe("selectYouTubeCaptionTrack", () => {
  const tracks: YouTubeCaptionTrack[] = [
    {
      languageCode: "en-US",
      languageName: "English (United States)",
      isGenerated: true,
      isTranslatable: true,
      baseUrl: "https://www.youtube.com/api/timedtext?lang=en-US",
    },
    {
      languageCode: "zh-Hans",
      languageName: "Chinese (Simplified)",
      isGenerated: false,
      isTranslatable: true,
      baseUrl: "https://www.youtube.com/api/timedtext?lang=zh-Hans",
    },
    {
      languageCode: "en",
      languageName: "English",
      isGenerated: false,
      isTranslatable: true,
      baseUrl: "https://www.youtube.com/api/timedtext?lang=en",
    },
  ];

  it("prefers the exact requested language, then its base language", () => {
    expect(selectYouTubeCaptionTrack(tracks, "en-US")?.baseUrl).toBe("https://www.youtube.com/api/timedtext?lang=en-US");
    expect(selectYouTubeCaptionTrack(tracks, "zh-TW")?.baseUrl).toBe("https://www.youtube.com/api/timedtext?lang=zh-Hans");
  });

  it("prefers creator-provided captions over generated captions when there is no preference", () => {
    expect(selectYouTubeCaptionTrack(tracks)?.baseUrl).toBe("https://www.youtube.com/api/timedtext?lang=zh-Hans");
  });

  it("returns null when no usable caption track is available", () => {
    expect(selectYouTubeCaptionTrack([])).toBeNull();
    expect(selectYouTubeCaptionTrack([{ ...tracks[0]!, baseUrl: "https://attacker.example/captions" }])).toBeNull();
  });
});

describe("parseYouTubeCaptions", () => {
  it("parses JSON3 segments and converts millisecond timestamps", () => {
    const json3 = JSON.stringify({
      events: [
        { tStartMs: 1200, dDurationMs: 875, segs: [{ utf8: " Hello" }, { utf8: " world " }] },
        { tStartMs: 3100, dDurationMs: 400, segs: [{ utf8: "Second line" }] },
        { tStartMs: 4000, segs: [{ utf8: "\n" }] },
      ],
    });

    expect(parseYouTubeCaptions(json3, "aircAruvnKk")).toEqual([
      {
        id: expect.stringMatching(/^youtube:aircAruvnKk:1200:/),
        startMs: 1200,
        durationMs: 875,
        original: "Hello world",
        translated: null,
      },
      {
        id: expect.stringMatching(/^youtube:aircAruvnKk:3100:/),
        startMs: 3100,
        durationMs: 400,
        original: "Second line",
        translated: null,
      },
    ]);
  });

  it("parses legacy timed-text XML, nested tags, and XML entities", () => {
    const xml = `<?xml version="1.0"?><transcript>
      <text start="1.25" dur="2.5">A &amp; B &#x1F600;</text>
      <text start="4" dur="1"><s>nested</s> text &lt;ok&gt;</text>
    </transcript>`;

    expect(parseYouTubeCaptions(xml, "aircAruvnKk")).toMatchObject([
      { startMs: 1250, durationMs: 2500, original: "A & B 😀", translated: null },
      { startMs: 4000, durationMs: 1000, original: "nested text <ok>", translated: null },
    ]);
  });

  it("parses srv3-style millisecond attributes", () => {
    const xml = `<timedtext><body><p t="1250" d="800"><s>Hello</s><s> there</s></p></body></timedtext>`;
    expect(parseYouTubeCaptions(xml, "aircAruvnKk")).toMatchObject([
      { startMs: 1250, durationMs: 800, original: "Hello there" },
    ]);
  });

  it("produces stable unique IDs for duplicate captions at the same timestamp", () => {
    const payload = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 500, segs: [{ utf8: "Repeat" }] },
        { tStartMs: 0, dDurationMs: 500, segs: [{ utf8: "Repeat" }] },
      ],
    });

    const first = parseYouTubeCaptions(payload, "aircAruvnKk");
    const second = parseYouTubeCaptions(payload, "aircAruvnKk");
    expect(first.map((segment) => segment.id)).toEqual(second.map((segment) => segment.id));
    expect(new Set(first.map((segment) => segment.id)).size).toBe(2);
  });

  it("rejects malformed formats and invalid video IDs", () => {
    expect(parseYouTubeCaptions("{broken", "aircAruvnKk")).toEqual([]);
    expect(parseYouTubeCaptions("<transcript><text start='0'>hello", "aircAruvnKk")).toEqual([]);
    expect(parseYouTubeCaptions("<transcript><text start='0' dur='1'>A > B</text></transcript>", "aircAruvnKk")).toMatchObject([
      { original: "A > B" },
    ]);
    expect(parseYouTubeCaptions("<transcript/><other/>", "aircAruvnKk")).toEqual([]);
    expect(parseYouTubeCaptions("{}", "not-valid")).toEqual([]);
  });
});

describe("secondsToMilliseconds", () => {
  it("rounds fractional timestamps to the nearest millisecond", () => {
    expect(secondsToMilliseconds(12.3456)).toBe(12346);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE])("rejects invalid seconds: %s", (seconds) => {
    expect(() => secondsToMilliseconds(seconds)).toThrow(RangeError);
  });
});
