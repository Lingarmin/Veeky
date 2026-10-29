# MVP 内部测试用例

2026-10-27 独立版：以下早期字幕检查属于旧 Python 后端，不能视为浏览器字幕读取或本机 ASR 的验证结果。独立版验收清单见 [独立插件方案](standalone-extension.md)。真实 LLM、真实 X 模型和性能验收仍需单独记录。

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

当前测试步骤（LLM 流程，2026-10-26 更新；以下真实服务步骤未在本轮执行）：

1. 在专用测试安装的“LLM 设置”中选择官方服务商、填写该服务商的官方 Key，确认固定只读 API URL 与可编辑模型 ID。保存，或经明确费用授权后点击“测试连通”。再在对应 YouTube 标签页检查字幕类型。
2. 发起分析，记录任务状态和总耗时。
3. 检查原文、译文、章节和重点的时间戳是否能正确跳转。
4. 对同一安装、视频、源/目标语言和相同 LLM 配置再次发起分析，检查响应的 `cacheHit` 与 LLM Mock 请求计数；在明确预置命中条件的自动化用例中确认不会重复生成结果。不要由同一安装命中推断跨安装翻译缓存隔离已完成。
5. 分析进行中切换到普通网页，确认面板不显示。回到原视频标签页后，确认进度或结果恢复。
6. 用 Mock 模拟 LLM 鉴权失败、超时、限流和无效 JSON，核对错误提示及当前任务状态；只有部分结果接口实际返回的原文/译文才应展示，不把请求失败误报为分析成功。不要通过修改真实 Key 或真实供应商配额制造错误。

## X 视频验收

主验收链接：`https://x.com/viktoroddy/status/2075545587093807111/video/1`

2026-09-06 的 Task 13 自动测试使用生成的 100 ms WAV 和 fake ASR 跑通 API 到 Worker 的 X 分析链路。新增的 Playwright X mock 会检查视频时间推进、中文译文下发和中文字幕渲染。真实链接验收需要已登录的 X 页面、用户安装的解压扩展、可访问外网的 Docker 服务和用户自己的 LLM Key，当前执行环境没有这些上下文，因此下面的真实视频手动步骤均未执行。自动化结果不能代替真实视频验收。

自动验证记录：

| 检查 | 结果 | 观察耗时或阻塞 |
|---|---|---|
| API focused regression tests | 7 passed | 7.17 秒 |
| API full pytest | 462 passed | 38.28 秒 |
| Extension unit tests | 270 passed | 7.47 秒 |
| Extension typecheck and build | 通过 | typecheck 7.72 秒，build 1.27 秒 |
| Extension Playwright | 4 passed | 8.4 秒；Chromium 已通过本地代理下载到 Playwright 缓存 |
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
| 7 | 播放完成结果，确认视频只显示两行内的中文字幕且不遮挡关键画面 | 未执行 | 未记录 | Playwright mock 覆盖容器和两行样式，真实播放与遮挡仍需人工验收 |
| 8 | 检查暂停、拖动、倍速播放和切换路由后的同步 | 未执行 | 未记录 | 单元测试覆盖状态变化，真实播放器未执行 |
| 9 | 点击侧边栏时间戳并确认当前 X 视频直接跳转 | 未执行 | 未记录 | 单元测试覆盖跳转消息，真实播放器未执行 |
| 10 | 再次打开帖子并确认直接显示最新完成结果 | 未执行 | 未记录 | 需要先生成真实历史记录 |
| 11 | 重新分析并确认新旧历史记录都可读取 | 未执行 | 未记录 | 需要真实完成结果和用户 LLM Key |
| 12 | 重新加载扩展并完整回归 YouTube 流程 | 未执行 | 未记录 | 当前执行环境没有用户浏览器扩展上下文 |

## 官方 LLM 配置验收（2026-10-26）

本节追加本轮记录，不覆盖上方 2026-09-06 的 X 验收记录。本轮验证包含隔离环境中的后端 pytest、前端单元测试、类型检查、构建和原生 Chromium 扩展 Mock 集成；未执行依赖 Docker 的测试、真实服务商请求、真实视频分析或商店上架验收。

### 当前配置与手动测试状态

| 服务商 | 只读官方 API URL | 默认模型（可编辑） | 真实 Key 连通及长任务验收 |
|---|---|---|---|
| Kimi | `https://api.moonshot.cn/v1` | `kimi-k2.5` | **NOT RUN**：未使用真实 Key |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | **NOT RUN**：未使用真实 Key |
| 腾讯混元 | `https://tokenhub.tencentmaas.com/v1` | `hy3` | **NOT RUN**：未使用 TokenHub 新 Key |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | **NOT RUN**：未使用真实 Key |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.7-flash` | **NOT RUN**：未使用真实 Key |

默认模型仅为项目预设，不声称最新或已通过真实请求验证。混元旧平台于 2026-09-30 停服，必须使用腾讯官方 TokenHub 的新 API Key，旧 Key 不自动复用；官方依据与完整来源见 [设计说明](superpowers/specs/2026-10-26-official-llm-providers-design.md)。

旧中转或非官方配置载入时，运行时 Key 清空并显示重新配置提示，原始存储在明确保存前保留；保存仅更新所选服务商。格式损坏的 LLM 根容器同样在保存前保持原样，明确保存时仅重置该容器及所选服务商。不得删除历史、安装身份或其他设置。LLM 请求忽略环境代理、不跟随重定向；`YOUTUBE_TRANSCRIPT_PROXY_URL` 的独立代理行为不受影响。翻译缓存跨安装隔离仍是独立审计项，不能根据本轮配置测试视为完成。

“测试连通”经本地 API 发起小规模 JSON 请求，并验证 JSON 测试结果，不是普通文本或单纯 HTTP 状态探测。真实请求可能产生少量费用，必须获得授权；成功不保证长视频任务、复杂输出、配额或超时场景成功。本轮仅 Mock 此接口，没有产生服务商调用费用。

### 自动化执行结果

以下记录主代理在隔离 worktree 中的最终独立复验结果。后端在 worktree 根目录执行 `env -u ANALYSES_TEST_DATABASE_URL -u MEDIA_UPLOAD_TEST_DATABASE_URL api/.venv/bin/pytest api/tests -q -rs --tb=short`，退出码 **0**。前端在 `extension/` 执行 `pnpm test && pnpm typecheck && pnpm test:e2e`，最终退出码 **0**；`test:e2e` 已包含 `pnpm build`。

| 检查 | 结果 | 观察耗时或范围 |
|---|---|---|
| API full pytest | **683 passed，9 skipped，退出码 0** | 26.19 秒；2 个 PostgreSQL 迁移测试及 7 个媒体并发测试需要 Docker，未执行 |
| Extension unit tests | **352 passed，7 files passed** | 4.64 秒；无跳过 |
| Extension typecheck | **通过，退出码 0** | `tsc --noEmit`，包含 E2E 测试文件 |
| Extension build | **通过，退出码 0** | 963 ms；由 `test:e2e` 执行 |
| Extension Playwright | **9 passed，0 skipped** | 10.1 秒；保留原有 5 例，新增 4 例 |
| Docker 依赖测试 / 真实服务商及视频验收 | **NOT RUN** | 未执行上述 9 个 Docker 依赖测试，未使用真实服务商 Key 或发起真实视频分析 |

9 个 Chromium 测试覆盖：

1. 默认拦截未 Mock 的 HTTP(S)，验证未匹配的本地 API、外部地址和官方服务商请求均被阻断。
2. 五个服务商选项、固定只读 URL、可编辑模型、独立 Key/模型保存，以及重开设置和页面重载后恢复已保存的服务商。
3. 旧中转 Key 和旧混元 Key 的运行时隔离、保存前原始数据完整保留、明确保存后仅更新所选配置；Mock 连通接口验证发送的仅是所选官方 URL 和新的假 Key，并覆盖首次 401 → 注册 201 → 重试成功。
4. 格式损坏的 LLM 根容器读取无副作用，明确保存仅重置 LLM 容器，其他测试数据保持不变。
5. 已分析 YouTube 标签页的面板启停及原播放器定位。
6. YouTube 历史恢复与无需重载的时间戳跳转。
7. 超过四小时的视频在分析前被拒绝。
8. X 播放推进时的中文字幕渲染与两行样式。
9. X 历史恢复及字幕自动下发。

所有 Chromium 用例使用临时新建的浏览器配置目录，结束后删除该测试目录；在打开页面前安装 HTTP(S) 默认阻断，再添加测试专用 Mock。注册、历史和连通接口均为 Mock；所有 Key 使用明确的 `FAKE-E2E-...` 测试值。没有访问真实 `127.0.0.1:8000`、服务商、用户浏览器配置或真实历史，也没有重启服务。首次新增用例执行中发现 401 Mock 错误码与真实客户端契约不符，修正为 `installation_auth_required` 后全套通过；没有因此修改生产代码或跳过行为。

待人工验收：五家真实官方账户的小规模 JSON 连通、至少一个真实长任务及原有真实 YouTube/X 清单。以上状态均保持 **NOT RUN**；自动化通过不等于完整安全审计或可直接上架。
