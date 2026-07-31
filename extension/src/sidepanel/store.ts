const ERROR_MESSAGES: Record<string, string> = {
  captions_disabled: "该视频暂无可读取字幕",
  no_caption_track: "该视频暂无可读取字幕",
  empty_transcript: "该视频暂无可读取字幕",
  video_unavailable: "当前无法读取该视频字幕",
  request_blocked: "字幕服务暂时不可用，请稍后重试",
  dispatch_failed: "后台任务暂时无法启动，请重试",
  transcript_changed: "视频字幕刚刚更新，请重新分析",
  translation_failed: "翻译暂时失败，原始字幕仍可查看",
  analysis_unavailable: "摘要服务暂时不可用，请稍后重试",
};

export function errorMessageForCode(code?: string | null): string {
  return code && ERROR_MESSAGES[code]
    ? ERROR_MESSAGES[code]
    : "分析没有完成，请稍后重试";
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
