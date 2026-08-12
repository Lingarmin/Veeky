from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from urllib.parse import urlparse

import httpx


KIMI_MODEL = "kimi-k2.5"
DEEPSEEK_MODEL = "deepseek-chat"
DEEPSEEK_CANONICAL_MODELS = {
    "deepseek-chat",
    "deepseek-reasoner",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
}

LLM_PROVIDER_DEFAULTS = {
    "kimi": {"model": KIMI_MODEL, "label": "Kimi"},
    "deepseek": {"model": DEEPSEEK_MODEL, "label": "DeepSeek"},
}


class LlmProviderError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int | None = None):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


# Kept as an import-compatible alias for existing callers and old jobs.
KimiProviderError = LlmProviderError


@dataclass(frozen=True)
class LlmProviderConfig:
    provider: str
    api_url: str
    api_key: str
    model: str


def default_model_for_provider(provider: str) -> str:
    try:
        return str(LLM_PROVIDER_DEFAULTS[provider]["model"])
    except KeyError as error:
        raise ValueError("Unsupported LLM provider") from error


def normalize_provider_config(
    provider: str | None,
    api_url: str,
    api_key: str,
    model: str | None = None,
) -> LlmProviderConfig:
    normalized_provider = (provider or "kimi").strip().lower()
    if normalized_provider not in LLM_PROVIDER_DEFAULTS:
        raise ValueError("Unsupported LLM provider")
    normalized_model = (model or "").strip() or default_model_for_provider(normalized_provider)
    if (
        normalized_provider == "deepseek"
        and normalized_model.casefold() in DEEPSEEK_CANONICAL_MODELS
    ):
        normalized_model = normalized_model.casefold()
    return LlmProviderConfig(
        provider=normalized_provider,
        api_url=api_url,
        api_key=api_key,
        model=normalized_model,
    )


def normalize_chat_completions_url(url: str) -> str:
    normalized = url.strip().rstrip("/")
    if not normalized:
        raise ValueError("API URL is required")
    parsed = urlparse(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("API URL must be an HTTP or HTTPS URL")
    if normalized.endswith("/chat/completions"):
        return normalized
    if normalized.endswith("/v1"):
        return f"{normalized}/chat/completions"
    return f"{normalized}/v1/chat/completions"


class OpenAICompatibleClient:
    def __init__(
        self,
        api_url: str,
        api_key: str,
        *,
        provider: str = "kimi",
        model: str | None = None,
        client: httpx.AsyncClient | None = None,
        timeout_seconds: float = 180,
        max_attempts: int = 3,
        retry_delay_seconds: float = 1.0,
    ):
        config = normalize_provider_config(provider, api_url, api_key, model)
        self.provider = config.provider
        self.provider_label = str(LLM_PROVIDER_DEFAULTS[self.provider]["label"])
        self.model = config.model
        self.url = normalize_chat_completions_url(api_url)
        self.api_key = api_key
        self.client = client
        self.timeout_seconds = timeout_seconds
        self.max_attempts = max(1, max_attempts)
        self.retry_delay_seconds = max(0.0, retry_delay_seconds)
        self._supports_thinking_parameter = self.provider == "kimi"

    async def complete(
        self,
        messages: Sequence[Mapping[str, str]],
        *,
        response_format: dict[str, str] | None = None,
        max_tokens: int | None = None,
        thinking: dict[str, str] | None = None,
    ) -> str:
        payload: dict[str, object] = {
            "model": self.model,
            "messages": list(messages),
        }
        if response_format is not None:
            payload["response_format"] = response_format
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        if thinking is not None and self._supports_thinking_parameter:
            payload["thinking"] = thinking
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        for attempt in range(self.max_attempts):
            try:
                if self.client is not None:
                    response = await self.client.post(
                        self.url, json=payload, headers=headers, timeout=self.timeout_seconds
                    )
                else:
                    async with httpx.AsyncClient() as client:
                        response = await client.post(
                            self.url, json=payload, headers=headers, timeout=self.timeout_seconds
                        )
            except httpx.RequestError as error:
                if attempt + 1 == self.max_attempts:
                    detail = f": {type(error).__name__}: {error}" if str(error) else ""
                    raise LlmProviderError(
                        "llm_unavailable",
                        f"无法连接 {self.provider_label} 服务{detail}",
                    ) from error
                await asyncio.sleep(self.retry_delay_seconds * (2**attempt))
                continue

            if response.status_code == 429 and _is_quota_exhausted(response):
                break
            if response.status_code == 429 or response.status_code >= 500:
                if attempt + 1 < self.max_attempts:
                    await asyncio.sleep(
                        _retry_delay_seconds(
                            response, self.retry_delay_seconds * (2**attempt)
                        )
                    )
                    continue
            break

        if response.status_code in {401, 403}:
            raise LlmProviderError("llm_authentication_failed", f"{self.provider_label} API Key 无效", response.status_code)
        if response.status_code == 429 and _is_quota_exhausted(response):
            raise LlmProviderError(
                "llm_quota_exhausted",
                f"{self.provider_label} 账户余额不足，请充值或更换 API Key/服务商",
                response.status_code,
            )
        if response.status_code == 429:
            detail = _provider_error_detail(response, self.api_key)
            message = f"{self.provider_label} 服务请求过于频繁"
            if detail:
                message = f"{message}: {detail}"
            raise LlmProviderError("llm_rate_limited", message, response.status_code)
        if response.status_code >= 500:
            detail = _provider_error_detail(response, self.api_key)
            message = f"{self.provider_label} 服务暂时不可用"
            if detail:
                message = f"{message}: {detail}"
            raise LlmProviderError("llm_unavailable", message, response.status_code)
        if response.status_code >= 400:
            detail = _provider_error_detail(response, self.api_key)
            message = f"{self.provider_label} 服务拒绝了请求"
            if detail:
                message = f"{message}: {detail}"
            raise LlmProviderError("llm_request_rejected", message, response.status_code)
        try:
            body = response.json()
            content = _extract_completion_content(body)
        except (KeyError, IndexError, TypeError, ValueError) as error:
            raise LlmProviderError("llm_invalid_response", f"{self.provider_label} 返回格式无效") from error
        if not content.strip():
            raise LlmProviderError("llm_invalid_response", f"{self.provider_label} 返回内容为空")
        return content.strip()

    async def complete_json(
        self,
        messages: Sequence[Mapping[str, str]],
    ) -> dict:
        try:
            content = await self.complete(
                messages,
                response_format={"type": "json_object"},
                thinking={"type": "disabled"},
            )
        except LlmProviderError as error:
            # Some OpenAI-compatible gateways reject response_format even though
            # they can return valid JSON when the prompt asks for it.
            if error.code != "llm_request_rejected" or error.status_code not in {400, 422}:
                raise
            content = await self.complete(messages, thinking={"type": "disabled"})
        try:
            value = _parse_json_object(content)
        except json.JSONDecodeError as error:
            raise LlmProviderError("llm_invalid_response", f"{self.provider_label} 未返回有效 JSON") from error
        if not isinstance(value, dict):
            raise LlmProviderError("llm_invalid_response", f"{self.provider_label} JSON 根节点必须是对象")
        return value

    async def test_connection(self) -> None:
        # Keep the connectivity probe compatible with gateways that only
        # implement the minimal chat-completions request shape.
        await self.complete([{"role": "user", "content": "Reply with OK."}])


class KimiClient(OpenAICompatibleClient):
    def __init__(self, api_url: str, api_key: str, **kwargs):
        super().__init__(api_url, api_key, provider="kimi", model=KIMI_MODEL, **kwargs)


class DeepSeekClient(OpenAICompatibleClient):
    def __init__(self, api_url: str, api_key: str, **kwargs):
        super().__init__(api_url, api_key, provider="deepseek", model=DEEPSEEK_MODEL, **kwargs)


def _extract_completion_content(body: object) -> str:
    if not isinstance(body, Mapping):
        raise ValueError("response body must be an object")
    choices = body.get("choices")
    if not isinstance(choices, Sequence) or isinstance(choices, (str, bytes)) or not choices:
        raise ValueError("choices must be a non-empty array")
    first = choices[0]
    if not isinstance(first, Mapping):
        raise ValueError("choice must be an object")
    message = first.get("message")
    if not isinstance(message, Mapping):
        raise ValueError("message must be an object")
    content = message.get("content")
    if isinstance(content, str):
        if content.strip():
            return content
    if isinstance(content, Sequence) and not isinstance(content, (str, bytes)):
        parts: list[str] = []
        for part in content:
            if isinstance(part, Mapping) and isinstance(part.get("text"), str):
                parts.append(part["text"])
            elif isinstance(part, str):
                parts.append(part)
        if parts and "".join(parts).strip():
            return "".join(parts)
    # Kimi may put the useful answer in `reasoning_content` when thinking is
    # enabled by a gateway. The caller disables thinking for JSON requests,
    # but accepting this field keeps compatible gateways from appearing empty.
    reasoning_content = message.get("reasoning_content")
    if isinstance(reasoning_content, str):
        return reasoning_content
    raise ValueError("message content must be text")


def _parse_json_object(content: str) -> dict:
    """Decode a JSON object despite common markdown/prose wrappers from LLMs."""
    cleaned = content.strip().lstrip("\ufeff")
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", cleaned, re.IGNORECASE)
    candidates = [fenced.group(1).strip()] if fenced else []
    candidates.append(cleaned)
    decoder = json.JSONDecoder()
    for candidate in candidates:
        try:
            value, _ = decoder.raw_decode(candidate)
        except json.JSONDecodeError:
            value = None
        if isinstance(value, dict):
            return value
        for index, character in enumerate(candidate):
            if character != "{":
                continue
            try:
                value, _ = decoder.raw_decode(candidate[index:])
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                return value
    raise json.JSONDecodeError("JSON object not found", cleaned, 0)


def _provider_error_detail(response: httpx.Response, api_key: str) -> str:
    """Return a short, secret-free explanation from an upstream error response."""
    detail: object | None = None
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, Mapping):
        error = body.get("error")
        if isinstance(error, Mapping):
            detail = error.get("message") or error.get("code")
        if detail is None:
            detail = body.get("message") or body.get("detail")
    if detail is None:
        detail = response.text.strip()
    if not isinstance(detail, str):
        detail = str(detail)
    if api_key:
        detail = detail.replace(api_key, "[redacted]")
    detail = detail.replace("\n", " ").strip()
    return detail[:240]


def _retry_delay_seconds(response: httpx.Response, fallback: float) -> float:
    value = response.headers.get("retry-after")
    if value is None:
        return fallback
    try:
        return max(0.0, float(value))
    except ValueError:
        return fallback


def _is_quota_exhausted(response: httpx.Response) -> bool:
    detail = _provider_error_detail(response, "").casefold()
    return any(
        phrase in detail
        for phrase in (
            "insufficient balance",
            "please recharge",
            "balance is insufficient",
            "余额不足",
        )
    )


def build_llm_client(config: Mapping[str, str], *, client: httpx.AsyncClient | None = None) -> OpenAICompatibleClient:
    normalized = normalize_provider_config(
        config.get("provider"),
        config["api_url"],
        config["api_key"],
        config.get("model"),
    )
    return OpenAICompatibleClient(
        normalized.api_url,
        normalized.api_key,
        provider=normalized.provider,
        model=normalized.model,
        client=client,
    )
