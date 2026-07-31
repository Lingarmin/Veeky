from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Protocol

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError


@dataclass(frozen=True)
class AnalysisSegment:
    segment_id: str
    start_ms: int
    duration_ms: int
    original: str
    translated: str | None = None


class TimedSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    title: str = Field(min_length=1, max_length=160)
    summary: str = Field(min_length=1)


class Highlight(TimedSummary):
    original_excerpt: str = ""
    translated_excerpt: str = ""


class AnalysisPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    one_line_summary: str = Field(min_length=1)
    summary_points: list[str] = Field(min_length=1, max_length=10)
    chapters: list[TimedSummary] = Field(min_length=1)
    highlights: list[Highlight] = Field(default_factory=list)


class AnalysisResult(AnalysisPayload):
    model_name: str
    model_version: str
    generated_at: datetime


class AnalysisGenerationError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class AnalysisProvider(Protocol):
    name: str
    version: str

    async def analyze(
        self, segments: Sequence[AnalysisSegment], target_language: str
    ) -> Mapping[str, Any]: ...


class StructuredAnalysisService:
    def __init__(self, provider: AnalysisProvider, max_attempts: int = 3):
        self.provider = provider
        self.max_attempts = max_attempts

    async def analyze(
        self,
        segments: Sequence[AnalysisSegment],
        target_language: str,
        *,
        duration_ms: int,
    ) -> AnalysisResult:
        last_error: Exception | None = None
        for _ in range(self.max_attempts):
            raw = await self.provider.analyze(segments, target_language)
            try:
                payload = AnalysisPayload.model_validate(raw)
                _validate_timestamps(payload, duration_ms)
            except (ValidationError, ValueError) as error:
                last_error = error
                continue

            unique_highlights = _deduplicate_highlights(payload.highlights)
            return AnalysisResult(
                **payload.model_dump(exclude={"highlights"}),
                highlights=unique_highlights,
                model_name=self.provider.name,
                model_version=self.provider.version,
                generated_at=datetime.now(timezone.utc),
            )
        raise AnalysisGenerationError(
            "analysis_invalid_response",
            f"Analysis provider did not return a valid result: {last_error}",
        )


class HttpAnalysisProvider:
    """Adapter for an internal LLM gateway that accepts the documented JSON contract."""

    def __init__(
        self,
        url: str,
        *,
        model: str,
        api_key: str | None = None,
        client: httpx.AsyncClient | None = None,
        timeout_seconds: float = 90,
        version: str = "v1",
    ):
        self.url = url
        self.name = model
        self.version = version
        self.api_key = api_key
        self.client = client
        self.timeout_seconds = timeout_seconds

    async def analyze(
        self, segments: Sequence[AnalysisSegment], target_language: str
    ) -> Mapping[str, Any]:
        payload = {
            "model": self.name,
            "targetLanguage": target_language,
            "transcript": [asdict(segment) for segment in segments],
            "responseSchema": AnalysisPayload.model_json_schema(),
        }
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        if self.client is not None:
            return await self._request(self.client, payload, headers)
        async with httpx.AsyncClient() as client:
            return await self._request(client, payload, headers)

    async def _request(
        self, client: httpx.AsyncClient, payload: dict[str, Any], headers: dict[str, str]
    ) -> Mapping[str, Any]:
        try:
            response = await client.post(
                self.url,
                json=payload,
                headers=headers,
                timeout=self.timeout_seconds,
            )
            response.raise_for_status()
            body = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise AnalysisGenerationError("analysis_unavailable", str(error)) from error
        if not isinstance(body, dict):
            raise AnalysisGenerationError(
                "analysis_invalid_response", "Analysis response must be a JSON object"
            )
        if isinstance(body.get("output"), dict):
            return body["output"]
        return body


def _validate_timestamps(payload: AnalysisPayload, duration_ms: int) -> None:
    for item in [*payload.chapters, *payload.highlights]:
        if not 0 <= item.start_ms < item.end_ms <= duration_ms:
            raise ValueError(
                f"Timestamp {item.start_ms}:{item.end_ms} falls outside {duration_ms}"
            )


def _deduplicate_highlights(highlights: Sequence[Highlight]) -> list[Highlight]:
    seen: set[tuple[int, int, str]] = set()
    result = []
    for highlight in highlights:
        key = (highlight.start_ms, highlight.end_ms, highlight.title.casefold())
        if key in seen:
            continue
        seen.add(key)
        result.append(highlight)
    return result
