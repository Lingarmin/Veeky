from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal, Protocol, Sequence

if TYPE_CHECKING:
    from app.services.transcripts import TranscriptInspection


Platform = Literal["youtube", "x"]


@dataclass(frozen=True, slots=True)
class ContentRef:
    platform: Platform
    source_content_id: str
    media_index: int = 1

    @property
    def stable_key(self) -> str:
        return f"{self.platform}:{self.source_content_id}:{self.media_index}"


@dataclass(frozen=True)
class TranscriptTrackInfo:
    language_code: str
    language_name: str
    is_generated: bool
    is_translatable: bool


@dataclass(slots=True)
class SourceInspection:
    ref: ContentRef
    duration_ms: int
    source_status: Literal[
        "ready", "play_required", "media_required", "unavailable"
    ]
    transcript_source: Literal["youtube_caption", "faster_whisper"]
    tracks: list[TranscriptTrackInfo]
    selected_language: str | None
    failure_code: str | None = None
    failure_detail: str | None = None
    transcript: TranscriptInspection | None = field(default=None, repr=False)


class SourceAdapter(Protocol):
    platform: Platform

    def parse_url(
        self, url: str, active_media_index: int | None = None
    ) -> ContentRef | None: ...

    async def inspect(
        self, ref: ContentRef, preferred_languages: Sequence[str]
    ) -> SourceInspection: ...

    async def acquire_transcript(
        self, ref: ContentRef, preferred_languages: Sequence[str]
    ) -> TranscriptInspection: ...


class UnsupportedSourceUrl(ValueError):
    pass


class SourceVideoTooLong(ValueError):
    pass


class SourceRegistry:
    def __init__(self, adapters: list[SourceAdapter]):
        self._adapters = {adapter.platform: adapter for adapter in adapters}

    def parse(
        self, url: str, active_media_index: int | None = None
    ) -> ContentRef:
        for adapter in self._adapters.values():
            ref = adapter.parse_url(url, active_media_index=active_media_index)
            if ref is not None:
                return ref
        raise UnsupportedSourceUrl("仅支持 YouTube 和 x.com 视频链接")

    def adapter_for(self, platform: Platform) -> SourceAdapter:
        try:
            return self._adapters[platform]
        except KeyError as error:
            raise LookupError(f"No source adapter registered for {platform}") from error
