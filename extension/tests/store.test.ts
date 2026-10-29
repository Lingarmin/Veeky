import { describe, expect, it } from "vitest";

import { buildWatchUrl, errorMessageForCode, formatTime } from "../src/sidepanel/store";

describe("side panel helpers", () => {
  it.each([
    "registration_daily_limit", "analysis_daily_limit", "asr_daily_limit", "media_daily_limit",
    "global_analysis_concurrency_limit", "ip_analysis_concurrency_limit", "media_global_capacity",
    "media_disk_low", "global_media_session_limit", "ip_media_session_limit", "admission_busy",
  ])("explains resource rejection %s without claiming analysis failed", (code) => {
    expect(errorMessageForCode(code)).not.toBe("分析没有完成，请稍后重试");
    expect(errorMessageForCode(code)).toMatch(/额度|上限|队列|空间|正在|繁忙/);
  });
  it("builds a timestamped YouTube URL", () => {
    expect(buildWatchUrl("aircAruvnKk", 72_500)).toBe(
      "https://www.youtube.com/watch?v=aircAruvnKk&t=72s",
    );
  });

  it("maps backend failures to product copy", () => {
    expect(errorMessageForCode("llm_config_invalid")).toBe("请使用所选服务商的官方地址，并填写模型名称和官方 API Key；不支持第三方中转");
    expect(errorMessageForCode("llm_unsafe_destination")).toBe("LLM 目标地址未通过安全检查，请使用官方服务并检查网络或 DNS 设置");
    expect(errorMessageForCode("llm_model_unavailable")).toBe("该模型不可用或当前 API Key 无权访问，请检查模型 ID 和服务商授权");
    expect(errorMessageForCode("no_caption_track")).toBe("该视频暂无可读取字幕");
    expect(errorMessageForCode("request_blocked")).toBe("字幕服务暂时不可用，请稍后重试");
    expect(errorMessageForCode("transcript_connection_failed")).toBe("无法连接 YouTube 字幕服务，请检查代理后重试");
    expect(errorMessageForCode("api_unavailable")).toBe("无法读取旧版历史记录，请检查旧服务是否可用。");
    expect(errorMessageForCode("worker_unavailable")).toBe("本地任务未启动，请重新打开插件。");
    expect(errorMessageForCode("invalid_youtube_url")).toBe("请输入有效的 YouTube 视频链接");
    expect(errorMessageForCode("source_language_unavailable")).toBe("所选字幕语言已不可读，请重新检查视频");
    expect(errorMessageForCode("translation_rejected")).toBe("翻译服务拒绝了请求，请检查 LLM 配置");
    expect(errorMessageForCode("llm_quota_exhausted")).toBe("LLM 账户余额不足，请充值或更换 API Key/服务商");
    expect(errorMessageForCode("llm_invalid_response")).toBe("LLM 返回格式无效，请检查模型名称和 Chat Completions 地址");
    expect(errorMessageForCode("video_too_long")).toBe("此视频时长过长，无法分析。");
    expect(errorMessageForCode("media_too_long")).toBe("此视频时长过长，无法分析。");
    expect(errorMessageForCode("analysis_concurrency_limit")).toBe("已有视频正在分析，请等待完成后再试。");
    expect(errorMessageForCode("rate_limit_exceeded")).toBe("操作过于频繁，请稍后再试。");
    expect(errorMessageForCode("llm_credentials_expired")).toBe("任务凭据已过期，请点击重试。");
    expect(errorMessageForCode("quota_service_unavailable")).toBe("服务暂时繁忙，请稍后再试。");
    expect(errorMessageForCode("installation_auth_required")).toBe("插件身份验证失败，请刷新后重试。");
    expect(errorMessageForCode("x_video_play_required")).toBe("请先播放当前视频 1 至 2 秒，再重试");
    expect(errorMessageForCode("x_video_context_required")).toBe("请先打开并播放要重新分析的 X 视频，然后重试");
    expect(errorMessageForCode("x_media_not_detected")).toBe("未检测到当前视频媒体，请确认视频可以正常播放");
    expect(errorMessageForCode("x_media_url_expired")).toBe("媒体地址已过期，请重新播放视频");
    expect(errorMessageForCode("media_too_large")).toBe("视频文件过大，无法分析");
    expect(errorMessageForCode("media_upload_interrupted")).toBe("视频上传中断，请重新开始");
    expect(errorMessageForCode("audio_track_missing")).toBe("该视频没有可读取的音轨");
    expect(errorMessageForCode("asr_resource_exhausted")).toBe("当前设备资源不足，请稍后重试");
    expect(errorMessageForCode("asr_failed")).toBe("语音识别失败，请重新分析");
    expect(errorMessageForCode("unexpected")).toBe("分析没有完成，请稍后重试");
    expect(errorMessageForCode("unexpected", "LLM 连接测试失败")).toBe("LLM 连接测试失败");
  });

  it("formats long videos with hours", () => {
    expect(formatTime(3_723_000)).toBe("1:02:03");
  });
});
