from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Protocol

import httpx

from app.services.llm import LlmProviderError, OpenAICompatibleClient


@dataclass(frozen=True)
class TranslationSegment:
    segment_id: str
    start_ms: int
    duration_ms: int
    text: str


@dataclass(frozen=True)
class TranslatedSegment:
    segment_id: str
    start_ms: int
    duration_ms: int
    text: str


@dataclass(frozen=True)
class TranslationCacheKey:
    track_id: str
    target_language: str
    transcript_version: str
    provider: str
    provider_version: str


class TranslationProviderError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int | None = None):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


class LlmTranslationProvider:
    def __init__(
        self,
        client: OpenAICompatibleClient,
        *,
        max_batch_chars: int = 3000,
        max_concurrency: int = 3,
    ):
        self.client = client
        self.name = client.provider
        self.version = provider_translation_version(
            getattr(client, "url", ""), provider=client.provider, version=client.model
        )
        self.max_batch_chars = max_batch_chars
        self.max_concurrency = max(1, max_concurrency)

    async def translate(
        self,
        segments: Sequence[TranslationSegment],
        source_language: str,
        target_language: str,
    ) -> list[TranslatedSegment]:
        if not segments:
            return []
        batches = _build_batches(segments, self.max_batch_chars)
        semaphore = asyncio.Semaphore(self.max_concurrency)

        async def translate_batch(
            batch: Sequence[TranslationSegment],
        ) -> list[TranslatedSegment]:
            async with semaphore:
                return await self._translate_batch(
                    batch, source_language, target_language
                )

        translated_batches = await asyncio.gather(
            *(translate_batch(batch) for batch in batches)
        )
        return [segment for batch in translated_batches for segment in batch]

    async def _translate_batch(
        self,
        batch: Sequence[TranslationSegment],
        source_language: str,
        target_language: str,
    ) -> list[TranslatedSegment]:
        messages = [
            {"role": "system", "content": "Translate each subtitle segment. Return only JSON with a translations array. Keep every segment_id exactly once. Do not explain or reason. Output the complete JSON object."},
            {"role": "user", "content": json.dumps({"source_language": source_language, "target_language": target_language, "segments": [{"segment_id": item.segment_id, "text": item.text} for item in batch]}, ensure_ascii=False)},
        ]
        try:
            body = await self.client.complete_json(messages)
        except LlmProviderError as error:
            raise TranslationProviderError(error.code.replace("llm_", "translation_"), str(error)) from error
        values = body.get("translations")
        if not isinstance(values, list):
            raise TranslationProviderError("translation_invalid_response", f"{self.name} 缺少 translations 数组")
        by_id = {
            item.get("segment_id"): _translation_text(item)
            for item in values
            if isinstance(item, dict)
        }
        expected_ids = {item.segment_id for item in batch}
        if set(by_id) == expected_ids and all(
            isinstance(by_id.get(item.segment_id), str) for item in batch
        ):
            return [
                TranslatedSegment(item.segment_id, item.start_ms, item.duration_ms, by_id[item.segment_id])
                for item in batch
            ]
        positional_texts = [
            _translation_text(item) for item in values if isinstance(item, dict)
        ]
        if len(positional_texts) == len(batch) and all(
            isinstance(text, str) and text.strip() for text in positional_texts
        ):
            return [
                TranslatedSegment(item.segment_id, item.start_ms, item.duration_ms, text)
                for item, text in zip(batch, positional_texts, strict=True)
            ]
        if len(batch) == 1:
            # Some OpenAI-compatible gateways omit the id when only one item
            # is requested. The response is still unambiguous, so preserve it
            # instead of reporting a false mismatch.
            if len(values) == 1 and isinstance(values[0], dict):
                text = _translation_text(values[0])
                if isinstance(text, str) and text.strip():
                    item = batch[0]
                    return [
                        TranslatedSegment(item.segment_id, item.start_ms, item.duration_ms, text)
                    ]
            raise TranslationProviderError(
                "translation_response_mismatch", f"{self.name} 返回的字幕段落不完整"
            )
        midpoint = len(batch) // 2
        first = await self._translate_batch(
            batch[:midpoint], source_language, target_language
        )
        second = await self._translate_batch(
            batch[midpoint:], source_language, target_language
        )
        return [*first, *second]


def _translation_text(item: dict) -> str | None:
    for key in ("text", "translation", "translated_text", "translated", "content"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


class KimiTranslationProvider(LlmTranslationProvider):
    """Compatibility wrapper for callers that still construct the Kimi provider."""

    def __init__(
        self,
        client,
        *,
        max_batch_chars: int = 3000,
        max_concurrency: int = 3,
    ):
        if not hasattr(client, "provider"):
            client.provider = "kimi"
        if not hasattr(client, "model"):
            client.model = "kimi-k2.5"
        super().__init__(
            client,
            max_batch_chars=max_batch_chars,
            max_concurrency=max_concurrency,
        )


def provider_translation_version(
    endpoint: str, *, provider: str = "kimi", version: str = "kimi-k2.5"
) -> str:
    endpoint_fingerprint = hashlib.sha256(endpoint.encode()).hexdigest()[:12] if endpoint else "test"
    return f"{provider}.{version}+url.{endpoint_fingerprint}"


def kimi_translation_version(endpoint: str, *, version: str = "kimi-k2.5") -> str:
    return provider_translation_version(endpoint, provider="kimi", version=version)


class TranslationProvider(Protocol):
    name: str
    version: str

    async def translate(
        self,
        segments: Sequence[TranslationSegment],
        source_language: str,
        target_language: str,
    ) -> list[TranslatedSegment]: ...


class TranslationCache(Protocol):
    async def get(self, key: TranslationCacheKey) -> list[TranslatedSegment] | None: ...

    async def put(
        self, key: TranslationCacheKey, value: list[TranslatedSegment]
    ) -> None: ...


class CachedTranslationService:
    def __init__(self, provider: TranslationProvider, cache: TranslationCache):
        self.provider = provider
        self.cache = cache

    async def translate(
        self,
        track_id: str,
        segments: Sequence[TranslationSegment],
        source_language: str,
        target_language: str,
        transcript_version: str,
    ) -> list[TranslatedSegment]:
        key = TranslationCacheKey(
            track_id=track_id,
            target_language=target_language,
            transcript_version=transcript_version,
            provider=self.provider.name,
            provider_version=self.provider.version,
        )
        cached = await self.cache.get(key)
        if cached is not None:
            return cached
        translated = await self.provider.translate(
            segments, source_language, target_language
        )
        await self.cache.put(key, translated)
        return translated


class LibreTranslateProvider:
    name = "libretranslate"

    def __init__(
        self,
        base_url: str,
        *,
        api_key: str | None = None,
        client=None,
        max_batch_chars: int = 3000,
        max_attempts: int = 3,
        timeout_seconds: float = 30,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        version: str = "1.6.5",
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.client = client
        self.max_batch_chars = max_batch_chars
        self.max_attempts = max_attempts
        self.timeout_seconds = timeout_seconds
        self.sleep = sleep
        self.version = version

    async def translate(
        self,
        segments: Sequence[TranslationSegment],
        source_language: str,
        target_language: str,
    ) -> list[TranslatedSegment]:
        if _libretranslate_language(source_language) == _libretranslate_language(
            target_language
        ):
            return [
                TranslatedSegment(
                    segment_id=segment.segment_id,
                    start_ms=segment.start_ms,
                    duration_ms=segment.duration_ms,
                    text=segment.text,
                )
                for segment in segments
            ]
        batches = _build_batches(segments, self.max_batch_chars)
        if self.client is not None:
            return await self._translate_batches(
                self.client, batches, source_language, target_language
            )
        async with httpx.AsyncClient() as client:
            return await self._translate_batches(
                client, batches, source_language, target_language
            )

    async def _translate_batches(
        self,
        client,
        batches: Sequence[Sequence[TranslationSegment]],
        source_language: str,
        target_language: str,
    ) -> list[TranslatedSegment]:
        translated: list[TranslatedSegment] = []
        for batch in batches:
            texts = await self._request_batch(
                client, batch, source_language, target_language
            )
            if len(texts) != len(batch):
                raise TranslationProviderError(
                    "translation_response_mismatch",
                    "LibreTranslate returned a different number of segments",
                )
            translated.extend(
                TranslatedSegment(
                    segment_id=source.segment_id,
                    start_ms=source.start_ms,
                    duration_ms=source.duration_ms,
                    text=text,
                )
                for source, text in zip(batch, texts, strict=True)
            )
        return translated

    async def _request_batch(
        self,
        client,
        batch: Sequence[TranslationSegment],
        source_language: str,
        target_language: str,
    ) -> list[str]:
        payload: dict[str, object] = {
            "q": [segment.text for segment in batch],
            "source": _libretranslate_language(source_language),
            "target": _libretranslate_language(target_language),
            "format": "text",
        }
        if self.api_key:
            payload["api_key"] = self.api_key

        for attempt in range(self.max_attempts):
            try:
                response = await client.post(
                    f"{self.base_url}/translate",
                    json=payload,
                    timeout=self.timeout_seconds,
                )
            except httpx.RequestError as error:
                if attempt == self.max_attempts - 1:
                    raise TranslationProviderError(
                        "translation_unavailable", str(error)
                    ) from error
                await self.sleep(0.25 * (2**attempt))
                continue

            if response.status_code >= 500:
                if attempt == self.max_attempts - 1:
                    raise TranslationProviderError(
                        "translation_unavailable",
                        response.text,
                        response.status_code,
                    )
                await self.sleep(0.25 * (2**attempt))
                continue
            if response.status_code >= 400:
                raise TranslationProviderError(
                    "translation_rejected", response.text, response.status_code
                )

            try:
                translated = response.json()["translatedText"]
            except (KeyError, TypeError, ValueError) as error:
                raise TranslationProviderError(
                    "translation_invalid_response", "Missing translatedText"
                ) from error
            if isinstance(translated, str):
                translated = [translated]
            if not isinstance(translated, list) or not all(
                isinstance(text, str) for text in translated
            ):
                raise TranslationProviderError(
                    "translation_invalid_response", "translatedText must be text"
                )
            return translated
        raise AssertionError("translation retry loop exhausted")


def _build_batches(
    segments: Sequence[TranslationSegment], max_chars: int
) -> list[list[TranslationSegment]]:
    if max_chars <= 0:
        raise ValueError("max_batch_chars must be positive")
    batches: list[list[TranslationSegment]] = []
    current: list[TranslationSegment] = []
    current_chars = 0
    for segment in segments:
        length = len(segment.text)
        if length > max_chars:
            raise TranslationProviderError(
                "translation_segment_too_large",
                f"Segment {segment.segment_id} exceeds the batch character limit",
            )
        if current and current_chars + length > max_chars:
            batches.append(current)
            current = []
            current_chars = 0
        current.append(segment)
        current_chars += length
    if current:
        batches.append(current)
    return batches


def _libretranslate_language(language: str) -> str:
    normalized = language.replace("_", "-").lower()
    if normalized in {"zh-hans", "zh-cn", "zh-sg"}:
        return "zh"
    if normalized in {"zh-hant", "zh-tw", "zh-hk", "zh-mo"}:
        return "zt"
    return normalized.split("-", 1)[0]
