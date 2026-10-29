"""Fixed official LLM destinations; model identifiers remain user-editable."""
from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType
from urllib.parse import urlsplit


@dataclass(frozen=True)
class LlmProvider:
    label: str
    base_url: str
    default_model: str

    @property
    def endpoint(self) -> str:
        return self.base_url + "/chat/completions"


LLM_PROVIDERS = MappingProxyType({
    "kimi": LlmProvider("Kimi", "https://api.moonshot.cn/v1", "kimi-k2.5"),
    "deepseek": LlmProvider("DeepSeek", "https://api.deepseek.com/v1", "deepseek-chat"),
    "hunyuan": LlmProvider("腾讯混元", "https://tokenhub.tencentmaas.com/v1", "hy3"),
    "qwen": LlmProvider("通义千问", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"),
    "glm": LlmProvider("智谱 GLM", "https://open.bigmodel.cn/api/paas/v4", "glm-4.7-flash"),
})

OFFICIAL_PROVIDER_MESSAGE = "请选择支持的官方 LLM 服务商（Kimi、DeepSeek、腾讯混元、通义千问或智谱 GLM），不支持第三方中转。"


def official_completion_url(provider: str, supplied_url: str) -> str:
    """Validate stored/user input, but choose the actual URL from our registry."""
    try:
        selected = LLM_PROVIDERS[provider]
    except KeyError:
        raise ValueError(OFFICIAL_PROVIDER_MESSAGE) from None
    message = "仅支持所选服务商的官方 HTTPS 地址，请使用官方 API 地址，不支持自定义地址或第三方中转。"
    if not isinstance(supplied_url, str) or any(
        character.isspace() or ord(character) < 32 or ord(character) == 127
        for character in supplied_url
    ) or any(character in supplied_url for character in ("\\", "?", "#")):
        raise ValueError(message)
    try:
        parsed = urlsplit(supplied_url)
        expected = urlsplit(selected.base_url)
        valid = (
            parsed.scheme == "https"
            and parsed.netloc.lower() in {expected.hostname, f"{expected.hostname}:443"}
            and parsed.hostname == expected.hostname
            and parsed.port in {None, 443}
            and parsed.username is None
            and parsed.password is None
            and parsed.path in {
                "", "/", expected.path, expected.path + "/",
                expected.path + "/chat/completions", expected.path + "/chat/completions/",
            }
        )
    except (TypeError, ValueError):
        valid = False
    if not valid:
        raise ValueError(message)
    return selected.endpoint
