# 先看 YouTube 视频预览

Chrome Side Panel 扩展会读取 YouTube 的公开字幕，用 LibreTranslate 生成译文，再通过结构化分析服务生成概览、章节和重点片段。任务由 FastAPI 和 Celery 在后台执行，切换标签页不会中断处理。面板只在发起分析的 YouTube 视频标签页启用。

MVP 不下载视频，不执行语音识别，也不生成关键帧。真实截图和无字幕视频转录留到第二阶段。

## 目录

```text
extension/  Chrome Manifest V3 扩展
api/        FastAPI、Celery、数据库模型和测试
docs/       内部测试记录
outputs/    已确认的产品方案、实施计划和演示稿
```

## 本地启动

需要 Python 3.12、pnpm、Docker 和一个符合下方 JSON 契约的分析服务。

先启动 PostgreSQL、Redis 和 LibreTranslate：

```bash
docker compose up -d
```

安装并启动后端：

```bash
cd api
python3.12 -m venv .venv
./.venv/bin/pip install -e '.[dev]'
cp .env.example .env
./.venv/bin/alembic upgrade head
./.venv/bin/uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

另开一个终端启动 Worker：

```bash
cd api
./.venv/bin/celery -A app.workers.tasks.celery_app worker --loglevel=INFO
```

构建扩展：

```bash
cd extension
pnpm install
pnpm build
```

打开 `chrome://extensions`，启用开发者模式，选择 `加载已解压的扩展程序`，目录使用 `extension/dist`。复制 Chrome 显示的扩展 ID，将 `api/.env` 中的 `ALLOWED_CHROME_EXTENSION_ORIGINS` 改为对应的 `chrome-extension://<扩展ID>`，然后重启 API。

在 YouTube 视频页点击扩展图标即可打开面板。API 地址默认为 `http://127.0.0.1:8000`。

## 分析服务契约

Worker 会向 `ANALYSIS_PROVIDER_URL` 发送以下 JSON：

```json
{
  "model": "internal-summary-model",
  "targetLanguage": "zh-Hans",
  "instructions": "Summarize the timestamped transcript in targetLanguage...",
  "transcript": [
    {
      "segment_id": "segment-id",
      "start_ms": 0,
      "duration_ms": 1200,
      "original": "Original caption",
      "translated": "翻译字幕"
    }
  ],
  "responseSchema": {}
}
```

服务应直接返回符合 `responseSchema` 的 JSON，也可以放在 `output` 字段中。章节和重点的时间范围必须落在字幕时长内，否则 Worker 最多重新请求两次，之后将任务标记为失败。

## 验证

```bash
cd api
./.venv/bin/pytest tests -q

cd ../extension
pnpm test
pnpm typecheck
pnpm build
pnpm test:e2e

cd ..
docker compose config
```

真实 Chrome 扩展测试需要 Playwright Chromium。首次运行前执行 `pnpm exec playwright install chromium`；也可以通过 `PLAYWRIGHT_CHROMIUM_PATH` 指定兼容的 Chromium 可执行文件。官方 Chrome 137 及以上版本会忽略命令行加载扩展参数，不能用于这条自动化测试。

内部测试视频和记录字段见 [docs/internal-test-cases.md](docs/internal-test-cases.md)。
