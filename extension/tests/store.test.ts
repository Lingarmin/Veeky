import { describe, expect, it } from "vitest";

import { buildWatchUrl, errorMessageForCode, formatTime } from "../src/sidepanel/store";

describe("side panel helpers", () => {
  it("builds a timestamped YouTube URL", () => {
    expect(buildWatchUrl("aircAruvnKk", 72_500)).toBe(
      "https://www.youtube.com/watch?v=aircAruvnKk&t=72s",
    );
  });

  it("maps backend failures to product copy", () => {
    expect(errorMessageForCode("no_caption_track")).toBe("该视频暂无可读取字幕");
    expect(errorMessageForCode("request_blocked")).toBe("字幕服务暂时不可用，请稍后重试");
    expect(errorMessageForCode("unexpected")).toBe("分析没有完成，请稍后重试");
  });

  it("formats long videos with hours", () => {
    expect(formatTime(3_723_000)).toBe("1:02:03");
  });
});
