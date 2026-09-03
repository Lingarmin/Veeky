from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol, Sequence


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


@dataclass(frozen=True)
class TranscriptSegment:
    sequence: int
    start_ms: int
    duration_ms: int
    text: str


@dataclass(frozen=True)
class TranscriptInspection:
    video_id: str
    tracks: list[TranscriptTrackInfo]
    selected: TranscriptTrackInfo | None = None
    segments: list[TranscriptSegment] = field(default_factory=list)
    available: bool = False
    failure_code: str | None = None
    failure_detail: str | None = None


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


class UnsupportedSourcePlatform(LookupError):
    pass


class SourceRegistryConfigurationError(ValueError):
    pass


class SourceVideoTooLong(ValueError):
    pass


class SourceRegistry:
    def __init__(self, adapters: list[SourceAdapter]):
        self._adapters: dict[Platform, SourceAdapter] = {}
        for adapter in adapters:
            if adapter.platform in self._adapters:
                raise SourceRegistryConfigurationError(
                    f"Duplicate source adapter for platform: {adapter.platform}"
                )
            self._adapters[adapter.platform] = adapter

    def parse(
        self, url: str, active_media_index: int | None = None
    ) -> ContentRef:
        for adapter in self._adapters.values():
            ref = adapter.parse_url(url, active_media_index=active_media_index)
            if ref is not None:
                if ref.platform != adapter.platform:
                    raise SourceRegistryConfigurationError(
                        f"Source adapter {adapter.platform} returned content "
                        f"for platform {ref.platform}"
                    )
                return ref
        raise UnsupportedSourceUrl("仅支持 YouTube 和 x.com 视频链接")

    def adapter_for(self, platform: Platform) -> SourceAdapter:
        try:
            return self._adapters[platform]
        except KeyError as error:
            raise UnsupportedSourcePlatform(
                f"No source adapter registered for platform: {platform}"
            ) from error
