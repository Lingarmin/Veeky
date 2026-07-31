from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import (
    AgeRestricted,
    CouldNotRetrieveTranscript,
    IpBlocked,
    NoTranscriptFound,
    PoTokenRequired,
    RequestBlocked,
    TranscriptsDisabled,
    VideoUnavailable,
    VideoUnplayable,
    YouTubeRequestFailed,
    YouTubeTranscriptApiException,
)


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

class TranscriptService:
    def __init__(self, api: Any | None = None):
        self.api = api or YouTubeTranscriptApi()

    def inspect(
        self,
        video_id: str,
        preferred_languages: Sequence[str] = (),
    ) -> TranscriptInspection:
        try:
            raw_tracks = list(self.api.list(video_id))
        except YouTubeTranscriptApiException as error:
            code = _failure_code(error)
            return TranscriptInspection(
                video_id=video_id,
                tracks=[],
                failure_code=code,
                failure_detail=str(error),
            )

        tracks = [_track_info(track) for track in raw_tracks]
        if not tracks:
            return TranscriptInspection(
                video_id=video_id,
                tracks=[],
                failure_code="no_caption_track",
            )

        selected_index = _select_track_index(tracks, preferred_languages)
        selected = tracks[selected_index]
        try:
            raw_segments = raw_tracks[selected_index].fetch()
            segments = _normalize_segments(raw_segments)
        except YouTubeTranscriptApiException as error:
            code = _failure_code(error)
            return TranscriptInspection(
                video_id=video_id,
                tracks=tracks,
                selected=selected,
                failure_code=code,
                failure_detail=str(error),
            )

        if not segments:
            return TranscriptInspection(
                video_id=video_id,
                tracks=tracks,
                selected=selected,
                failure_code="empty_transcript",
            )

        return TranscriptInspection(
            video_id=video_id,
            tracks=tracks,
            selected=selected,
            segments=segments,
            available=True,
        )


def _track_info(track: Any) -> TranscriptTrackInfo:
    return TranscriptTrackInfo(
        language_code=str(track.language_code),
        language_name=str(track.language),
        is_generated=bool(track.is_generated),
        is_translatable=bool(track.is_translatable),
    )


def _select_track_index(
    tracks: Sequence[TranscriptTrackInfo], preferred_languages: Sequence[str]
) -> int:
    def find(language: str, generated: bool | None) -> int | None:
        for index, track in enumerate(tracks):
            if track.language_code == language and (
                generated is None or track.is_generated is generated
            ):
                return index
        return None

    for language in preferred_languages:
        for generated in (False, True):
            index = find(language, generated)
            if index is not None:
                return index
    for generated in (False, True):
        index = find("en", generated)
        if index is not None:
            return index
    for generated in (False, True):
        for index, track in enumerate(tracks):
            if track.is_generated is generated:
                return index
    return 0


def _normalize_segments(raw_segments: Iterable[Any]) -> list[TranscriptSegment]:
    result = []
    for sequence, segment in enumerate(raw_segments):
        text = str(segment.text).strip()
        start_ms = max(0, round(float(segment.start) * 1000))
        duration_ms = round(float(segment.duration) * 1000)
        if not text or duration_ms <= 0:
            continue
        result.append(
            TranscriptSegment(
                sequence=sequence,
                start_ms=start_ms,
                duration_ms=duration_ms,
                text=text,
            )
        )
    return result


def _failure_code(error: Exception) -> str:
    mappings = (
        (TranscriptsDisabled, "captions_disabled"),
        (NoTranscriptFound, "no_caption_track"),
        (VideoUnavailable, "video_unavailable"),
        (VideoUnplayable, "video_unavailable"),
        (AgeRestricted, "video_unavailable"),
        (RequestBlocked, "request_blocked"),
        (IpBlocked, "request_blocked"),
        (PoTokenRequired, "request_blocked"),
        (YouTubeRequestFailed, "request_blocked"),
        (CouldNotRetrieveTranscript, "request_blocked"),
    )
    for error_type, code in mappings:
        if isinstance(error, error_type):
            return code
    return "transcript_unavailable"
