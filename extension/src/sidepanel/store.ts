const ERROR_MESSAGES: Record<string, string> = {
  captions_disabled: "该视频暂无可读取字幕",
  no_caption_track: "该视频暂无可读取字幕",
  empty_transcript: "该视频暂无可读取字幕",
  invalid_youtube_url: "请输入有效的 YouTube 视频链接",
  invalid_video_id: "视频 ID 无效，请重新检查视频链接",
  video_unavailable: "当前无法读取该视频字幕",
  transcript_unavailable: "当前无法读取该视频字幕",
  request_blocked: "字幕服务暂时不可用，请稍后重试",
  transcript_connection_failed: "无法连接 YouTube 字幕服务，请检查代理后重试",
  api_unavailable: "本地分析服务未启动。请运行 docker compose up -d 后重试。",
  worker_unavailable: "后台任务服务未启动。请运行 docker compose up -d 后重试。",
  dispatch_failed: "后台任务暂时无法启动，请重试",
  transcript_changed: "视频字幕刚刚更新，请重新分析",
  translation_failed: "翻译暂时失败，原始字幕仍可查看",
  analysis_unavailable: "摘要服务暂时不可用，请稍后重试",
  analysis_internal_error: "后台分析出现异常，请查看服务日志后重试",
  analysis_not_complete: "分析任务尚未完成，请稍后重试",
  analysis_not_found: "分析任务已失效，请重新开始分析",
  source_language_unavailable: "所选字幕语言已不可读，请重新检查视频",
  llm_config_required: "请先配置 LLM 服务，才能生成翻译和视频概览",
  llm_config_invalid: "LLM API 地址或 Provider 无效，请检查配置",
  llm_authentication_failed: "LLM API Key 无效，请检查配置",
  llm_unavailable: "无法连接 LLM 服务，请检查地址和网络",
  llm_rate_limited: "LLM 服务请求过于频繁，请稍后重试",
  llm_quota_exhausted: "LLM 账户余额不足，请充值或更换 API Key/服务商",
  llm_request_rejected: "LLM 服务拒绝了请求，请检查 API 配置",
  llm_invalid_response: "LLM 返回格式无效，请检查模型名称和 Chat Completions 地址",
  translation_authentication_failed: "LLM API Key 无效，请检查配置",
  translation_unavailable: "无法连接 LLM 翻译服务，请检查地址和网络",
  translation_rate_limited: "LLM 翻译请求过于频繁，请稍后重试",
  translation_rejected: "翻译服务拒绝了请求，请检查 LLM 配置",
  translation_invalid_response: "LLM 翻译返回格式无效，请检查模型配置",
  translation_response_mismatch: "LLM 翻译结果不完整，请稍后重试",
  translation_segment_too_large: "字幕段落过长，无法提交给 LLM 翻译",
  analysis_invalid_response: "LLM 摘要返回格式无效，请检查模型是否支持 JSON 输出",
};

export function errorMessageForCode(
  code?: string | null,
  fallback = "分析没有完成，请稍后重试",
): string {
  return code && ERROR_MESSAGES[code]
    ? ERROR_MESSAGES[code]
    : fallback;
}

export function buildWatchUrl(videoId: string, startMs: number): string {
  const seconds = Math.max(0, Math.floor(startMs / 1000));
  return `https://www.youtube.com/watch?v=${videoId}&t=${seconds}s`;
}

export function formatTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const clock = `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${clock.padStart(5, "0")}` : clock;
}
