# Veeky 视频内容解析

Veeky 是一款 Chrome Side Panel 插件。当前开发版本采用纯浏览器架构：读取 YouTube 可访问的字幕，直接调用用户选择的官方 LLM，生成译文、概览、章节和重点片段，结果保存在本机。
正常使用无需 Veeky 域名、服务器或 Docker。用户需要自己的官方 LLM API Key，调用费用由该服务商账户承担。

YouTube 分析不会下载视频。X 本机识别使用 Transformers.js + ONNX Runtime Web、CPU Whisper small q8，目前默认关闭，需在设置中手动启用实验功能。真实模型下载、完整识别和 CPU 性能尚未通过验收，不能承诺实时速度或所有 X 视频可用。当前版本不生成关键帧。

已支持功能：
1.支持识别YouTube视频链接，检查视频字幕并进行分析；
2.按时间顺序展示字幕，支持点击时间戳视频自动跳转（暂不支持和视频音轨自动播放）；
3.支持视频概览总结、章节重点、精华片段解析，可点击时间戳视频直接跳转到对应部分；
4.已完成结果保存在当前浏览器配置的 IndexedDB；重新分析新增记录。卸载插件或清理浏览器数据可能丢失历史，不会自动同步；
5.支持 Kimi、DeepSeek、腾讯混元、通义千问和智谱 GLM 的官方 API，用户需提供对应服务商的官方 API Key；不支持第三方中转或自定义地址。
6.X 实验功能尝试识别当前用户可播放的公开视频，并在识别、翻译完成后同步显示中文字幕。

## 安装当前独立版

开发环境需要 Node.js 和 pnpm；使用插件不需要安装开发环境。

```bash
pnpm --dir extension install --frozen-lockfile
pnpm --dir extension build
# 独立发布目录，不需要 VEEKY_API_ORIGIN
pnpm --dir extension build:release
```

在 `chrome://extensions` 启用开发者模式，加载 `extension/dist`（开发）或 `extension/dist-release`（发布候选）。在插件设置中选择官方服务商、填写 Key、测试并保存，然后检查 YouTube 视频字幕并开始分析。升级已有插件时请在原扩展上重新加载，避免卸载导致本地数据丢失。

Key 默认只保存到浏览器会话；勾选“记住在此设备”才持久保存，不使用 Chrome 同步。历史记录不包含 Key。每次只运行一个分析任务，最长 4 小时；关闭侧边栏不主动取消任务，浏览器关闭或运行环境终止后需手动继续，完成的分段保留。

旧历史不会自动删除，也不会自动联网迁移。在历史页勾选导入说明，点击“导入旧历史记录”，临时允许访问原本地服务。导入只读取原安装身份所属的已完成记录，重复导入不会重复新增；结束后移除临时访问权限。

架构、隐私、限制与验收说明见 [独立插件方案](docs/standalone-extension.md) 和 [隐私说明](docs/privacy.md)。下方旧后端说明仅供历史版本维护与迁移参考。

功能截图：
<img width="1413" height="750" alt="概览" src="https://github.com/user-attachments/assets/60d8e336-b3b1-4783-abb4-f4534a791bf0" />
<img width="1426" height="748" alt="重点片段" src="https://github.com/user-attachments/assets/053720d2-9281-40f6-be15-571cdb76f3b6" />
<img width="1430" height="749" alt="字幕翻译" src="https://github.com/user-attachments/assets/b508beea-324f-4bca-97ed-a9a9fe9bbf31" />
<img width="1418" height="749" alt="历史记录" src="https://github.com/user-attachments/assets/d82ffbc2-0a93-474e-9469-794be85bc447" />

本项目是vibe coding而来，已要求AI进行用户数据隔离和安全防护，但本人非技术出生，若仍有漏洞望理解，欢迎PR和二开。
当前独立插件不依赖本地 Docker；旧后端代码保留用于兼容和历史迁移。

<details>
<summary>旧版后端开发与维护说明（不适用于当前独立插件安装）</summary>

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

X 语音识别使用以下默认配置。`api/.env.example` 已包含这些值：

```dotenv
ASR_MODEL_SIZE=small
ASR_DEVICE=cpu
ASR_COMPUTE_TYPE=int8
ASR_MODEL_DIR=/models/whisper
MEDIA_TEMP_ROOT=/var/lib/veeky/media
MAX_MEDIA_BYTES=4294967296
MAX_TEMP_BYTES_PER_JOB=6442450944
MEDIA_CHUNK_BYTES=8388608
```

首次处理 X 视频时，Worker 会把 Whisper small 模型下载到 `whisper_models` volume，之后重复使用。CPU 识别时间取决于视频长度和机器性能，长视频可能需要等待较久。请给 Docker 留出足够的磁盘空间和内存。

Worker 的媒体处理依赖 Linux/POSIX 运行环境，正式部署必须使用本项目的 Docker Linux 容器。ffmpeg 输出同时受 `-fs` 和 POSIX `RLIMIT_FSIZE` 限制，以确保单任务临时文件不突破配置的硬上限。直接在非 POSIX 系统运行 Worker 不保证这层硬文件限制，不能作为正式部署方式。

服务同时按安装实例、来源 IP 和全局执行资源准入限制，防止重复注册身份扩张资源用量。最长视频仍为 4 小时。每日额度按滚动 24 小时计算；默认同一 IP 最多 20 次分析、2 个未结束任务，全局最多 200 次分析、8 个未结束任务。X 语音识别每次按 4 小时预留额度，默认同一 IP/安装实例每天可受理 2 次，短视频也占一次完整预留；历史查看和已完成缓存命中不扣分析额度。配置、代理地址信任、容量计算与迁移说明见 [资源准入与防滥用](docs/resource-admission.md)。

构建扩展：

```bash
cd extension
pnpm install
pnpm build
```

打开 `chrome://extensions`，启用开发者模式，选择 `加载已解压的扩展程序`，目录使用 `extension/dist`。安装时 Chrome 会显示新增的 X 和媒体访问权限，包括 `x.com`、`video.twimg.com`、`webRequest` 和 `offscreen`。这些权限用于识别当前 X 播放器、捕获媒体地址，以及在需要时上传媒体字节。每次重新构建后，在扩展详情页点击刷新，并重新打开侧边栏。本地 `ENVIRONMENT=development` 会接受合法的 Chrome 扩展来源，便于内部测试。需要收紧访问范围时，将 `api/.env` 中的 `ALLOWED_CHROME_EXTENSION_ORIGINS` 改为对应的 `chrome-extension://<扩展ID>`，然后重启 API。

在 YouTube 视频页点击扩展图标即可打开面板。先选择当前视频或粘贴另一个 YouTube 链接，点击“检查字幕”确认可读字幕后再开始分析。输入其他链接并开始分析时，当前 YouTube 标签页会切换到该视频。API 地址默认为 `http://127.0.0.1:8000`。

在 X 视频页使用扩展前，请先登录 X 并播放目标视频 1 至 2 秒，让扩展识别当前播放器和媒体资源，然后点击检查并开始分析。如果 Worker 无法匿名下载媒体，扩展会在浏览器登录态下读取媒体并分片上传。扩展不会把 X Cookie、认证请求头或访问令牌上传给 API。

服务端只把 X 媒体保存在 `MEDIA_TEMP_ROOT` 管理的目录中。任务成功、失败或取消后会删除对应的临时媒体；未完成的上传会话过期后，`scheduler` 每 15 分钟投递一次分批清理任务。如果 Worker 队列繁忙，实际执行可能延迟。逐字稿、译文和分析结果不会随临时媒体一起删除。

如果浏览器通过本地代理访问 YouTube，API 和 Worker 也需要使用同一代理。将 `YOUTUBE_TRANSCRIPT_PROXY_URL` 写入 `api/.env`，例如 `http://127.0.0.1:7890`，然后执行 `docker compose up -d --build`。未配置时服务会直接连接 YouTube。

## 分析服务契约

插件侧边栏的“LLM 设置”仅支持以下五家官方服务。API URL 为只读固定地址，模型 ID 可编辑，API Key 按服务商分别保存；切换服务商不会复用另一家的 Key。点击“保存配置”，或“测试连通”成功后，才会保存当前配置和所选服务商；单纯切换选项不会覆盖已保存的选择。无需先测试才能保存。

| 服务商 | 固定官方 API URL | 默认模型 |
|---|---|---|
| Kimi | `https://api.moonshot.cn/v1` | `kimi-k2.5` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 腾讯混元 | `https://tokenhub.tencentmaas.com/v1` | `hy3` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.7-flash` |

这些是项目配置的默认值，不代表“最新模型”，也不代表已用真实 Key 验证可用。可按自己的官方账户权限修改模型 ID；系统会在固定地址后补全 `/chat/completions`。官方文档与地址核验依据见 [设计说明](docs/superpowers/specs/2026-10-26-official-llm-providers-design.md)。

旧的中转、非官方或无法确认的配置只会在运行时隔离：界面恢复对应官方 URL、清空可用 Key 并提示重新填写，不会自动把旧 Key 发往官方服务。原始配置在明确点击保存（或测试成功自动保存）前仍留在扩展存储；不会删除或迁移历史记录。若整个 LLM 配置容器格式损坏，读取时同样不改写原数据，明确保存时只重置 LLM 配置容器及所选服务商，不影响其他设置、身份数据或历史记录。

腾讯原混元平台已于 2026-09-30 停服。混元现使用腾讯官方 TokenHub，必须填写新平台的官方 API Key，不能自动沿用旧平台 Key。迁移依据见 [腾讯停服与迁移公告](https://cloud.tencent.com/document/product/1729/131925) 和 [TokenHub 官方调用示例](https://cloud.tencent.com/document/product/1823/132358)。

API Key 保存在当前扩展安装的 `chrome.storage.local` 中。开始分析时，插件将它提交给本地 API，API 使用 AES-GCM 加密后暂存到任务记录，并用任务 ID 绑定密文。Worker 完成或终止任务后立即清除密文和到期时间，定时清理任务每 10 分钟删除遗漏的过期密文。数据库不会在 `llm_config` 中保存明文 Key。每个分析任务保留 Provider、API URL 和模型，便于读取历史结果；API Key 只在任务需要期间以密文存在。任务凭据过期时，插件可以使用仍有效的本地官方配置重新提交；被隔离的旧配置需要先重新填写官方 Key。

LLM 请求忽略 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 等环境代理，并且不跟随重定向，只连接所选服务商的固定官方端点。此限制不影响单独配置的 `YOUTUBE_TRANSCRIPT_PROXY_URL`，YouTube 字幕代理行为保持不变。

## 身份隔离和使用限制

扩展首次运行时会生成随机安装 UUID 和 256 位 token。服务端只保存 token 的 SHA-256 哈希，历史记录、任务查询和新译文缓存均绑定该安装身份。卸载扩展、清除扩展数据或更换设备后会生成新身份，旧历史不会自动恢复。服务端数据库被删除或服务不可用也会影响历史读取；这不是只存于浏览器、永不失效的本地历史。升级 `0009_translation_ownership` 前需备份数据库并暂停旧 Worker：旧共享译文只保留明确匹配的原历史关联，不能供新任务复用。详见[译文缓存隔离与历史迁移](docs/translation-cache-isolation.md)。

默认限制如下：

- 写请求每个安装实例每分钟 20 次，读请求每分钟 120 次。
- 同一安装实例最多有 1 个活动分析任务。
- 视频最长 4 小时，恰好 4 小时允许，超过后提示“此视频时长过长，无法分析。”。
- Redis 不可用时，受限接口返回 `quota_service_unavailable`，不会绕过限流。

视频时长由 `yt-dlp` 的元数据查询获得，不会下载音视频。元数据读取失败时不会用字幕末尾时间代替。

五家服务均通过兼容 OpenAI Chat Completions 协议的客户端请求 JSON。模型使用插件设置中的值，正文使用 `messages`，结构化请求使用 `response_format: {"type":"json_object"}`，思考参数按服务商适配。只有服务明确拒绝受支持的可选参数时，才会在同一官方服务内降级重试，不会切换供应商或把数据发往第三方中转。以下为分析请求示例：

“测试连通”通过本地 API 发起小规模 JSON 请求并验证返回 `{"ok":true}`，使用输出 token 上限；这不是仅检查 HTTP 状态的普通文本探测。真实测试可能产生少量费用，不会执行完整视频翻译或摘要；测试成功不保证长任务、配额、超时或复杂结构化输出一定成功。

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

正式版独立构建与服务器部署见 [生产部署说明](docs/production-deployment.md)。默认 `pnpm build` 继续生成连接本地服务的开发包；商店包必须使用真实 `VEEKY_API_ORIGIN` 和 `pnpm build:release`，输出到单独的 `extension/dist-release`。公网部署尚需实际域名、服务器和商店扩展 ID，不应直接上传开发包。

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

Playwright 每例使用新的临时配置目录，并在打开页面前阻断所有未匹配 Mock 的 HTTP(S) 请求；API、视频页面和连通测试均使用 Mock，不访问正在运行的本地 API、真实服务商或用户浏览器数据。自动化结果不替代真实 Key、真实视频和上架前的人工验收。

内部测试视频和记录字段见 [docs/internal-test-cases.md](docs/internal-test-cases.md)。

</details>
