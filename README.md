# Veeky YouTube 视频内容解析

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

需要 pnpm、Docker 和一个符合下方 JSON 契约的分析服务。后端容器使用 Python 3.11。

使用 Docker 启动完整本地服务栈。API 和 Celery Worker 由 Compose 负责守护，意外退出后会自动重启：

```bash
docker compose up -d --build
```

确认所有服务均已就绪：

```bash
docker compose ps
curl http://127.0.0.1:8000/health
```

当 `api` 和 `worker` 均显示 `healthy`，插件才能创建分析任务。如果本机需要通过 `127.0.0.1:7890` 代理访问 YouTube，保持 `api/.env` 中的 `YOUTUBE_TRANSCRIPT_PROXY_URL=http://127.0.0.1:7890` 即可；容器内会自动使用 `host.docker.internal` 访问它。

构建扩展：

```bash
cd extension
pnpm install
pnpm build
```

打开 `chrome://extensions`，启用开发者模式，选择 `加载已解压的扩展程序`，目录使用 `extension/dist`。本地 `ENVIRONMENT=development` 会接受合法的 Chrome 扩展来源，便于内部测试。需要收紧访问范围时，将 `api/.env` 中的 `ALLOWED_CHROME_EXTENSION_ORIGINS` 改为对应的 `chrome-extension://<扩展ID>`，然后重启 API。

在 YouTube 视频页点击扩展图标即可打开面板。先选择当前视频或粘贴另一个 YouTube 链接，点击“检查字幕”确认可读字幕后再开始分析。输入其他链接并开始分析时，当前 YouTube 标签页会切换到该视频。API 地址默认为 `http://127.0.0.1:8000`。

如果浏览器通过本地代理访问 YouTube，API 和 Worker 也需要使用同一代理。将 `YOUTUBE_TRANSCRIPT_PROXY_URL` 写入 `api/.env`，例如 `http://127.0.0.1:7890`，然后执行 `docker compose up -d --build`。未配置时服务会直接连接 YouTube。

## 分析服务契约

插件会在侧边栏的“LLM 设置”中保存 Kimi 或 DeepSeek 的 API URL、API Key 和模型。点击“测试连通”确认配置后，才能开始翻译和生成概览。开始分析时，配置会发送到本地 API，并随任务保存，供后台 Worker 异步执行。API Key 不会写入 Git、分析结果或普通日志。

每个分析任务会保存创建时的 LLM 配置快照，Worker 读取该快照调用对应 Provider。Kimi 默认模型为 `kimi-k2.5`，DeepSeek 默认模型为 `deepseek-chat`。Kimi 默认地址是 `https://api.moonshot.cn/v1`，DeepSeek 默认地址是 `https://api.deepseek.com/v1`。系统会自动补全 `/chat/completions`，也可以直接填写完整接口地址。MVP 会把 API Key 保存在扩展本地存储，并随任务明文写入本地 API 数据库，以支持异步任务和重试；生产环境接入前应增加数据库加密和访问控制。

Kimi 和 DeepSeek 都通过兼容 OpenAI Chat Completions 协议的客户端发送 JSON。模型使用插件设置中的值，正文使用 `messages`，结构化请求会附带 `response_format: {"type":"json_object"}`；如果服务不支持该字段，客户端会自动重试为普通 JSON 请求：

“测试连通”只发送一条最小用户消息，用于验证 API Key、模型和 Chat Completions 地址；它不会执行视频翻译或摘要。

```json
{
  "model": "deepseek-chat",
  "messages": [
    {"role": "system", "content": "Return only JSON..."},
    {"role": "user", "content": "{...timestamped transcript...}"}
  ],
  "response_format": {"type": "json_object"}
}
```

服务应返回 JSON。字幕翻译返回 `{"translations":[{"segment_id":"...","text":"..."}]}`，视频概览返回 `one_line_summary`、`summary_points`、`chapters` 和 `highlights`。章节和重点的时间范围必须落在字幕时长内，否则 Worker 最多重新请求两次，之后将任务标记为失败。

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
