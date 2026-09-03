# Veeky X 视频字幕翻译设计

日期：2026-09-03

状态：已确认

## 目标

Veeky 在保留 YouTube 分析能力的基础上，支持 `x.com` 公开帖子中的普通视频。用户在已登录的 X 页面播放视频 1 至 2 秒后，可以生成带时间戳的原文、中文译文、摘要、章节和重点片段。分析完成后，插件把中文译文叠加到当前 X 视频画面，并根据播放器进度同步显示。

这里的“实时字幕”指预先完成识别和翻译，再在播放时实时同步字幕。MVP 不做边播放边识别的流式 ASR。

主验收视频：

`https://x.com/viktoroddy/status/2075545587093807111/video/1`

该视频约 21 分 23 秒，X 播放器使用 `blob:` 媒体源，页面没有可读取的字幕轨道，因此必须通过 ASR 生成逐字稿。

## 范围

支持：

- `https://x.com/{user}/status/{status_id}`
- `https://x.com/{user}/status/{status_id}/video/{media_index}`
- 公开帖子中、用户登录后能在当前页面正常播放的普通视频
- 单个帖子中的多个视频，以 `media_index` 区分
- 链接没有 `/video/{media_index}` 时，以用户当前实际播放的视频确定 `media_index`
- 视频上只显示中文译文，侧边栏同时显示原文和中文译文

暂不支持：

- `twitter.com` 地址
- X Space、直播、私信、受保护账号内容和删除的帖子
- 边播放边识别
- TTS 或中文配音
- 把 X Cookie、访问令牌或请求头上传到 Veeky 服务端

## 方案选择

采用“服务端媒体地址优先，浏览器上传兜底”的方案。

1. 插件从当前标签页捕获实际加载的 `video.twimg.com` 媒体资源。
2. API 只接受允许域名下的媒体地址。Worker 先尝试匿名下载。
3. 如果服务端收到 401、403、地址过期或无法完成下载，任务进入 `waiting_for_media`。
4. 插件在用户已登录的浏览器中读取该媒体，并把媒体数据分片上传。Cookie 和认证请求头不会离开浏览器。
5. Worker 使用 `ffmpeg` 提取 16 kHz 单声道音频，再用 `faster-whisper small` 生成带时间戳的原文。
6. 原文进入现有翻译和摘要流程。分析完成后，字幕覆盖层根据 `video.currentTime` 显示中文译文。

没有采用纯服务端下载，因为公开 X 帖子仍可能限制匿名服务器访问。没有采用浏览器内 ASR，因为 21 分钟及更长的视频会占用较多内存和 CPU，模型下载和浏览器生命周期也不适合当前侧边栏架构。

## 平台抽象

当前系统以 11 位 YouTube `video_id` 贯穿插件、API、缓存和数据库。X status ID 长度不同，而且一条帖子可能有多个视频。系统需要改为平台无关的内容引用：

```text
ContentRef
  platform: youtube | x
  source_content_id: YouTube video ID | X status ID
  media_index: 1-based integer
```

数据库内部使用 UUID `content_id`。前端和 API 不再把 `videoId` 当作通用主键。YouTube 适配器继续使用公开视频字幕，X 适配器使用媒体捕获和 ASR。

```text
SourceAdapter
  parse_url(url) -> ContentRef
  inspect(content_ref, source_hint) -> SourceInspection
  acquire_transcript_or_media(...) -> source artifact

YouTubeAdapter
  youtube-transcript-api -> timed transcript

XAdapter
  captured media URL -> server download
  browser upload -> temporary media package
  faster-whisper -> timed transcript
```

翻译、摘要、历史记录和结果展示只消费标准化的时间戳逐字稿，不关心来源平台。

## 插件改造

### Manifest 和后台服务

`manifest.json` 增加：

- `https://x.com/*` 和 `https://video.twimg.com/*` 的 host permissions
- `webRequest`，用于观察当前标签页发起的 X 媒体请求
- `offscreen`，用于长时间媒体读取和分片上传，避免 Manifest V3 service worker 休眠中断上传
- X 页面 content script

后台服务按 `tabId + ContentRef` 保存短期媒体候选，使用 `chrome.storage.session`，默认 10 分钟后失效。它只记录资源 URL、资源类型和捕获时间，不记录 Cookie 或认证请求头。

### X 页面适配器

新增 X content script，职责如下：

- 识别 X 单页应用的路由变化
- 解析 status ID 和 `/video/{media_index}`
- 监听 `<video>` 的 `play`、`pause`、`seeked` 和 DOM 替换
- 找到当前正在播放的视频，而不是评论区或推荐内容中的其他视频
- 在用户开始播放时通知后台打开媒体捕获窗口
- 在 X 重新渲染播放器后重新绑定字幕覆盖层

捕获媒体时先读取页面已加载的资源记录，再观察后续 `video.twimg.com` 请求。`blob:` 只作为播放器状态信号，不能提交给 API。

### 浏览器上传兜底

offscreen document 使用浏览器登录态获取已捕获的媒体资源，但上传给 API 的只有媒体字节和必要的分段顺序信息。

- 普通 MP4 按 8 MiB 分片上传
- HLS 资源上传本地化清单、初始化段和有序媒体段
- 每个分片带序号、字节数和 SHA-256
- API 支持幂等重传和查询已接收分片
- 侧边栏关闭后，offscreen document 可以继续当前上传
- 页面关闭、安装身份变化或上传会话过期时停止上传

### 字幕覆盖层

字幕作为独立 DOM 节点挂载到当前视频容器，不修改 X 自带播放器结构。默认样式为底部居中、两行以内的中文字幕，避免挡住播放器控制条。

同步逻辑：

- `timeupdate` 和 `requestAnimationFrame` 共同读取 `video.currentTime`
- 使用二分查找定位当前字幕片段
- 播放、暂停、拖动和倍速播放不触发页面跳转或视频重载
- 当前页面、status ID 或 media index 变化时立即移除旧字幕
- 历史记录中的其他视频结果只在用户导航到对应帖子后才叠加

侧边栏逐字稿继续显示原文和中文译文。点击时间戳时直接设置目标 `<video>.currentTime`。

## API 设计

现有接口扩展为平台无关契约。

### 检查内容

```http
POST /v1/videos/inspect
```

请求包含 `url`，X 页面还可以附带插件捕获的媒体候选。响应包含：

```text
contentId
contentRef
title
durationMs
sourceStatus: ready | play_required | media_required | unavailable
transcriptSource: youtube_caption | faster_whisper
availableLanguages
selectedLanguage
```

X 没有字幕轨道时，检查成功表示媒体可以进入 ASR，不再返回“无可读取字幕”。

### 媒体上传会话

```http
POST   /v1/media-sessions
GET    /v1/media-sessions/{session_id}
PUT    /v1/media-sessions/{session_id}/parts/{part_number}
POST   /v1/media-sessions/{session_id}/complete
DELETE /v1/media-sessions/{session_id}
```

所有接口要求安装实例身份。服务端验证会话属于当前安装实例和目标内容，禁止跨用户读取、追加或完成上传。

### 创建分析

```http
POST /v1/analyses
```

请求使用 `contentId` 或 `ContentRef`，并可包含捕获的媒体地址或已完成的 `mediaSessionId`。强制重新分析仍会新增记录，不覆盖旧结果。

历史记录和结果接口返回 `contentRef`。历史查询使用 `contentId`，同时保留一个版本的 `videoId` 兼容字段，供旧插件版本读取 YouTube 记录。

## Worker 和 ASR

任务状态扩展为：

```text
queued
waiting_for_media
downloading_media
extracting_audio
transcribing
analyzing
translating
completed
failed
```

X 任务处理顺序：

```text
验证媒体来源
-> 下载媒体或等待浏览器上传
-> ffprobe 校验时长和轨道
-> ffmpeg 提取 16 kHz mono WAV
-> faster-whisper small 识别
-> 标准化字幕片段
-> 生成摘要、章节和重点片段
-> 翻译字幕
-> 完成任务并删除临时文件
```

ASR 固定配置：

```text
model_size: small
device: cpu
compute_type: int8
vad_filter: true
language: auto
timestamps: segment level
```

模型目录挂载为 Docker volume。镜像包含 `ffmpeg` 和 `faster-whisper` 运行依赖，模型首次使用时下载，后续复用。模型名称、CTranslate2 版本和转写参数写入 `transcript_version`，防止错误复用其他模型生成的缓存。

ASR 输出句级时间戳。过长句段按停顿和标点拆分，保持时间连续，供侧边栏和视频覆盖层共同使用。

## 数据库迁移

采用兼容迁移，不清理现有历史数据。

1. `videos` 增加 UUID `content_id`、`platform`、`source_content_id` 和 `media_index`。
2. 为现有 YouTube 记录生成 UUID，并回填 `platform=youtube`、`source_content_id=video_id`、`media_index=1`。
3. `transcript_tracks` 和 `analysis_jobs` 增加 `content_id` 外键并回填。
4. 新代码使用 `content_id`，旧 `video_id` 暂时保留且允许 X 记录为空。
5. 一个稳定版本后再单独迁移和删除旧外键。本功能的首个版本不删除旧列。

新增字段：

```text
videos.content_id UUID unique not null
videos.platform varchar not null
videos.source_content_id varchar not null
videos.media_index integer not null
transcript_tracks.content_id UUID not null
transcript_tracks.transcript_source varchar not null
transcript_tracks.asr_model varchar null
analysis_jobs.content_id UUID not null
```

唯一约束为 `(platform, source_content_id, media_index)`。

上传会话单独建表，记录安装实例、内容、状态、已接收字节数、过期时间和临时目录引用。数据库不保存媒体二进制、Cookie 或认证请求头。

## 缓存和历史记录

字幕缓存键包含：

```text
platform
source_content_id
media_index
transcript_source
asr_model
asr_runtime_version
transcription_parameters_version
audio_fingerprint
```

翻译与摘要缓存继续包含源语言、目标语言、模型和提示词版本。

打开已经分析完成的 X 视频时，插件按 `ContentRef` 查询当前安装实例的历史记录并直接展示最新完成结果，同时加载中文字幕覆盖层。点击“重新分析”会创建新任务和新历史记录，不覆盖旧记录。

## 限制和安全

- 视频时长上限保持 4 小时，超过后提示“此视频时长过长，无法分析”。
- 单个媒体包默认上限 4 GiB，超过后提示媒体文件过大。
- 上传分片固定为 8 MiB，上传会话 2 小时未完成即失效。
- 单个任务临时磁盘上限 6 GiB，下载超时 30 分钟，ASR 任务超时 6 小时。
- 每个安装实例最多 1 个活动分析任务，沿用现有请求频率限制。
- API 只允许 `https://video.twimg.com` 媒体地址，拒绝其他协议、用户信息、非标准端口和跨域重定向。
- 下载前后都校验目标域名和解析 IP，阻止 SSRF 和重定向到内网地址。
- `ffprobe` 校验实际媒体时长、容器和音视频轨道，不能信任浏览器提交的元数据。
- 临时视频、音频、清单和分片在任务成功、失败、取消或过期后删除。
- 安装实例只能查询自己的上传会话、任务和结果。
- LLM API Key 继续按现有方案加密暂存，任务结束后删除。

## 失败处理

用户可见错误必须说明下一步操作：

| 错误码 | 提示与恢复方式 |
| --- | --- |
| `x_video_play_required` | 请先播放当前视频 1 至 2 秒，再重试 |
| `x_media_not_detected` | 未检测到当前视频媒体，请确认视频可以正常播放 |
| `x_media_url_expired` | 媒体地址已过期，请重新播放视频 |
| `browser_upload_required` | 自动切换到浏览器上传，并显示上传进度 |
| `media_too_large` | 视频文件过大，无法分析 |
| `video_duration_exceeded` | 此视频时长过长，无法分析 |
| `media_upload_interrupted` | 保留有效分片并继续上传，或允许用户重新开始 |
| `audio_track_missing` | 视频中没有可识别的音轨 |
| `asr_resource_exhausted` | 当前设备资源不足，请稍后重试 |
| `asr_failed` | 语音识别失败，可重新分析 |
| `translation_failed` | 保留原文和摘要，允许单独重试翻译 |
| `llm_config_required` | 引导用户完成 LLM 配置后继续 |

任务失败后清理 LLM 凭据和临时媒体。断点上传只在会话有效期内保留已验证的分片。

## 可观测性

日志使用 `job_id`、`installation_id` 哈希、`content_id` 和 `media_session_id` 关联，不记录媒体 URL 查询参数、Cookie、API Key、字幕全文或上传内容。

记录以下事件和耗时：

- X 媒体候选捕获及选择结果
- 服务端下载结果和浏览器上传切换原因
- 下载字节数、上传进度和重试次数
- ffmpeg 与 ASR 阶段耗时
- ASR 检测语言、片段数量和缓存命中
- 字幕覆盖层绑定、解绑和同步错误

## 代码改动范围

插件主要修改：

- `extension/manifest.json`
- `extension/src/background.ts`
- `extension/src/shared/types.ts`
- `extension/src/sidepanel/App.tsx`
- `extension/src/sidepanel/api.ts`
- `extension/src/sidepanel/browser.ts`

插件新增 X content script、字幕覆盖层、媒体捕获模块、offscreen 上传模块及对应测试。

API 和 Worker 主要修改：

- `api/app/api/analyses.py`
- `api/app/db/models.py`
- `api/app/workers/tasks.py`
- `api/app/core/settings.py`
- `api/app/services/transcripts.py`
- `api/Dockerfile`
- `api/pyproject.toml`
- `docker-compose.yml`

后端新增 source adapter、X 媒体服务、上传会话服务、faster-whisper 转写器、Alembic 迁移及对应测试。

这属于中大型跨层改造，但应继续在现有 Veeky 项目内完成。新建项目会复制用户身份、历史记录、LLM 配置和分析链路，后续还要维护两套插件，不值得。

## 测试和验收

自动测试：

- X URL 解析、无效 host、status ID 和 media index
- 平台适配器路由及 YouTube 回归
- 媒体 URL allowlist、重定向和 SSRF 防护
- 分片上传的身份隔离、校验、幂等、续传和过期清理
- 4 小时、4 GiB、临时磁盘和并发限制
- ASR 输出标准化、版本缓存和失败映射
- 数据迁移回填及原有 YouTube 历史可读
- 新任务状态及中断恢复
- 字幕片段二分查找和时间同步
- X SPA 路由变化、播放器替换和多视频选择

手动验收：

1. 在已登录的 X 页面打开主验收视频。
2. 不播放时点击检查，确认提示先播放。
3. 播放 1 至 2 秒后重新检查并开始分析。
4. 验证服务端下载成功路径。
5. 模拟服务端 403，验证浏览器分片上传自动接管。
6. 验证下载、上传、提取音频、识别、摘要和翻译状态文案。
7. 分析完成后继续播放，确认只显示中文字幕。
8. 暂停、拖动、倍速播放和切换路由，确认字幕同步且视频不重载。
9. 点击侧边栏时间戳，确认当前 X 视频直接跳转。
10. 再次打开该帖子，确认直接显示最新完成结果。
11. 点击重新分析，确认新增历史记录且旧记录仍可读取。
12. 重新加载扩展并完整回归 YouTube 检查、分析、翻译、摘要、历史和时间戳跳转。

## 回滚

- 插件代码和 Worker 路由可以按功能分支整体回滚。
- 首次数据库迁移只增加字段、表和索引。回滚应用代码时保留这些结构，不删除或清理用户数据。
- 若必须执行 Alembic downgrade，只删除新上传会话和 X 专用数据；已有 YouTube 视频、任务、字幕、翻译和历史记录必须保留。
