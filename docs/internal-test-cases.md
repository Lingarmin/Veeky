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

## X 视频验收

主验收链接：`https://x.com/viktoroddy/status/2075545587093807111/video/1`

2026-09-06 的 Task 13 自动测试使用生成的 100 ms WAV 和 fake ASR 跑通 API 到 Worker 的 X 分析链路。新增的 Playwright X mock 会检查视频时间推进、中文译文下发和中文字幕渲染。真实链接验收需要已登录的 X 页面、用户安装的解压扩展、可访问外网的 Docker 服务和用户自己的 LLM Key，当前执行环境没有这些上下文，因此下面的真实视频手动步骤均未执行。自动化结果不能代替真实视频验收。

自动验证记录：

| 检查 | 结果 | 观察耗时或阻塞 |
|---|---|---|
| API focused tests | 47 passed | 31.76 秒 |
| API full pytest | 461 passed | 49.29 秒 |
| Extension unit tests | 270 passed | 4.20 秒 |
| Extension typecheck and build | 通过 | 3.27 秒 |
| Extension Playwright | 4 passed | 10.5 秒；Chromium 已通过本地代理下载到 Playwright 缓存 |
| Docker Compose config and API/Worker build | 通过 | 镜像构建约 72 秒 |
| Docker Compose startup and health | 通过 | 默认端口被已有用户服务占用，改用隔离端口后约 12 秒启动；`http://127.0.0.1:18000/health` 返回 `{"status":"ok"}` |

| 序号 | 验收项 | 状态 | 观察耗时 | 失败步骤或未执行原因 |
|---:|---|---|---:|---|
| 1 | 在已登录的 X 页面打开主验收视频 | 未执行 | 未记录 | 当前测试浏览器没有用户 X 登录态 |
| 2 | 不播放时点击检查并确认先播放提示 | 未执行 | 未记录 | 需要真实 X 页面和已安装扩展 |
| 3 | 播放 1 至 2 秒后重新检查并开始分析 | 未执行 | 未记录 | 需要真实媒体请求和用户 LLM Key |
| 4 | 验证服务端下载成功路径 | 未执行 | 未记录 | 没有向真实 X 媒体地址发起下载 |
| 5 | 模拟服务端 403 并验证浏览器分片上传接管 | 未执行 | 未记录 | 需要真实浏览器登录态和运行中的服务栈 |
| 6 | 核对下载、上传、提取音频、识别、摘要和翻译文案 | 未执行 | 未记录 | 需要完整真实任务 |
| 7 | 播放完成结果并确认视频只显示中文字幕 | 未执行 | 未记录 | Playwright mock 有自动覆盖，真实链接未执行 |
| 8 | 检查暂停、拖动、倍速播放和切换路由后的同步 | 未执行 | 未记录 | 单元测试覆盖状态变化，真实播放器未执行 |
| 9 | 点击侧边栏时间戳并确认当前 X 视频直接跳转 | 未执行 | 未记录 | 单元测试覆盖跳转消息，真实播放器未执行 |
| 10 | 再次打开帖子并确认直接显示最新完成结果 | 未执行 | 未记录 | 需要先生成真实历史记录 |
| 11 | 重新分析并确认新旧历史记录都可读取 | 未执行 | 未记录 | 需要真实完成结果和用户 LLM Key |
| 12 | 重新加载扩展并完整回归 YouTube 流程 | 未执行 | 未记录 | 当前执行环境没有用户浏览器扩展上下文 |
