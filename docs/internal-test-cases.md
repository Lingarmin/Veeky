# MVP 内部测试用例

字幕可读性已在 2026-07-31 使用 `youtube-transcript-api` 检查。YouTube 可能随时调整字幕、地区权限或视频状态，执行内部测试时仍需记录当次结果。

| 类别 | 视频 | 源字幕 | 当前读取结果 | 预期失败码 |
|---|---|---|---|---|
| 英语人工字幕 | `https://www.youtube.com/watch?v=aircAruvnKk` | `en` | 可读取，人工字幕优先 | 无 |
| 英语自动字幕 | `https://www.youtube.com/watch?v=ZXsQAXx_ao0` | `en` | 可读取，仅自动字幕 | 无 |
| 中文人工字幕 | `https://www.youtube.com/watch?v=aircAruvnKk` | `zh-CN` | 可读取，人工字幕 | 无 |
| 日语人工字幕 | `https://www.youtube.com/watch?v=aircAruvnKk` | `ja` | 可读取，人工字幕 | 无 |
| 字幕已禁用 | `https://www.youtube.com/watch?v=aqz-KE-bpKQ` | 无 | `TranscriptsDisabled` | `captions_disabled` |
| 视频不可用 | `https://www.youtube.com/watch?v=aaaaaaaaaaa` | 无 | `VideoUnavailable` | `video_unavailable` |

每次内部测试记录以下字段：

| 日期 | 视频 ID | 字幕类型 | 字幕段数 | 翻译成功率 | 首次总耗时 | 缓存总耗时 | 失败码 | 人工可读性 |
|---|---|---:|---:|---:|---:|---:|---|---|
|  |  |  |  |  |  |  |  |  |

测试步骤：

1. 在对应 YouTube 标签页打开扩展并检查字幕类型。
2. 发起分析，记录任务状态和总耗时。
3. 检查原文、译文、章节和重点的时间戳是否能正确跳转。
4. 对同一视频和语言再次发起分析，确认返回 `cacheHit: true`，且 LibreTranslate 没有收到新请求。
5. 分析进行中切换到普通网页，确认面板不显示。回到原视频标签页后，确认进度或结果恢复。
6. 模拟 LibreTranslate 不可用，确认面板仍显示原始逐字稿，并标注译文和摘要尚未完成。
