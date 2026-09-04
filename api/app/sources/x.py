import re
from collections.abc import Sequence
from urllib.parse import urlparse

from app.services.media_security import validate_x_media_url
from app.sources.base import (
    ContentRef,
    SourceInspection,
    TranscriptInspection,
    TranscriptTrackInfo,
)


_STATUS_PATH = re.compile(
    r"^/[^/]+/status/(?P<status_id>[0-9]+)(?:/video/(?P<media_index>[0-9]+))?/?$"
)


def parse_x_url(url: str, active_media_index: int | None = None) -> ContentRef | None:
    try:
        parsed = urlparse(url)
    except ValueError:
        return None

    if parsed.scheme not in {"http", "https"}:
        return None
    if (parsed.hostname or "").lower() not in {"x.com", "www.x.com"}:
        return None

    match = _STATUS_PATH.fullmatch(parsed.path)
    if match is None:
        return None

    route_media_index = match.group("media_index")
    try:
        media_index = (
            int(route_media_index) if route_media_index else active_media_index
        )
    except ValueError:
        return None
    if (
        not isinstance(media_index, int)
        or isinstance(media_index, bool)
        or media_index <= 0
    ):
        return None

    return ContentRef(
        platform="x",
        source_content_id=match.group("status_id"),
        media_index=media_index,
    )


class XAdapter:
    platform = "x"

    def parse_url(self, url: str, active_media_index: int | None = None):
        return parse_x_url(url, active_media_index)

    async def inspect(self, ref: ContentRef, preferred_languages: Sequence[str]):
        return self._inspection(ref, source_status="media_required")

    async def inspect_media(self, ref: ContentRef, media_candidates):
        ready = False
        for candidate in media_candidates:
            try:
                await validate_x_media_url(candidate.url)
            except ValueError:
                continue
            ready = True
            break
        return self._inspection(
            ref, source_status="ready" if ready else "media_required"
        )

    async def acquire_transcript(self, ref, preferred_languages):
        return self._inspection(ref, source_status="media_required").transcript

    @staticmethod
    def _inspection(ref: ContentRef, *, source_status: str) -> SourceInspection:
        selected = TranscriptTrackInfo("auto", "Automatic", True, False)
        transcript = TranscriptInspection(
            video_id=ref.stable_key,
            tracks=[],
            selected=selected,
            available=False,
            failure_code="media_required",
        )
        return SourceInspection(
            ref=ref,
            duration_ms=0,
            source_status=source_status,
            transcript_source="faster_whisper",
            tracks=[],
            selected_language="auto",
            transcript=transcript,
        )
