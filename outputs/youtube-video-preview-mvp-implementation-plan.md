# YouTube 视频预览工具 MVP 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 建立一个只在发起分析的 YouTube 标签页显示的 Chrome Side Panel，读取公开字幕，经 LibreTranslate 翻译后生成可跳转的视频概览、章节和重点片段。

**Architecture:** Chrome 扩展只处理标签页状态与结果展示；FastAPI 接收任务、读取缓存并提供查询接口；Celery Worker 在后台读取字幕、翻译和生成分析结果。字幕和译文以时间戳段为基本数据，翻译实现可由 LibreTranslate 无缝替换为 LLM。

**Tech Stack:** Manifest V3、React、TypeScript、Vite、FastAPI、Python 3.12、PostgreSQL、Redis、Celery、`youtube-transcript-api`、LibreTranslate。

---

## 目录结构

```text
extension/
  manifest.json
  src/background.ts
  src/sidepanel/App.tsx
  src/sidepanel/api.ts
  src/sidepanel/store.ts
  src/shared/types.ts
  tests/background.test.ts
api/
  app/main.py
  app/api/analyses.py
  app/core/settings.py
  app/db/models.py
  app/services/transcripts.py
  app/services/translation.py
  app/services/analysis.py
  app/workers/tasks.py
  tests/test_transcripts.py
  tests/test_translation.py
  tests/test_analyses_api.py
docker-compose.yml
```

## Task 1: 建立本地运行环境

**Files:** 创建 `docker-compose.yml`、`api/pyproject.toml`、`api/app/main.py`、`api/app/core/settings.py`。

- [ ] 使用 Docker Compose 启动 PostgreSQL、Redis 和受控 LibreTranslate 实例；本地端口只暴露给开发环境。
- [ ] 配置 FastAPI 的数据库 URL、Redis URL、LibreTranslate URL、分析模型 API Key 和允许的 Chrome 扩展 Origin。
- [ ] 添加 `GET /health`，检查 API 自身、PostgreSQL 和 Redis 连通性。
- [ ] 编写健康检查测试：当依赖可用时接口返回 `{ "status": "ok" }`，依赖不可用时返回 503。
- [ ] 运行 `pytest api/tests -q`，确认健康检查通过。

## Task 2: 定义数据模型和迁移

**Files:** 创建 `api/app/db/models.py`、`api/alembic/versions/0001_initial.py`。

- [ ] 创建 `videos`、`transcript_tracks`、`transcript_segments`、`translations`、`analysis_jobs`、`analysis_results` 表。
- [ ] 为 `videos.video_id` 建唯一索引；为 `translations(track_id, target_language, transcript_version, provider_version)` 建唯一索引。
- [ ] 为 `analysis_jobs(video_id, source_language, target_language)` 建索引，支持复用已完成任务。
- [ ] 编写模型测试：相同翻译缓存键的第二次插入必须被唯一约束拒绝。
- [ ] 执行迁移并运行 `pytest api/tests -q`。

## Task 3: 实现字幕检查和读取

**Files:** 创建 `api/app/services/transcripts.py`、`api/tests/test_transcripts.py`。

- [ ] 定义 `TranscriptService.inspect(video_id)`，返回语言、语言名、`is_generated`、`is_translatable` 和可读状态。
- [ ] 使用 `YouTubeTranscriptApi().list(video_id)` 列出轨道，并对选择轨道调用 `fetch()` 验证至少有一个有效时间段。
- [ ] 将库异常标准化为 `captions_disabled`、`no_caption_track`、`video_unavailable`、`request_blocked`。
- [ ] 实现选择策略：指定语言人工字幕、指定语言自动字幕、英语人工字幕、英语自动字幕、任意人工字幕、任意自动字幕。
- [ ] 编写模拟测试，覆盖人工字幕、自动字幕、空字幕和四种失败码。
- [ ] 运行 `pytest api/tests/test_transcripts.py -q`。

## Task 4: 暴露视频检查与任务接口

**Files:** 创建 `api/app/api/analyses.py`、更新 `api/app/main.py`、创建 `api/tests/test_analyses_api.py`。

- [ ] 实现 `POST /v1/videos/inspect`，仅接受 `youtube.com/watch`、`youtu.be`、`youtube.com/shorts` URL，返回视频 ID 和可用轨道。
- [ ] 实现 `POST /v1/analyses`，校验所选源语言可读；命中完成缓存时返回已有 `jobId` 与 `cacheHit: true`，否则创建 `queued` 任务。
- [ ] 实现 `GET /v1/analyses/{jobId}` 和 `GET /v1/analyses/{jobId}/result`；未完成结果请求返回 409。
- [ ] 编写 API 测试，覆盖 URL 无效、无字幕、缓存命中、任务创建、未完成结果和完成结果。
- [ ] 运行 `pytest api/tests/test_analyses_api.py -q`。

## Task 5: 实现可替换翻译层

**Files:** 创建 `api/app/services/translation.py`、`api/tests/test_translation.py`。

- [ ] 定义 `TranslationProvider.translate(segments, source_language, target_language)` 协议，返回与输入段 ID 一一对应的译文。
- [ ] 实现 `LibreTranslateProvider`，将相邻字幕聚合成不超过 3,000 字符的批次，请求受控 LibreTranslate 实例。
- [ ] 拆回原字幕段时保留 `segment_id`、`start_ms`、`duration_ms`；任何段丢失都标记批次失败。
- [ ] 对网络错误和 5xx 使用最多三次指数退避；4xx 不重试并记录提供者响应码。
- [ ] 编写测试：批次边界、段 ID 映射、缓存命中、三次后失败、翻译失败时仍可读取原文。
- [ ] 运行 `pytest api/tests/test_translation.py -q`。

## Task 6: 建立后台任务状态机

**Files:** 创建 `api/app/workers/tasks.py`、更新 `api/app/db/models.py`、创建 `api/tests/test_tasks.py`。

- [ ] 将任务状态限制为 `queued`、`fetching_transcript`、`translating`、`analyzing`、`completed`、`failed`。
- [ ] Celery 任务依次执行字幕读取、数据库持久化、翻译和分析；每个状态转换写入 `analysis_jobs`。
- [ ] `translation_failed` 必须保留原文和任务失败详情；字幕读取失败不创建伪造的结果。
- [ ] 同一缓存键在执行中时，后续请求复用该任务，而非创建第二个 Worker 作业。
- [ ] 编写状态机测试，覆盖完整成功路径、字幕失败、翻译失败和重复提交。
- [ ] 运行 `pytest api/tests/test_tasks.py -q`。

## Task 7: 接入结构化分析服务

**Files:** 创建 `api/app/services/analysis.py`、`api/tests/test_analysis.py`。

- [ ] 定义 `AnalysisProvider.analyze(segments, target_language)`，输出 `one_line_summary`、`summary_points`、`chapters`、`highlights`。
- [ ] 使用 JSON Schema 约束每个章节和重点都包含 `start_ms`、`end_ms`、标题和文字说明。
- [ ] 验证所有时间范围满足 `0 <= start_ms < end_ms <= 视频时长`，无效结果最多重新请求两次，仍无效则任务失败。
- [ ] 保存模型名、模型版本和生成时间，便于后续评估。
- [ ] 编写测试，覆盖合格结构、缺字段、越界时间、重复重点的去重。
- [ ] 运行 `pytest api/tests/test_analysis.py -q`。

## Task 8: 创建 Chrome 扩展和标签页隔离

**Files:** 创建 `extension/manifest.json`、`extension/src/background.ts`、`extension/src/shared/types.ts`、`extension/tests/background.test.ts`。

- [ ] 配置 Manifest V3、`sidePanel` 权限、`tabs` 权限、仅匹配 `https://www.youtube.com/*` 与 `https://youtu.be/*` 的 host permissions。
- [ ] 在用户发起分析后调用 `chrome.sidePanel.setOptions({ tabId, enabled: true, path: "sidepanel.html" })`。
- [ ] 在 `tabs.onActivated` 中，为非分析发起标签页执行 `setOptions({ tabId, enabled: false })`；返回发起标签页时重新启用。
- [ ] 按 `tabId` 保存当前 `jobId` 和 `videoId`，标签关闭时删除该映射；后端任务不取消。
- [ ] 编写测试，覆盖 YouTube 标签启用、普通网页标签禁用、离开后隐藏、返回后恢复和标签关闭清理。
- [ ] 运行扩展测试与 `npm run typecheck`。

## Task 9: 实现 Side Panel 交互和结果页

**Files:** 创建 `extension/src/sidepanel/App.tsx`、`extension/src/sidepanel/api.ts`、`extension/src/sidepanel/store.ts`。

- [ ] 在未分析状态显示“分析此视频”、源字幕语言列表和目标语言选择器，默认目标语言为中文。
- [ ] 创建任务后每 2 秒查询状态；完成、失败或组件卸载时停止轮询。
- [ ] 根据失败码显示产品规格中的中文状态文案，不能显示未处理的服务端异常。
- [ ] 渲染概览、要点、章节、重点卡片和逐字稿。每个时间按钮生成 `https://www.youtube.com/watch?v={videoId}&t={seconds}s` 并在对应标签页打开。
- [ ] 逐字稿按段渲染原文与译文；当翻译字段为空时显示原文和“译文暂不可用”。
- [ ] 使用 Playwright 测试分析启动、处理中、完成结果、无字幕状态、切换非 YouTube 标签后面板隐藏。

## Task 10: 端到端验证和内部测试

**Files:** 创建 `api/tests/e2e/test_pipeline.py`、`docs/internal-test-cases.md`。

- [ ] 用固定的字幕服务和翻译服务测试替身运行完整流水线，验证任务状态、缓存键、时间戳、翻译和结果 JSON。
- [ ] 准备至少六条公开视频案例：英语人工字幕、英语自动字幕、中文人工字幕、日语字幕、无字幕、已不可用视频。
- [ ] 记录每条案例的字幕读取结果、翻译成功率、总耗时、失败码和人工可读性判断。
- [ ] 确认第二次分析相同视频、源语言、目标语言时复用缓存，不触发新的 LibreTranslate 请求。
- [ ] 运行 `pytest api/tests -q`、`npm test`、`npm run typecheck` 和 Playwright 测试，所有命令必须通过后才进入内部试用。

## 实施完成条件

1. 有公开可读字幕的视频能完成分析并展示带时间戳的原文、LibreTranslate 译文、摘要、章节和重点。
2. 无字幕和受限视频不会创建错误的分析结果。
3. Side Panel 只在发起分析的 YouTube 标签页显示。
4. 切换页面不取消后台任务，返回原标签页可恢复查看。
5. 相同视频与语言组合复用字幕和翻译缓存。
6. `TranslationProvider` 可以通过新增实现替换为 LLM，而不改动前端或公开 API。
