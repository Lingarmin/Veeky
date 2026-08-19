# Veeky YouTube 视频内容解析

Veeky是一款chrome插件，启用后常驻Chrome Side Panel，扩展会读取 YouTube 的公开字幕，用 LibreTranslate 生成译文，再通过LLM服务生成概览、章节和重点片段。
任务由 FastAPI 和 Celery 在后台执行，切换标签页不会中断处理。面板只在发起分析的 YouTube 视频标签页启用。

当前版本不下载视频，不执行语音识别，也不生成关键帧。目前不支持无字幕视频的翻译和LLM总结。

已支持功能：
1.支持识别YouTube视频链接，检查视频字幕并进行分析；
2.按时间顺序展示字幕，支持点击时间戳视频自动跳转（暂不支持和视频音轨自动播放）；
3.支持视频概览总结、章节重点、精华片段解析，可点击时间戳视频直接跳转到对应部分；
4.已分析过的视频会保存在本地，并在历史记录中可回溯，只要不清缓存会一直在；
5.支持配置LLM模型，使用LLM服务需要用户自己提供API KEY，目前支持kimi和deepseek两家，其他模型供应商暂未集成。

功能截图：
<img width="1413" height="750" alt="概览" src="https://github.com/user-attachments/assets/60d8e336-b3b1-4783-abb4-f4534a791bf0" />
<img width="1426" height="748" alt="重点片段" src="https://github.com/user-attachments/assets/053720d2-9281-40f6-be15-571cdb76f3b6" />
<img width="1430" height="749" alt="字幕翻译" src="https://github.com/user-attachments/assets/b508beea-324f-4bca-97ed-a9a9fe9bbf31" />
<img width="1418" height="749" alt="历史记录" src="https://github.com/user-attachments/assets/d82ffbc2-0a93-474e-9469-794be85bc447" />

本项目是vibe coding而来，已要求AI进行用户数据隔离和安全防护，但本人非技术出生，若仍有漏洞望理解，欢迎PR和二开。
另外此项目下载后非开箱即用，需依赖本地docker服务。

## 目录

```text
extension/  Chrome Manifest V3 扩展
api/        FastAPI、Celery、数据库模型和测试
docs/       内部测试记录
outputs/    已确认的产品方案、实施计划和演示稿
```

## 本地启动

需要 pnpm 和 Docker。后端容器使用 Python 3.11。

首次启动前创建本地环境文件，并生成用于临时凭据加密的 32 字节密钥：

```bash
cp api/.env.example api/.env
openssl rand -base64 32
```

把命令输出写入 `api/.env` 的 `LLM_CREDENTIAL_ENCRYPTION_KEY`。这个值只属于当前部署，不能提交到 Git；API 和 Worker 必须使用同一个值。密钥丢失后，尚未结束的任务无法解密，用户需要在插件里重新提交分析。

使用 Docker 启动完整本地服务栈。API 和 Celery Worker 由 Compose 负责守护，意外退出后会自动重启：

```bash
docker compose up -d --build
```

确认所有服务均已就绪：

```bash
docker compose ps
curl http://127.0.0.1:8000/health
```

当 `api` 和 `worker` 均显示 `healthy`，插件才能创建分析任务。`scheduler` 负责清理过期的临时 LLM 凭据，Redis 同时负责请求限流和任务创建锁。如果本机需要通过 `127.0.0.1:7890` 代理访问 YouTube，保持 `api/.env` 中的 `YOUTUBE_TRANSCRIPT_PROXY_URL=http://127.0.0.1:7890` 即可；容器内会自动使用 `host.docker.internal` 访问它。

构建扩展：

```bash
cd extension
pnpm install
pnpm build
```

打开 `chrome://extensions`，启用开发者模式，选择 `加载已解压的扩展程序`，目录使用 `extension/dist`。每次重新构建后，在扩展详情页点击刷新，并重新打开侧边栏。本地 `ENVIRONMENT=development` 会接受合法的 Chrome 扩展来源，便于内部测试。需要收紧访问范围时，将 `api/.env` 中的 `ALLOWED_CHROME_EXTENSION_ORIGINS` 改为对应的 `chrome-extension://<扩展ID>`，然后重启 API。

在 YouTube 视频页点击扩展图标即可打开面板。先选择当前视频或粘贴另一个 YouTube 链接，点击“检查字幕”确认可读字幕后再开始分析。输入其他链接并开始分析时，当前 YouTube 标签页会切换到该视频。API 地址默认为 `http://127.0.0.1:8000`。

如果浏览器通过本地代理访问 YouTube，API 和 Worker 也需要使用同一代理。将 `YOUTUBE_TRANSCRIPT_PROXY_URL` 写入 `api/.env`，例如 `http://127.0.0.1:7890`，然后执行 `docker compose up -d --build`。未配置时服务会直接连接 YouTube。

## 分析服务契约

插件会在侧边栏的“LLM 设置”中保存 Kimi 或 DeepSeek 的 API URL、API Key 和模型。点击“测试连通”确认配置后，才能开始翻译和生成概览。API Key 保存在当前扩展安装的 `chrome.storage.local` 中。开始分析时，插件将它提交给本地 API，API 使用 AES-GCM 加密后暂存到任务记录，并用任务 ID 绑定密文。Worker 完成或终止任务后立即清除密文和到期时间，定时清理任务每 10 分钟删除遗漏的过期密文。数据库不会在 `llm_config` 中保存明文 Key。

每个分析任务会长期保留 Provider、API URL 和模型，便于读取历史结果；API Key 只在任务需要期间以密文存在。Kimi 默认模型为 `kimi-k2.5`，DeepSeek 默认模型为 `deepseek-chat`。Kimi 默认地址是 `https://api.moonshot.cn/v1`，DeepSeek 默认地址是 `https://api.deepseek.com/v1`。系统会自动补全 `/chat/completions`，也可以直接填写完整接口地址。任务凭据过期时，插件会使用本地保存的 Key 重新提交任务，用户无需再次输入。

## 身份隔离和使用限制

扩展首次运行时会生成随机安装 UUID 和 256 位 token。服务端只保存 token 的 SHA-256 哈希，所有历史记录、缓存和任务查询都绑定到该安装身份。卸载扩展、清除扩展数据或更换设备后会生成新身份，旧历史不会自动恢复。

默认限制如下：

- 写请求每个安装实例每分钟 20 次，读请求每分钟 120 次。
- 同一安装实例最多有 1 个活动分析任务。
- 视频最长 4 小时，恰好 4 小时允许，超过后提示“此视频时长过长，无法分析。”。
- Redis 不可用时，受限接口返回 `quota_service_unavailable`，不会绕过限流。

视频时长由 `yt-dlp` 的元数据查询获得，不会下载音视频。元数据读取失败时不会用字幕末尾时间代替。

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
