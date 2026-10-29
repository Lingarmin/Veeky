# 旧版正式后端部署与扩展构建（归档）

2026-10-27：当前插件已改为独立浏览器架构，普通使用不再需要本文的域名、服务器或 Docker。当前构建命令为 `pnpm --dir extension build:release`，不会读取 `VEEKY_API_ORIGIN`。本文保留供旧后端维护和迁移参考；当前说明见 [独立插件方案](standalone-extension.md)。

状态：代码提供独立发布构建和单机 HTTPS 部署模板；尚未部署公网服务。需要运营方提供真实域名、服务器、商店扩展 ID，完成真实环境验收后才能供商店用户使用。不要把测试域名构建的包上传商店。

本次本地验证（2026-10-27）：后端 737 项、前端 387 项、现有浏览器回归 9 项通过，类型检查和开发/发布构建通过。另用隔离 Chromium 验证发布包的 HTTPS 历史请求和提示文案，所有 HTTP 请求均被 Mock 或阻断，未使用真实 Key/付费模型。生产 Compose 两项检查包含在后端测试中。Caddy 镜像及官方二进制下载受网络超时阻碍，尚未完成代理进程启动校验；公网 TLS、真实字幕/媒体及 LLM 验收也尚未完成。

## 本地版与正式版

| 用途 | 命令（仓库根目录） | 输出 | API |
| --- | --- | --- | --- |
| 本地开发 | `pnpm --dir extension build` | `extension/dist` | 原来的 `http://127.0.0.1:8000` |
| 商店发布 | `VEEKY_API_ORIGIN=https://你的真实API域名 pnpm --dir extension build:release` | `extension/dist-release` | 构建时指定的 HTTPS 服务 |

`VEEKY_API_ORIGIN` 只允许 HTTPS 公网 DNS origin，不允许路径、身份凭据、查询参数、非标准端口、IP、本机/保留/示例域名。校验发生在清理输出之前；不填地址则构建失败。不要给 Vite 传入用户 Key。发布包权限只增加这个确定的 API origin，移除本地后端权限；运行时不能改成其他地址，带身份令牌的请求不跟随重定向、不携带浏览器 Cookie。

现有默认构建、插件安装路径、身份和本地数据不变。发布包不要覆盖正在使用的本地 `dist`。本地数据库和线上数据库相互独立：即使浏览器安装身份相同，旧历史也不会凭空出现在新后端。若以后迁移本地数据，须单独备份和迁移数据库，并保留原安装 ID/token 哈希；本步骤不执行迁移、不清空历史。

## 服务器准备

- 单台 Linux Docker/Compose 服务器作为第一阶段部署；模板 Worker 并发为 1，CPU + faster-whisper small/int8。建议从 8 vCPU、16 GiB 内存、至少 60 GiB 可用磁盘开始评估，实际容量以压测为准。4 小时长视频不保证实时完成。
- 域名 A/AAAA 解析指向服务器。没有可达 IPv6 时不要发布 AAAA。防火墙仅允许公网 TCP 80/443；SSH 限管理来源。API 8000、PostgreSQL 5432、Redis 6379 不发布宿主机端口。
- 服务器需能连通 YouTube、X 媒体源、选定官方 LLM 服务及模型下载源。公网服务器 IP 可能被 YouTube 限流/阻断；正式验收必须包含真实公开视频。不能用健康检查代替字幕可用性验证，也不能默认服务端已登录用户 X 账号。
- Chrome 商店草稿上传后取得正式扩展 ID，加入后端白名单。不要把当前开发安装 ID 当作商店 ID。白名单是浏览器来源限制，任务权限仍由安装 token 校验，不能以 CORS 代替身份鉴权。

## 配置与首次部署

从此仓库根目录执行；**不**与本地 `docker-compose.yml` 合并：

```bash
cp deploy/.env.production.example deploy/.env.production
chmod 600 deploy/.env.production
openssl rand -hex 32
openssl rand -base64 32
```

在受控编辑器里填写 `.env.production` 的五项必填字段。两个随机值分别作为数据库密码和加密密钥，只生成一次；不要把密钥粘贴到聊天、日志或 Git。`ALLOWED_CHROME_EXTENSION_ORIGINS` 格式为包含确切 `chrome-extension://` origin 的 JSON 数组，不能用通配符。五家官方 LLM 的用户 Key 由插件提交，不写在服务器部署文件里。

```bash
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml config --quiet
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml build
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml up -d postgresql redis
# 首次下载固定 revision 模型，避免用户首个请求等待下载。
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml run --rm --no-deps worker python -c 'from app.services.asr import _create_whisper_model; _create_whisper_model(model_size_or_path="small", device="cpu", compute_type="int8", download_root="/models/whisper")'
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml up -d
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml ps
```

Caddy 为真实域名申请/续期证书；证书保存在持久卷。模板使用独立的 `veeky-production` 项目和卷，不会复用本地卷。不要运行 `down -v`。

API/Worker/Scheduler 均使用 `ENVIRONMENT=production`、相同加密密钥和来源白名单；缺失有效密钥或确切白名单时应用拒绝启动。模板只有 Caddy 的固定地址 `10.203.77.2/32` 被信任，并覆盖外来 `X-Forwarded-For`，Uvicorn 不另行信任代理头。若此子网与服务器网络冲突，需同时调整 Compose 子网、代理 IP 和应用信任地址。不要把信任地址扩成所有网段。

模板假设浏览器直连 Caddy，不包含 CDN/外部负载均衡。如果增加 CDN，要单独配置并验证真实客户端 IP 信任链，否则限流会按 CDN 出口聚合。不要直接信任客户端提供的 IP 头。

16 MB 是单次 HTTP 请求上限，不是整段视频上限；媒体按 8 MiB 分块上传。默认总视频上限和限流详见 [资源准入说明](resource-admission.md)。Redis 使用 noeviction，满额时受限请求失败关闭，不为腾空间静默丢弃配额计数。

## 发布前验收（真实域名和权限到位后）

1. HTTPS `/health` 正常，证书有效，数据库/Redis/Worker 健康。检查公网无法直连 8000/5432/6379。
2. 配置真实 HTTPS origin，构建 `dist-release`。在独立测试浏览器配置中加载，确认没有本地后端权限、没有 Docker 提示。不要卸载现有开发扩展或清除其存储。
3. 使用两个独立安装身份检查历史隔离、他人任务不可读取、IP 限流以及伪造 IP 头不能绕过配额。
4. 使用授权的测试 Key，在官方服务商完成连通测试、短 YouTube 字幕翻译/总结、X 分块上传/ASR/翻译，以及失败恢复和历史重看。真实 LLM 调用可能产生费用，应由持有者确认后执行。
5. 检查恰好 4 小时允许、超过 4 小时拒绝；完整长视频做容量测试，观察 CPU、队列、磁盘和超时。不要在未压测时扩大并发。
6. 任务终态后检查临时凭据和媒体清理；确认页面说明准确：媒体/字幕上传到 Veeky，文本发送给用户选择的官方服务商。完整隐私政策、用户删除入口、数据保留周期和依赖漏洞审计仍属后续上架整改项，本步骤不代表全部审核要求已完成。

## 运维、备份与回滚

- 发布前停接新任务、等待执行中的任务完成，使用 `pg_dump` 备份数据库；另行加密备份生产配置、数据库密码、LLM 临时凭据加密密钥。备份位置不能在 Git 仓库中，限制权限。
- 使用已测试的 Git revision 作为 `VEEKY_IMAGE_TAG`，保留前一个镜像和数据库备份。API 启动会执行迁移，因此有迁移的升级必须先确认恢复方案；不要盲目把旧镜像接入不兼容的新 schema。
- 无 schema 变化的回滚可恢复前一镜像 tag 并重建服务；需要恢复 schema 时应维护停机并使用备份还原，先评估备份后新增数据。不要用清卷代替回滚。
- 监控健康、Worker、队列积压、配额拒绝和磁盘占用；不要记录 Authorization、API Key、请求正文或字幕。模板关闭代理访问日志与 Uvicorn 访问日志，应用异常日志仍需按后续隐私审计核查。
- 数据库/Redis/模型/媒体/证书卷独立持久化。单机模板不是高可用集群；扩容需先解决共享媒体存储、任务租约与数据库/Redis容量。

技术依据：Vite `env-and-mode` 构建模式、Chrome 扩展 host permissions、Caddy `reverse_proxy`/`request_body` 和 Docker Compose 网络配置的官方文档；本地检查不替代公网 TLS、DNS、媒体和真实模型验收。
