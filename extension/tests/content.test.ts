import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { contentKey, parseContentRef } from "../src/shared/content";

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
