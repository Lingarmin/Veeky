# Veeky 官方 LLM 服务与出站安全

状态：用户已于 2026-10-26 确认本方案；仅修复上架审计第一项。

## 范围与非目标

保留 Kimi、DeepSeek，增加腾讯混元、Qwen（阿里云百炼）、GLM（智谱）国内标准 API。
移除任意 API URL 和中转站支持，不提供管理端放开地址或开发环境绕过开关。
不清理历史、任务结果或安装身份，不改数据库结构，不处理其他审计项，不提交或推送 Git。

## 官方服务目录

| provider | API base | complete path | 初始推荐模型 |
| --- | --- | --- | --- |
| kimi | https://api.moonshot.cn/v1 | /v1/chat/completions | kimi-k2.5 |
| deepseek | https://api.deepseek.com/v1 | /v1/chat/completions | deepseek-chat |
| hunyuan | https://tokenhub.tencentmaas.com/v1 | /v1/chat/completions | hy3 |
| qwen | https://dashscope.aliyuncs.com/compatible-mode/v1 | /compatible-mode/v1/chat/completions | qwen-plus |
| glm | https://open.bigmodel.cn/api/paas/v4 | /api/paas/v4/chat/completions | glm-4.7-flash |

推荐模型只是初始值，不宣称是最新模型或所有账号均有权限。用户可填写该官方平台的其他文本模型 ID。
参考官方文档：
- https://platform.moonshot.cn/docs/api/chat
- https://api-docs.deepseek.com/zh-cn/
- https://cloud.tencent.com/document/product/1729/131925 （旧版停服与 TokenHub 迁移）
- https://cloud.tencent.com/document/product/1823/132358 （官方 hy3 调用示例）
- https://cloud.tencent.com/document/product/1823/135872 （Chat Completions 字段说明）
- https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope
- https://docs.bigmodel.cn/cn/guide/develop/openai/introduction

2026-10-26 核验补充：腾讯公告原混元平台于 2026-09-30 全面停服，混元因此使用腾讯自营 TokenHub 的固定地址，而非旧版接口或第三方中转。旧版 Key 不自动迁移；需要用户从 TokenHub 获取对应 API Key。

## 地址与出站安全

服务端目录为地址信任边界。按 provider 选固定 endpoint，前端不可改变目的地址。
为兼容旧版客户端，api_url 可继续传入，但只能为对应官方 origin、base、完整 endpoint（允许尾斜杠和显式 443）。
不接受其他路径、端口、userinfo、query、fragment、IP literal、混淆域名或 provider/host 不匹配。
未知 provider 或非官方 URL 在创建任务/测试连通时返回明确中文错误，不能静默重写到官方域名并发送旧 Key。
读取已有结果和计算历史缓存标识必须保留原 endpoint 归一化行为，不把历史读取变成新调用鉴权。

每次新的出站连接先解析所有 A/AAAA 地址；任一地址不是可路由公网地址则失败关闭。
覆盖 loopback、私网、链路本地、保留、多播、IPv4-mapped IPv6 等；连接绑定已校验的 IP，保留 Host 和 TLS SNI/证书验证。
HTTPX 使用明确的 follow_redirects=False、trust_env=False，不从环境代理绕过验证。
重试不能切换 provider 或未验证目标。测试注入只能替换底层传输，不能跳过 provider/endpoint 约束。
不修改已有 video.twimg.com 下载白名单与媒体防护。

## 模型适配与错误

JSON 输出、思考参数按 provider 适配，不把 Kimi 专用字段发送给其他服务。
Qwen 非流式请求显式关闭思考；GLM 对已知支持关闭思考的模型使用其官方 thinking 参数；混元 Hy3 使用官方支持的 thinking disabled，避免连通性小请求耗尽思考预算；DeepSeek 保持已支持模型的兼容行为。
结构化输出不兼容时只允许同一官方服务内的 prompt JSON 回退，不跨服务发送数据。
测试连通执行小规模 JSON 请求，检查鉴权、模型权限与返回；UI 提示少量费用以及不保证长任务成功。
区分配置不合法、连接失败、Key/权限错误、余额不足、限流、模型不可用和无效返回；不输出 Key。

## 插件配置与迁移

服务商下拉提供五家；官方地址只读；模型可编辑；Key 按 provider 独立保存，切换不串用。
官方旧配置保留并归一化。旧中转配置保留原始存储，不作为可运行配置，显式提示重新填写官方 Key。
展示固定官方地址时必须清空运行态旧中转 Key，不能自动携带它调用官方服务。
保存前要求官方有效配置与非空 Key，用户主动保存新官方配置才替换对应服务商旧项。
测试和分析入口均不能绕过旧中转阻断；不修改历史内容、身份存储。

## 验收

1. 五 provider 的服务端和插件目录一致；Qwen/GLM 不错误追加 /v1。
2. 恶意地址（包括旧客户端直接 POST）在网络请求前拒绝；worker 不能用旧中转配置发请求。
3. DNS 私网/混合答案/重绑定及跳转不会携带凭证访问非官方或内网目标。
4. 按官方参数生成翻译/总结，失败提示准确；测试只使用假 Key 与 mock transport。
5. 配置切换和旧中转迁移测试覆盖凭证隔离，不丢历史。
6. 后端/插件单测、类型检查、构建通过；缺乏各厂商真实 Key 时明确未完成付费真实联调。

## 回滚

无数据库迁移。按本次 diff 回滚代码和构建即可；历史不受影响。
回滚到旧版本会恢复已知出站安全风险，不应直接用于公开部署。
