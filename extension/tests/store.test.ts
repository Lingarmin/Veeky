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
    expect(errorMessageForCode("transcript_connection_failed")).toBe("无法连接 YouTube 字幕服务，请检查代理后重试");
    expect(errorMessageForCode("api_unavailable")).toBe("本地分析服务未启动。请运行 docker compose up -d 后重试。");
    expect(errorMessageForCode("worker_unavailable")).toBe("后台任务服务未启动。请运行 docker compose up -d 后重试。");
    expect(errorMessageForCode("invalid_youtube_url")).toBe("请输入有效的 YouTube 视频链接");
    expect(errorMessageForCode("source_language_unavailable")).toBe("所选字幕语言已不可读，请重新检查视频");
    expect(errorMessageForCode("translation_rejected")).toBe("翻译服务拒绝了请求，请检查 LLM 配置");
    expect(errorMessageForCode("llm_quota_exhausted")).toBe("LLM 账户余额不足，请充值或更换 API Key/服务商");
    expect(errorMessageForCode("llm_invalid_response")).toBe("LLM 返回格式无效，请检查模型名称和 Chat Completions 地址");
    expect(errorMessageForCode("unexpected")).toBe("分析没有完成，请稍后重试");
    expect(errorMessageForCode("unexpected", "LLM 连接测试失败")).toBe("LLM 连接测试失败");
  });

  it("formats long videos with hours", () => {
    expect(formatTime(3_723_000)).toBe("1:02:03");
  });
});
