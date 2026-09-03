import asyncio
from collections.abc import Sequence
from urllib.parse import parse_qs, urlparse

from app.services.transcripts import TranscriptInspection, TranscriptService
from app.services.video_metadata import VideoMetadataService
from app.sources.base import ContentRef, SourceInspection, SourceVideoTooLong


def parse_youtube_url(url: str) -> ContentRef | None:
    try:
        parsed = urlparse(url)
    except ValueError:
        return None

    host = (parsed.hostname or "").lower()
    video_id = ""
    if host in {"youtu.be", "www.youtu.be"}:
        video_id = parsed.path.strip("/").split("/")[0]
    elif host == "youtube.com" or host.endswith(".youtube.com"):
        if parsed.path == "/watch":
            video_id = parse_qs(parsed.query).get("v", [""])[0]
        elif parsed.path.startswith("/shorts/"):
            video_id = parsed.path.split("/")[2]

    if parsed.scheme not in {"http", "https"} or not _is_video_id(video_id):
        return None
    return ContentRef(platform="youtube", source_content_id=video_id)


def _is_video_id(video_id: str) -> bool:
    return len(video_id) == 11 and all(
        character.isalnum() or character in "-_" for character in video_id
    )


class YouTubeAdapter:
    platform = "youtube"

    def __init__(
        self,
        transcript_service: TranscriptService,
        metadata_service: VideoMetadataService,
        *,
        max_duration_seconds: int,
    ) -> None:
        self.transcript_service = transcript_service
        self.metadata_service = metadata_service
        self.max_duration_ms = max_duration_seconds * 1000

    def parse_url(
        self, url: str, active_media_index: int | None = None
    ) -> ContentRef | None:
        return parse_youtube_url(url)

    async def inspect(
        self, ref: ContentRef, preferred_languages: Sequence[str]
    ) -> SourceInspection:
        duration_ms = await asyncio.to_thread(
            self.metadata_service.duration_ms, ref.source_content_id
        )
        if duration_ms > self.max_duration_ms:
            raise SourceVideoTooLong

        transcript = await self.acquire_transcript(ref, preferred_languages)
        return SourceInspection(
            ref=ref,
            duration_ms=duration_ms,
            source_status="ready" if transcript.available else "unavailable",
            transcript_source="youtube_caption",
            tracks=transcript.tracks,
            selected_language=(
                transcript.selected.language_code if transcript.selected else None
            ),
            failure_code=transcript.failure_code,
            failure_detail=transcript.failure_detail,
            transcript=transcript,
        )

    async def acquire_transcript(
        self, ref: ContentRef, preferred_languages: Sequence[str]
    ) -> TranscriptInspection:
        return await asyncio.to_thread(
            self.transcript_service.inspect,
            ref.source_content_id,
            preferred_languages,
        )
