from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Protocol

import httpx


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
    provider_version: str


class TranslationProviderError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int | None = None):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


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
            "source": source_language,
            "target": target_language,
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
