from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Protocol
import json
import unicodedata

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.services.llm import LlmProviderError, OpenAICompatibleClient


ANALYSIS_CONTENT_RULES = (
    "A chapter or highlight title names the topic or viewing value briefly. "
    "Its summary adds specific actions, evidence, or conclusions and explains the content or reason to watch. "
    "The title and summary must not repeat or paraphrase the same short phrase. "
    "Highlight excerpts must quote the transcript instead of replacing the summary. "
)


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
    original_excerpt: str = Field(min_length=1)
    translated_excerpt: str = Field(min_length=1)


class AnalysisPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    one_line_summary: str = Field(min_length=1)
    summary_points: list[str] = Field(min_length=3, max_length=6)
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
            try:
                raw = await self.provider.analyze(segments, target_language)
            except AnalysisGenerationError as error:
                last_error = error
                continue
            try:
                payload = AnalysisPayload.model_validate(_normalize_analysis_payload(raw, duration_ms))
                _validate_timestamps(payload, duration_ms)
                _validate_distinct_descriptions(raw, payload)
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
        if isinstance(last_error, AnalysisGenerationError):
            raise AnalysisGenerationError(last_error.code, str(last_error)) from last_error
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
            "instructions": (
                "Summarize the timestamped transcript in targetLanguage. Return only "
                "JSON matching responseSchema. Keep chapters chronological, use 3 to 6 "
                "summary points, and ground every chapter and highlight in the transcript. "
                f"{ANALYSIS_CONTENT_RULES}"
            ),
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


class LlmAnalysisProvider:
    def __init__(self, client: OpenAICompatibleClient, *, max_input_chars: int = 50000):
        self.client = client
        self.name = client.provider
        self.version = client.model
        if max_input_chars <= 0:
            raise ValueError("max_input_chars must be positive")
        self.max_input_chars = max_input_chars

    async def analyze(
        self, segments: Sequence[AnalysisSegment], target_language: str
    ) -> Mapping[str, Any]:
        chunks = _build_analysis_chunks(segments, target_language, self.max_input_chars)
        if len(chunks) > 1:
            return await self._analyze_chunks(chunks, target_language)
        return await self._analyze_request(chunks[0], target_language)

    async def _analyze_request(
        self, segments: Sequence[AnalysisSegment], target_language: str
    ) -> Mapping[str, Any]:
        messages = [
            {
                "role": "system",
                "content": (
                "Summarize the timestamped transcript in the target language. "
                "Return only JSON with one_line_summary, summary_points, chapters, and highlights. "
                "Use 3 to 6 summary points. Use start_ms and end_ms for every chapter and highlight; "
                "timestamps are integer milliseconds, and every highlight must include both boundaries. "
                "Keep all chapter and highlight timestamps within the transcript. "
                f"{ANALYSIS_CONTENT_RULES}"
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "target_language": target_language,
                        "segments": [asdict(segment) for segment in segments],
                    },
                    ensure_ascii=False,
                ),
            },
        ]
        try:
            return await self.client.complete_json(messages)
        except LlmProviderError as error:
            raise AnalysisGenerationError(error.code, str(error)) from error

    async def _analyze_chunks(
        self,
        chunks: Sequence[Sequence[AnalysisSegment]],
        target_language: str,
    ) -> Mapping[str, Any]:
        """Analyze bounded transcript windows and merge their timestamped results.

        Keeping each request bounded avoids context-limit rejections on long videos.
        The merge is deterministic so a second, potentially large synthesis request
        is not needed and every returned timestamp remains tied to the source video.
        """
        responses = [
            await self._analyze_request(chunk, target_language) for chunk in chunks
        ]
        duration_ms = max(
            (segment.start_ms + segment.duration_ms for chunk in chunks for segment in chunk),
            default=1,
        )
        payloads: list[AnalysisPayload] = []
        for response in responses:
            try:
                normalized = _normalize_analysis_payload(response, duration_ms)
                payload = AnalysisPayload.model_validate(normalized)
                _validate_timestamps(payload, duration_ms)
                _validate_distinct_descriptions(response, payload)
            except (ValidationError, ValueError) as error:
                raise AnalysisGenerationError(
                    "analysis_invalid_response",
                    f"Analysis provider returned an invalid chunk: {error}",
                ) from error
            payloads.append(payload)

        summary_points: list[str] = []
        chapters: list[dict[str, Any]] = []
        highlights: list[dict[str, Any]] = []
        one_line_summaries: list[str] = []
        for payload in payloads:
            if payload.one_line_summary not in one_line_summaries:
                one_line_summaries.append(payload.one_line_summary)
            for point in payload.summary_points:
                if point not in summary_points:
                    summary_points.append(point)
            chapters.extend(chapter.model_dump() for chapter in payload.chapters)
            highlights.extend(highlight.model_dump() for highlight in payload.highlights)

        for chapter in chapters:
            if len(summary_points) >= 6:
                break
            if chapter["summary"] not in summary_points:
                summary_points.append(chapter["summary"])
        while len(summary_points) < 3:
            summary_points.append(f"视频分段 {len(summary_points) + 1}")

        return {
            "one_line_summary": "；".join(one_line_summaries),
            "summary_points": summary_points[:6],
            "chapters": chapters,
            "highlights": highlights,
        }


class KimiAnalysisProvider(LlmAnalysisProvider):
    """Compatibility wrapper for callers that still construct the Kimi provider."""

    def __init__(self, client, **kwargs):
        if not hasattr(client, "provider"):
            client.provider = "kimi"
        if not hasattr(client, "model"):
            client.model = "kimi-k2.5"
        super().__init__(client, **kwargs)


def _validate_timestamps(payload: AnalysisPayload, duration_ms: int) -> None:
    for item in [*payload.chapters, *payload.highlights]:
        if not 0 <= item.start_ms < item.end_ms <= duration_ms:
            raise ValueError(
                f"Timestamp {item.start_ms}:{item.end_ms} falls outside {duration_ms}"
            )


def _comparison_key(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return "".join(character for character in normalized if character.isalnum())


def _validate_distinct_descriptions(
    raw: Mapping[str, Any], payload: AnalysisPayload
) -> None:
    for field_name in ("chapters", "highlights"):
        raw_items = raw.get(field_name, [])
        parsed_items = getattr(payload, field_name)
        if not isinstance(raw_items, Sequence) or isinstance(raw_items, (str, bytes)):
            continue
        for raw_item, parsed_item in zip(raw_items, parsed_items, strict=False):
            if not isinstance(raw_item, Mapping):
                continue
            if "title" not in raw_item or "summary" not in raw_item:
                continue
            if _comparison_key(parsed_item.title) == _comparison_key(parsed_item.summary):
                raise ValueError(f"{field_name} title and summary must be different")


def _normalize_analysis_payload(raw: Mapping[str, Any], duration_ms: int) -> Mapping[str, Any]:
    """Normalize common OpenAI-compatible model aliases before strict validation."""
    if not isinstance(raw, Mapping):
        return raw
    normalized = dict(raw)
    chapters = []
    for item in normalized.get("chapters", []):
        if not isinstance(item, Mapping):
            chapters.append(item)
            continue
        chapter = dict(item)
        # DeepSeek commonly returns chapter boundaries as `start`/`end` in
        # seconds even though our storage and API contract use milliseconds.
        # Convert the aliases before strict validation and remove them so the
        # Pydantic model does not reject otherwise usable results as extras.
        if "start_ms" not in chapter and "start" in chapter:
            try:
                chapter["start_ms"] = _parse_seconds_alias_ms(chapter["start"])
            except (TypeError, ValueError):
                pass
        if "end_ms" not in chapter and "end" in chapter:
            try:
                chapter["end_ms"] = _parse_seconds_alias_ms(chapter["end"])
            except (TypeError, ValueError):
                pass
        chapter.pop("start", None)
        chapter.pop("end", None)
        chapter.setdefault("summary", chapter.get("title", ""))
        chapters.append(chapter)
    normalized["chapters"] = chapters

    highlights = []
    for item in normalized.get("highlights", []):
        if not isinstance(item, Mapping):
            highlights.append(item)
            continue
        highlight = dict(item)
        if "start_ms" not in highlight and "start" in highlight:
            try:
                highlight["start_ms"] = _parse_seconds_alias_ms(highlight["start"])
            except (TypeError, ValueError):
                pass
        if "end_ms" not in highlight and "end" in highlight:
            try:
                highlight["end_ms"] = _parse_seconds_alias_ms(highlight["end"])
            except (TypeError, ValueError):
                pass
        highlight.pop("start", None)
        highlight.pop("end", None)
        timestamp = highlight.get("timestamp_ms", highlight.get("timestamp"))
        alias_style = timestamp is not None or "description" in highlight
        if timestamp is not None and "start_ms" not in highlight:
            try:
                start_ms = max(0, _parse_timestamp_ms(timestamp))
            except (TypeError, ValueError):
                start_ms = None
            if start_ms is not None:
                end_ms = min(duration_ms, start_ms + 1000)
                highlight["start_ms"] = start_ms
                highlight["end_ms"] = max(start_ms + 1, end_ms)
        if "start_ms" in highlight and "end_ms" not in highlight:
            try:
                start_ms = max(0, int(float(highlight["start_ms"])))
                highlight["start_ms"] = start_ms
                highlight["end_ms"] = min(duration_ms, start_ms + 1000)
                highlight["end_ms"] = max(start_ms + 1, highlight["end_ms"])
            except (TypeError, ValueError):
                pass
        description = highlight.get("description")
        text = highlight.get("text")
        quote = highlight.get("quote")
        excerpt_alias = text or quote
        if excerpt_alias and "summary" not in highlight:
            highlight["summary"] = str(excerpt_alias)
        if excerpt_alias and "title" not in highlight:
            highlight["title"] = str(excerpt_alias)[:160]
        if description and "summary" not in highlight:
            highlight["summary"] = description
        if description and "title" not in highlight:
            highlight["title"] = str(description)[:160]
        if excerpt_alias is not None or alias_style:
            excerpt = str(excerpt_alias or description or highlight.get("title", ""))
            highlight.setdefault("original_excerpt", excerpt)
            highlight.setdefault("translated_excerpt", str(description or excerpt_alias or highlight.get("summary", "")))
        highlight.pop("description", None)
        highlight.pop("text", None)
        highlight.pop("quote", None)
        highlight.pop("timestamp_ms", None)
        highlight.pop("timestamp", None)
        highlights.append(highlight)
    normalized["highlights"] = highlights
    return normalized


def _parse_timestamp_ms(value: Any) -> int:
    """Parse numeric millisecond aliases and common M:SS clock strings."""
    if isinstance(value, str):
        text = value.strip()
        if ":" in text:
            parts = text.split(":")
            if not 2 <= len(parts) <= 3:
                raise ValueError("invalid clock timestamp")
            seconds = 0.0
            for part in parts:
                seconds = seconds * 60 + float(part)
            return round(seconds * 1000)
        return round(float(text))
    return round(float(value))


def _parse_seconds_alias_ms(value: Any) -> int:
    if isinstance(value, str) and ":" in value:
        return _parse_timestamp_ms(value)
    return round(float(value) * 1000)


def _build_analysis_chunks(
    segments: Sequence[AnalysisSegment], target_language: str, max_input_chars: int
) -> list[list[AnalysisSegment]]:
    if not segments:
        return [[]]

    chunks: list[list[AnalysisSegment]] = []
    current: list[AnalysisSegment] = []

    def request_size(items: Sequence[AnalysisSegment]) -> int:
        return len(
            json.dumps(
                {
                    "target_language": target_language,
                    "segments": [asdict(segment) for segment in items],
                },
                ensure_ascii=False,
            )
        )

    for segment in segments:
        candidate = [*current, segment]
        if current and request_size(candidate) > max_input_chars:
            chunks.append(current)
            current = [segment]
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks


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
