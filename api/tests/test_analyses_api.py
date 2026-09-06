from __future__ import annotations

import asyncio
import base64
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import app.api.analyses as analyses_api

from app.api.analyses import (
    LlmConfigRequest,
    WorkerUnavailableError,
    dispatch_analysis_job,
    get_job_dispatcher,
    get_pipeline_revision,
    get_job_credential_cipher,
    get_quota_limiter,
    get_session,
    get_source_registry,
    get_transcript_service,
    get_video_metadata_service,
    _llm_snapshot,
)
import app.services.media_upload as media_upload_service
from app.core.settings import Settings, get_settings
from app.db.models import (
    AnalysisResult,
    AnalysisJob,
    Base,
    Installation,
    MediaUploadSession,
    TranscriptSegment as StoredTranscriptSegment,
    TranscriptTrack,
    Translation,
    Video,
)
from app.main import create_app
from app.services.transcripts import (
    TranscriptInspection,
    TranscriptSegment,
    TranscriptTrackInfo,
)
from app.services.translation import provider_translation_version
from app.services.job_lease import claim_job_lease
from app.security.credentials import JobCredentialCipher
from app.security.quotas import QuotaServiceUnavailable, RateLimitExceeded
from app.services.video_metadata import VideoMetadataError
from app.sources.base import SourceInspection, SourceRegistry


class FakeTranscriptService:
    def __init__(self, available=True):
        self.available = available

    def inspect(self, video_id, preferred_languages=()):
        if not self.available:
            return TranscriptInspection(
                video_id=video_id,
                tracks=[],
                available=False,
                failure_code="no_caption_track",
            )
        track = TranscriptTrackInfo("en", "English", False, True)
        return TranscriptInspection(
            video_id=video_id,
            tracks=[track],
            selected=track,
            segments=[TranscriptSegment(0, 0, 1500, "Hello world")],
            available=True,
        )


class FakeVideoMetadataService:
    def __init__(self, duration_ms=1500, error=None):
        self.duration = duration_ms
        self.error = error
        self.calls = []

    def duration_ms(self, video_id):
        self.calls.append(video_id)
        if self.error:
            raise self.error
        return self.duration


class FakeXAdapter:
    platform = "x"

    def parse_url(self, url, active_media_index=None):
        from app.sources.x import parse_x_url

        return parse_x_url(url, active_media_index=active_media_index)

    async def inspect(self, ref, preferred_languages):
        automatic = TranscriptTrackInfo("auto", "Automatic", True, False)
        transcript = TranscriptInspection(
            video_id=ref.stable_key,
            tracks=[],
            selected=automatic,
            segments=[TranscriptSegment(0, 0, 1500, "Hello from X")],
            available=True,
        )
        return SourceInspection(
            ref=ref,
            duration_ms=0,
            source_status="ready",
            transcript_source="faster_whisper",
            tracks=[],
            selected_language="auto",
            transcript=transcript,
        )


class PermissiveQuotaLimiter:
    def __init__(self):
        self.locks = {}

    async def enforce(self, subject, request_class, limit):
        return None

    @asynccontextmanager
    async def installation_create_lock(self, installation_id):
        lock = self.locks.setdefault(installation_id, asyncio.Lock())
        async with lock:
            yield


class UnlockedQuotaLimiter:
    async def enforce(self, subject, request_class, limit):
        return None

    @asynccontextmanager
    async def installation_create_lock(self, installation_id):
        yield


class FailingQuotaLimiter:
    async def enforce(self, subject, request_class, limit):
        raise QuotaServiceUnavailable("redis unavailable")


class BoundaryQuotaLimiter:
    def __init__(self):
        self.counts = {}

    async def enforce(self, subject, request_class, limit):
        key = (subject, request_class)
        self.counts[key] = self.counts.get(key, 0) + 1
        if self.counts[key] > limit:
            raise RateLimitExceeded(37)


LLM_CONFIG = {"apiUrl": "https://api.example.com/v1", "apiKey": "test-key"}
VALID_TEST_KEY = base64.b64encode(b"v" * 32).decode("ascii")
INSTALLATION_ID = "11111111-1111-4111-8111-111111111111"
INSTALLATION_TOKEN = "installation-token-with-at-least-forty-three-characters"
AUTH_HEADERS = {
    "Authorization": f"Bearer {INSTALLATION_TOKEN}",
    "X-Veeky-Installation-Id": INSTALLATION_ID,
}
OTHER_INSTALLATION_ID = "22222222-2222-4222-8222-222222222222"
OTHER_INSTALLATION_TOKEN = (
    "other-installation-token-with-at-least-forty-three-characters"
)
OTHER_AUTH_HEADERS = {
    "Authorization": f"Bearer {OTHER_INSTALLATION_TOKEN}",
    "X-Veeky-Installation-Id": OTHER_INSTALLATION_ID,
}
_KEEP_LLM_CONFIG = object()


async def _complete_job_with_translation(
    factory,
    job_id: str,
    *,
    provider: str,
    provider_version: str,
    llm_config=_KEEP_LLM_CONFIG,
    store_translation: bool = True,
) -> None:
    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        job.status = "completed"
        if llm_config is not _KEEP_LLM_CONFIG:
            job.llm_config = llm_config
        job.result = AnalysisResult(
            one_line_summary="Stored summary",
            summary_points=[],
            chapters=[],
            highlights=[],
            model_name=provider,
            model_version=provider_version,
        )
        track = TranscriptTrack(
            video_id=job.video_id,
            language_code=job.source_language,
            language_name="English",
            is_generated=False,
            is_translatable=True,
            transcript_version=job.transcript_version,
        )
        track.segments = [
            StoredTranscriptSegment(
                sequence=0,
                start_ms=0,
                duration_ms=1500,
                text="Hello world",
            )
        ]
        session.add(track)
        await session.flush()
        if store_translation:
            session.add(
                Translation(
                    track_id=track.id,
                    target_language=job.target_language,
                    provider=provider,
                    provider_version=provider_version,
                    transcript_version=job.transcript_version,
                    segments=[
                        {
                            "segment_id": track.segments[0].id,
                            "start_ms": 0,
                            "duration_ms": 1500,
                            "text": "Stored translation",
                        }
                    ],
                )
            )
        await session.commit()


def test_llm_snapshot_normalizes_cache_identity_without_storing_the_key():
    first = _llm_snapshot(
        LlmConfigRequest.model_validate(
            {
                "provider": " KIMI ",
                "apiUrl": "https://api.example.com/v1/",
                "apiKey": "first-secret",
            }
        ),
        "analysis-schema-v1|prompt-v1|pipeline-v1",
    )
    same = _llm_snapshot(
        LlmConfigRequest.model_validate(
            {
                "provider": "kimi",
                "apiUrl": "https://api.example.com/v1/chat/completions",
                "apiKey": "second-secret",
                "model": "kimi-k2.5",
            }
        ),
        "analysis-schema-v1|prompt-v1|pipeline-v1",
    )

    assert first == same
    assert first == {
        "provider": "kimi",
        "api_url": "https://api.example.com/v1/chat/completions",
        "model": "kimi-k2.5",
        "pipeline_revision": "analysis-schema-v1|prompt-v1|pipeline-v1",
    }
    assert "api_key" not in first
    assert "first-secret" not in repr(first)


@pytest.fixture
async def api_context(tmp_path):
    database_url = os.environ.get(
        "ANALYSES_TEST_DATABASE_URL",
        f"sqlite+aiosqlite:///{tmp_path / 'api.sqlite'}",
    )
    engine = create_async_engine(database_url)
    async with engine.begin() as connection:
        if "ANALYSES_TEST_DATABASE_URL" in os.environ:
            await connection.run_sync(Base.metadata.drop_all)
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    app = create_app(
        Settings(
            llm_credential_encryption_key=VALID_TEST_KEY,
            media_temp_root=str(tmp_path / "media"),
        )
    )
    dispatched = []

    async def session_dependency() -> AsyncIterator[AsyncSession]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_session] = session_dependency
    app.dependency_overrides[get_transcript_service] = lambda: FakeTranscriptService()
    app.dependency_overrides[get_video_metadata_service] = (
        lambda: FakeVideoMetadataService()
    )
    app.dependency_overrides[get_job_dispatcher] = lambda: dispatched.append
    app.dependency_overrides[get_job_credential_cipher] = lambda: JobCredentialCipher(
        VALID_TEST_KEY
    )
    quota_limiter = PermissiveQuotaLimiter()
    app.dependency_overrides[get_quota_limiter] = lambda: quota_limiter

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers=AUTH_HEADERS,
    ) as client:
        registered = await client.post(
            "/v1/installations/register",
            json={
                "installationId": INSTALLATION_ID,
                "installationToken": INSTALLATION_TOKEN,
            },
        )
        assert registered.status_code == 201
        yield client, app, factory, dispatched

    if "ANALYSES_TEST_DATABASE_URL" in os.environ:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest.mark.asyncio
async def test_inspect_rejects_unsupported_source_with_neutral_error(api_context):
    client, _, _, _ = api_context
    response = await client.post(
        "/v1/videos/inspect", json={"url": "https://example.com/watch?v=aircAruvnKk"}
    )

    assert response.status_code == 422
    assert response.json()["detail"] == {
        "code": "invalid_source_url",
        "message": "请输入有效的视频链接",
    }


@pytest.mark.asyncio
async def test_inspect_rejects_invalid_x_url_with_neutral_error(api_context):
    client, _, _, _ = api_context
    response = await client.post(
        "/v1/videos/inspect",
        json={
            "url": "https://x.com/example/status/not-a-status-id",
            "activeMediaIndex": 1,
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"] == {
        "code": "invalid_source_url",
        "message": "请输入有效的视频链接",
    }


@pytest.mark.asyncio
async def test_inspect_preserves_legacy_youtube_url_error(api_context):
    client, _, _, _ = api_context
    response = await client.post(
        "/v1/videos/inspect",
        json={"url": "https://www.youtube.com/watch?v=too-short"},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == {
        "code": "invalid_youtube_url",
        "message": "请输入有效的 YouTube 视频链接",
    }


@pytest.mark.asyncio
async def test_inspect_returns_readable_tracks(api_context):
    client, _, _, _ = api_context
    response = await client.post(
        "/v1/videos/inspect",
        json={"url": "https://www.youtube.com/watch?v=aircAruvnKk"},
    )

    assert response.status_code == 200
    assert response.json()["videoId"] == "aircAruvnKk"
    assert response.json()["tracks"][0]["languageCode"] == "en"
    assert response.json()["tracks"][0]["isGenerated"] is False


@pytest.mark.asyncio
async def test_inspect_routes_youtube_to_adapter(api_context):
    class FakeYouTubeAdapter:
        platform = "youtube"

        def parse_url(self, url, active_media_index=None):
            from app.sources.youtube import parse_youtube_url

            return parse_youtube_url(url)

        async def inspect(self, ref, preferred_languages):
            assert ref.source_content_id == "aircAruvnKk"
            return SourceInspection(
                ref=ref,
                duration_ms=1500,
                source_status="ready",
                transcript_source="youtube_caption",
                tracks=[TranscriptTrackInfo("en", "English", False, True)],
                selected_language="en",
            )

    client, app, _, _ = api_context
    app.dependency_overrides[get_source_registry] = lambda: SourceRegistry(
        [FakeYouTubeAdapter()]
    )

    response = await client.post(
        "/v1/videos/inspect",
        json={"url": "https://www.youtube.com/watch?v=aircAruvnKk"},
    )

    assert response.status_code == 200
    assert response.json()["contentRef"] == {
        "platform": "youtube",
        "sourceContentId": "aircAruvnKk",
        "mediaIndex": 1,
    }


@pytest.mark.asyncio
async def test_inspect_returns_platform_neutral_x_contract(api_context):
    client, app, _, _ = api_context
    app.dependency_overrides[get_source_registry] = lambda: SourceRegistry(
        [FakeXAdapter()]
    )

    response = await client.post(
        "/v1/videos/inspect",
        json={
            "url": "https://x.com/viktoroddy/status/2075545587093807111",
            "activeMediaIndex": 1,
            "clientDurationMs": 1_283_000,
            "mediaCandidates": [
                {
                    "url": "https://video.twimg.com/amplify_video/file.mp4",
                    "kind": "mp4",
                    "capturedAt": 1_788_419_200_000,
                }
            ],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["videoId"] is None
    assert body["contentId"]
    assert body["contentRef"] == {
        "platform": "x",
        "sourceContentId": "2075545587093807111",
        "mediaIndex": 1,
    }
    assert body["durationMs"] == 1_283_000
    assert body["sourceStatus"] == "ready"
    assert body["transcriptSource"] == "faster_whisper"
    assert body["availableLanguages"] == []
    assert body["selectedLanguage"] == "auto"


@pytest.mark.asyncio
async def test_inspect_limits_media_candidates_to_fifty(api_context):
    client, app, _, _ = api_context
    app.dependency_overrides[get_source_registry] = lambda: SourceRegistry(
        [FakeXAdapter()]
    )

    response = await client.post(
        "/v1/videos/inspect",
        json={
            "url": "https://x.com/viktoroddy/status/2075545587093807111/video/1",
            "mediaCandidates": [{} for _ in range(51)],
        },
    )

    assert response.status_code == 422


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "candidate",
    [
        {"url": "http://video.twimg.com/file.mp4", "kind": "mp4", "capturedAt": 1},
        {"url": "https://video.twimg.com/file.mp4", "kind": "other", "capturedAt": 1},
        {"url": "https://video.twimg.com/file.mp4", "kind": "mp4", "capturedAt": -1},
        {"url": "https://video.twimg.com/file.mp4", "kind": "mp4", "capturedAt": True},
        {
            "url": f"https://video.twimg.com/{'a' * 2000}",
            "kind": "mp4",
            "capturedAt": 1,
        },
    ],
)
async def test_inspect_rejects_invalid_media_candidates(api_context, candidate):
    client, app, _, _ = api_context
    app.dependency_overrides[get_source_registry] = lambda: SourceRegistry(
        [FakeXAdapter()]
    )

    response = await client.post(
        "/v1/videos/inspect",
        json={
            "url": "https://x.com/viktoroddy/status/2075545587093807111/video/1",
            "mediaCandidates": [candidate],
        },
    )

    assert response.status_code == 422


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        {
            "url": "https://x.com/viktoroddy/status/2075545587093807111",
            "activeMediaIndex": True,
        },
        {
            "url": ("https://x.com/viktoroddy/status/2075545587093807111/video/1"),
            "clientDurationMs": True,
        },
    ],
)
async def test_inspect_rejects_boolean_integer_fields(api_context, payload):
    client, app, _, _ = api_context
    app.dependency_overrides[get_source_registry] = lambda: SourceRegistry(
        [FakeXAdapter()]
    )

    response = await client.post("/v1/videos/inspect", json=payload)

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_x_provisional_duration_cannot_overwrite_existing_content(api_context):
    client, app, factory, _ = api_context
    app.dependency_overrides[get_source_registry] = lambda: SourceRegistry(
        [FakeXAdapter()]
    )
    registered = await client.post(
        "/v1/installations/register",
        json={
            "installationId": OTHER_INSTALLATION_ID,
            "installationToken": OTHER_INSTALLATION_TOKEN,
        },
    )
    assert registered.status_code == 201
    request = {
        "url": "https://x.com/viktoroddy/status/2075545587093807111/video/1",
        "clientDurationMs": 1_283_000,
    }

    first = await client.post("/v1/videos/inspect", json=request)
    second = await client.post(
        "/v1/videos/inspect",
        json={**request, "clientDurationMs": 42},
        headers=OTHER_AUTH_HEADERS,
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["contentId"] == first.json()["contentId"]
    assert second.json()["durationMs"] == 1_283_000
    async with factory() as session:
        video = await session.scalar(
            select(Video).where(Video.content_id == first.json()["contentId"])
        )
        assert video.duration_ms == 1_283_000


@pytest.mark.asyncio
async def test_x_inspect_rejects_client_duration_over_four_hours_before_source_or_storage(
    api_context,
):
    client, app, factory, _ = api_context

    class UnexpectedXInspection(FakeXAdapter):
        async def inspect_media(self, ref, media_candidates):
            raise AssertionError("over-limit X media must not be inspected")

    app.dependency_overrides[get_source_registry] = lambda: SourceRegistry(
        [UnexpectedXInspection()]
    )

    response = await client.post(
        "/v1/videos/inspect",
        json={
            "url": "https://x.com/viktoroddy/status/2075545587093807111/video/1",
            "clientDurationMs": 14_400_001,
            "mediaCandidates": [{
                "url": "https://video.twimg.com/file.mp4",
                "kind": "mp4",
                "capturedAt": 1,
            }],
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"] == {
        "code": "media_too_long",
        "message": "此视频时长过长，无法分析。",
    }
    async with factory() as session:
        assert await session.scalar(
            select(Video).where(
                Video.platform == "x",
                Video.source_content_id == "2075545587093807111",
            )
        ) is None


@pytest.mark.asyncio
async def test_inspect_stores_only_canonical_source_url(api_context):
    client, app, factory, _ = api_context
    app.dependency_overrides[get_source_registry] = lambda: SourceRegistry(
        [FakeXAdapter()]
    )
    media_url = "https://video.twimg.com/amplify_video/private-marker.mp4"

    response = await client.post(
        "/v1/videos/inspect",
        json={
            "url": (
                "https://x.com/viktoroddy/status/2075545587093807111/video/1"
                "?private_marker=discard"
            ),
            "mediaCandidates": [{"url": media_url, "kind": "mp4", "capturedAt": 1}],
        },
    )
    repeated = await client.post(
        "/v1/videos/inspect",
        json={
            "url": (
                "https://x.com/another/status/2075545587093807111/video/1"
                "?private_marker=still-discard"
            ),
            "mediaCandidates": [{"url": media_url, "kind": "mp4", "capturedAt": 2}],
        },
    )

    assert response.status_code == 200
    assert repeated.status_code == 200
    assert repeated.json()["contentId"] == response.json()["contentId"]
    async with factory() as session:
        video = await session.scalar(
            select(Video).where(Video.content_id == response.json()["contentId"])
        )
        assert video.source_url == (
            "https://x.com/i/status/2075545587093807111/video/1"
        )
        assert "private_marker" not in video.source_url
        assert media_url not in video.source_url


@pytest.mark.asyncio
async def test_concurrent_inspects_share_one_content_row(api_context):
    client, app, factory, _ = api_context
    app.dependency_overrides[get_source_registry] = lambda: SourceRegistry(
        [FakeXAdapter()]
    )
    registered = await client.post(
        "/v1/installations/register",
        json={
            "installationId": OTHER_INSTALLATION_ID,
            "installationToken": OTHER_INSTALLATION_TOKEN,
        },
    )
    assert registered.status_code == 201
    payload = {
        "url": "https://x.com/viktoroddy/status/2075545587093807111/video/1",
        "clientDurationMs": 1_283_000,
    }

    first, second = await asyncio.gather(
        client.post("/v1/videos/inspect", json=payload),
        client.post("/v1/videos/inspect", json=payload, headers=OTHER_AUTH_HEADERS),
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["contentId"] == second.json()["contentId"]
    async with factory() as session:
        videos = (
            await session.scalars(
                select(Video).where(
                    Video.platform == "x",
                    Video.source_content_id == "2075545587093807111",
                )
            )
        ).all()
        assert len(videos) == 1


@pytest.mark.asyncio
async def test_inspect_does_not_expose_registry_configuration_errors(api_context):
    class MismatchedAdapter:
        platform = "youtube"

        def parse_url(self, url, active_media_index=None):
            from app.sources.base import ContentRef

            return ContentRef("x", "2075545587093807111")

    client, app, _, _ = api_context
    app.dependency_overrides[get_source_registry] = lambda: SourceRegistry(
        [MismatchedAdapter()]
    )

    response = await client.post(
        "/v1/videos/inspect",
        json={"url": "https://www.youtube.com/watch?v=aircAruvnKk"},
    )

    assert response.status_code == 500
    assert response.json()["detail"] == {
        "code": "source_adapter_unavailable",
        "message": "暂时无法处理该视频来源",
    }


@pytest.mark.asyncio
async def test_inspect_reports_no_caption_track(api_context):
    client, app, _, _ = api_context
    app.dependency_overrides[get_transcript_service] = lambda: FakeTranscriptService(
        False
    )

    response = await client.post(
        "/v1/videos/inspect", json={"url": "https://youtu.be/aircAruvnKk"}
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "no_caption_track"


@pytest.mark.asyncio
async def test_inspect_allows_video_exactly_four_hours(api_context):
    client, app, _, _ = api_context
    app.dependency_overrides[get_video_metadata_service] = (
        lambda: FakeVideoMetadataService(14_400_000)
    )

    response = await client.post(
        "/v1/videos/inspect",
        json={"url": "https://youtu.be/aircAruvnKk"},
    )

    assert response.status_code == 200
    assert response.json()["durationMs"] == 14_400_000


@pytest.mark.asyncio
async def test_inspect_rejects_video_over_four_hours_before_fetching_captions(
    api_context,
):
    client, app, _, _ = api_context
    transcript = FakeTranscriptService()
    transcript.calls = 0
    original_inspect = transcript.inspect

    def counting_inspect(*args, **kwargs):
        transcript.calls += 1
        return original_inspect(*args, **kwargs)

    transcript.inspect = counting_inspect
    app.dependency_overrides[get_transcript_service] = lambda: transcript
    app.dependency_overrides[get_video_metadata_service] = (
        lambda: FakeVideoMetadataService(14_401_000)
    )

    response = await client.post(
        "/v1/videos/inspect",
        json={"url": "https://youtu.be/aircAruvnKk"},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == {
        "code": "video_too_long",
        "message": "此视频时长过长，无法分析。",
    }
    assert transcript.calls == 0


@pytest.mark.asyncio
async def test_inspect_does_not_fall_back_to_caption_duration_when_metadata_fails(
    api_context,
):
    client, app, _, _ = api_context
    app.dependency_overrides[get_video_metadata_service] = (
        lambda: FakeVideoMetadataService(error=VideoMetadataError("lookup failed"))
    )

    response = await client.post(
        "/v1/videos/inspect",
        json={"url": "https://youtu.be/aircAruvnKk"},
    )

    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "video_metadata_unavailable"


@pytest.mark.asyncio
async def test_create_rechecks_video_duration(api_context):
    client, app, _, dispatched = api_context
    app.dependency_overrides[get_video_metadata_service] = (
        lambda: FakeVideoMetadataService(14_401_000)
    )

    response = await client.post(
        "/v1/analyses",
        json={
            "videoId": "aircAruvnKk",
            "sourceLanguage": "en",
            "targetLanguage": "zh-Hans",
            "llmConfig": LLM_CONFIG,
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "video_too_long"
    assert dispatched == []


@pytest.mark.asyncio
async def test_write_rate_limit_rejects_request_twenty_one_with_retry_after(
    api_context,
):
    client, app, _, _ = api_context
    limiter = BoundaryQuotaLimiter()
    app.dependency_overrides[get_quota_limiter] = lambda: limiter

    for _ in range(20):
        response = await client.post(
            "/v1/videos/inspect",
            json={"url": "https://youtu.be/aircAruvnKk"},
        )
        assert response.status_code == 200
    blocked = await client.post(
        "/v1/videos/inspect",
        json={"url": "https://youtu.be/aircAruvnKk"},
    )

    assert blocked.status_code == 429
    assert blocked.json()["detail"]["code"] == "rate_limit_exceeded"
    assert blocked.headers["Retry-After"] == "37"


@pytest.mark.asyncio
async def test_read_rate_limit_is_independent_per_installation(api_context):
    client, app, _, _ = api_context
    limiter = BoundaryQuotaLimiter()
    app.dependency_overrides[get_quota_limiter] = lambda: limiter
    registered = await client.post(
        "/v1/installations/register",
        json={
            "installationId": OTHER_INSTALLATION_ID,
            "installationToken": OTHER_INSTALLATION_TOKEN,
        },
    )
    assert registered.status_code == 201

    for _ in range(120):
        response = await client.get("/v1/analyses/history")
        assert response.status_code == 200
    blocked = await client.get("/v1/analyses/history")
    other = await client.get("/v1/analyses/history", headers=OTHER_AUTH_HEADERS)

    assert blocked.status_code == 429
    assert other.status_code == 200


@pytest.mark.asyncio
async def test_quota_service_failure_returns_503(api_context):
    client, app, _, _ = api_context
    app.dependency_overrides[get_quota_limiter] = lambda: FailingQuotaLimiter()

    response = await client.get("/v1/analyses/history")

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "quota_service_unavailable"


@pytest.mark.asyncio
async def test_create_requires_llm_configuration(api_context):
    client, _, _, dispatched = api_context
    response = await client.post(
        "/v1/analyses",
        json={
            "videoId": "aircAruvnKk",
            "sourceLanguage": "en",
            "targetLanguage": "zh-Hans",
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "llm_config_required"
    assert dispatched == []


@pytest.mark.asyncio
async def test_create_stores_only_encrypted_temporary_llm_credential(api_context):
    client, _, factory, _ = api_context

    response = await client.post(
        "/v1/analyses",
        json={
            "videoId": "aircAruvnKk",
            "sourceLanguage": "en",
            "targetLanguage": "zh-Hans",
            "llmConfig": LLM_CONFIG,
        },
    )

    assert response.status_code == 202
    async with factory() as session:
        job = await session.get(AnalysisJob, response.json()["jobId"])
        assert "api_key" not in job.llm_config
        assert "test-key" not in job.llm_credential_ciphertext
        assert job.llm_credential_expires_at is not None
        assert (
            JobCredentialCipher(VALID_TEST_KEY).decrypt(
                job.id, job.llm_credential_ciphertext
            )
            == "test-key"
        )


@pytest.mark.asyncio
async def test_create_rejects_an_llm_endpoint_with_query_credentials(api_context):
    client, _, factory, dispatched = api_context
    payload = {
        "videoId": "aircAruvnKk",
        "sourceLanguage": "en",
        "targetLanguage": "zh-Hans",
        "llmConfig": {
            **LLM_CONFIG,
            "apiUrl": "https://api.example.com/v1?api_key=must-not-persist",
        },
    }

    response = await client.post("/v1/analyses", json=payload)

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "llm_config_invalid"
    async with factory() as session:
        assert await session.scalar(select(AnalysisJob)) is None
    assert dispatched == []


@pytest.mark.asyncio
async def test_legacy_youtube_create_returns_content_identity(api_context):
    client, _, _, _ = api_context

    response = await client.post(
        "/v1/analyses",
        json={
            "videoId": "aircAruvnKk",
            "sourceLanguage": "en",
            "llmConfig": LLM_CONFIG,
        },
    )

    assert response.status_code == 202
    body = response.json()
    assert body["videoId"] == "aircAruvnKk"
    assert body["contentId"]
    assert body["contentRef"] == {
        "platform": "youtube",
        "sourceContentId": "aircAruvnKk",
        "mediaIndex": 1,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "locator",
    [
        {},
        {
            "videoId": "aircAruvnKk",
            "contentRef": {
                "platform": "youtube",
                "sourceContentId": "aircAruvnKk",
            },
        },
    ],
)
async def test_create_requires_exactly_one_content_locator(api_context, locator):
    client, _, _, dispatched = api_context

    response = await client.post(
        "/v1/analyses",
        json={**locator, "sourceLanguage": "en", "llmConfig": LLM_CONFIG},
    )

    assert response.status_code == 422
    assert dispatched == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "locator",
    [
        {"contentId": ""},
        {"contentId": "not-a-uuid"},
        {
            "contentRef": {
                "platform": "x",
                "sourceContentId": "",
                "mediaIndex": 1,
            }
        },
        {
            "contentRef": {
                "platform": "x",
                "sourceContentId": "0",
                "mediaIndex": 1,
            }
        },
        {
            "contentRef": {
                "platform": "x",
                "sourceContentId": "٢٠٧٥٥٤٥٥٨٧٠٩٣٨٠٧١١١",
                "mediaIndex": 1,
            }
        },
        {
            "contentRef": {
                "platform": "x",
                "sourceContentId": "1" * 21,
                "mediaIndex": 1,
            }
        },
        {
            "contentRef": {
                "platform": "x",
                "sourceContentId": "9" * 20,
                "mediaIndex": 1,
            }
        },
        {
            "contentRef": {
                "platform": "x",
                "sourceContentId": "2075545587093807111",
                "mediaIndex": 2_147_483_648,
            }
        },
        {
            "contentRef": {
                "platform": "youtube",
                "sourceContentId": "too-short",
                "mediaIndex": 1,
            }
        },
    ],
)
async def test_create_rejects_invalid_content_locators(api_context, locator):
    client, app, _, dispatched = api_context
    app.dependency_overrides[get_source_registry] = lambda: SourceRegistry(
        [FakeXAdapter()]
    )

    response = await client.post(
        "/v1/analyses",
        json={**locator, "sourceLanguage": "auto", "llmConfig": LLM_CONFIG},
    )

    assert response.status_code == 422
    assert dispatched == []


@pytest.mark.asyncio
async def test_create_rejects_boolean_content_ref_media_index(api_context):
    client, _, factory, dispatched = api_context

    response = await client.post(
        "/v1/analyses",
        json={
            "contentRef": {
                "platform": "youtube",
                "sourceContentId": "aircAruvnKk",
                "mediaIndex": True,
            },
            "sourceLanguage": "en",
            "llmConfig": LLM_CONFIG,
        },
    )

    assert response.status_code == 422
    assert dispatched == []
    async with factory() as session:
        assert (await session.scalars(select(Video))).all() == []
        assert (await session.scalars(select(AnalysisJob))).all() == []


@pytest.mark.asyncio
async def test_create_content_ref_defaults_media_index_to_one(api_context):
    client, _, _, dispatched = api_context

    response = await client.post(
        "/v1/analyses",
        json={
            "contentRef": {
                "platform": "youtube",
                "sourceContentId": "aircAruvnKk",
            },
            "sourceLanguage": "en",
            "llmConfig": LLM_CONFIG,
        },
    )

    assert response.status_code == 202
    assert response.json()["contentRef"]["mediaIndex"] == 1
    assert dispatched == [response.json()["jobId"]]


@pytest.mark.asyncio
async def test_create_rejects_youtube_media_index_above_one_without_writes(api_context):
    client, _, factory, dispatched = api_context

    response = await client.post(
        "/v1/analyses",
        json={
            "contentRef": {
                "platform": "youtube",
                "sourceContentId": "aircAruvnKk",
                "mediaIndex": 2,
            },
            "sourceLanguage": "en",
            "llmConfig": LLM_CONFIG,
        },
    )

    assert response.status_code == 422
    assert dispatched == []
    async with factory() as session:
        assert (await session.scalars(select(Video))).all() == []
        assert (await session.scalars(select(AnalysisJob))).all() == []


@pytest.mark.asyncio
async def test_create_rejects_youtube_media_index_above_one_without_mutation(
    api_context,
):
    client, _, factory, dispatched = api_context
    content_id = "33333333-3333-4333-8333-333333333333"
    original_values = (
        "Original title",
        123_456,
        "https://www.youtube.com/watch?v=aircAruvnKk",
    )
    async with factory() as session:
        session.add(
            Video(
                video_id="aircAruvnKk",
                content_id=content_id,
                platform="youtube",
                source_content_id="aircAruvnKk",
                media_index=1,
                title=original_values[0],
                duration_ms=original_values[1],
                source_url=original_values[2],
            )
        )
        await session.commit()

    response = await client.post(
        "/v1/analyses",
        json={
            "contentRef": {
                "platform": "youtube",
                "sourceContentId": "aircAruvnKk",
                "mediaIndex": 2,
            },
            "sourceLanguage": "en",
            "llmConfig": LLM_CONFIG,
        },
    )

    assert response.status_code == 422
    assert dispatched == []
    async with factory() as session:
        videos = (await session.scalars(select(Video))).all()
        assert len(videos) == 1
        assert videos[0].content_id == content_id
        assert (
            videos[0].title,
            videos[0].duration_ms,
            videos[0].source_url,
        ) == original_values
        assert videos[0].media_index == 1
        assert (await session.scalars(select(AnalysisJob))).all() == []


@pytest.mark.asyncio
async def test_inspect_rejects_media_index_above_database_integer_limit(api_context):
    client, app, _, _ = api_context
    app.dependency_overrides[get_source_registry] = lambda: SourceRegistry(
        [FakeXAdapter()]
    )

    response = await client.post(
        "/v1/videos/inspect",
        json={
            "url": (
                "https://x.com/viktoroddy/status/2075545587093807111/video/"
                "2147483648"
            )
        },
    )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_llm_test_rejects_invalid_url_without_network_call(api_context):
    client, _, _, _ = api_context
    response = await client.post(
        "/v1/llm/test", json={"apiUrl": "not-a-url", "apiKey": "secret"}
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "llm_config_invalid"
    assert "secret" not in response.text


@pytest.mark.asyncio
async def test_create_reuses_active_and_completed_jobs(api_context):
    client, _, factory, dispatched = api_context
    payload = {
        "videoId": "aircAruvnKk",
        "sourceLanguage": "en",
        "targetLanguage": "zh-Hans",
        "title": "But what is a neural network?",
        "llmConfig": LLM_CONFIG,
    }
    first = await client.post("/v1/analyses", json=payload)
    second = await client.post("/v1/analyses", json=payload)

    assert first.status_code == 202
    assert second.status_code == 202
    assert second.json()["jobId"] == first.json()["jobId"]
    assert second.json()["cacheHit"] is False
    assert dispatched == [first.json()["jobId"]]

    async with factory() as session:
        job = await session.get(
            __import__("app.db.models", fromlist=["AnalysisJob"]).AnalysisJob,
            first.json()["jobId"],
        )
        job.status = "completed"
        await session.commit()

    completed = await client.post("/v1/analyses", json=payload)
    assert completed.status_code == 200
    assert completed.json()["cacheHit"] is True


@pytest.mark.asyncio
async def test_legacy_youtube_cache_key_reuses_completed_job(api_context):
    client, _, factory, dispatched = api_context
    payload = {
        "videoId": "aircAruvnKk",
        "sourceLanguage": "en",
        "targetLanguage": "zh-Hans",
        "llmConfig": LLM_CONFIG,
    }
    first = await client.post("/v1/analyses", json=payload)
    job_id = first.json()["jobId"]
    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        job.cache_key = job.cache_key.replace("youtube:aircAruvnKk:1", "aircAruvnKk")
        job.status = "completed"
        job.completed_at = datetime.now(timezone.utc)
        await session.commit()

    cached = await client.post("/v1/analyses", json=payload)

    assert cached.status_code == 200
    assert cached.json()["jobId"] == job_id
    assert cached.json()["cacheHit"] is True
    assert dispatched == [job_id]


@pytest.mark.asyncio
async def test_identical_analysis_is_cached_per_installation(api_context):
    client, _, factory, dispatched = api_context
    registered = await client.post(
        "/v1/installations/register",
        json={
            "installationId": OTHER_INSTALLATION_ID,
            "installationToken": OTHER_INSTALLATION_TOKEN,
        },
    )
    assert registered.status_code == 201
    payload = {
        "videoId": "aircAruvnKk",
        "sourceLanguage": "en",
        "targetLanguage": "zh-Hans",
        "llmConfig": LLM_CONFIG,
    }

    first_a = await client.post("/v1/analyses", json=payload)
    second_a = await client.post("/v1/analyses", json=payload)
    first_b = await client.post(
        "/v1/analyses", json=payload, headers=OTHER_AUTH_HEADERS
    )

    assert second_a.json()["jobId"] == first_a.json()["jobId"]
    assert first_b.status_code == 202
    assert first_b.json()["jobId"] != first_a.json()["jobId"]
    async with factory() as session:
        jobs = (await session.scalars(select(AnalysisJob))).all()
        assert {job.installation_id for job in jobs} == {
            INSTALLATION_ID,
            OTHER_INSTALLATION_ID,
        }
    assert dispatched == [first_a.json()["jobId"], first_b.json()["jobId"]]


@pytest.mark.asyncio
async def test_different_analysis_is_blocked_while_installation_has_active_job(
    api_context,
):
    client, _, _, dispatched = api_context
    first = await client.post(
        "/v1/analyses",
        json={
            "videoId": "aircAruvnKk",
            "sourceLanguage": "en",
            "targetLanguage": "zh-Hans",
            "llmConfig": LLM_CONFIG,
        },
    )
    blocked = await client.post(
        "/v1/analyses",
        json={
            "videoId": "aircAruvnKk",
            "sourceLanguage": "en",
            "targetLanguage": "fr",
            "llmConfig": LLM_CONFIG,
        },
    )

    assert first.status_code == 202
    assert blocked.status_code == 429
    assert blocked.json()["detail"] == {
        "code": "analysis_concurrency_limit",
        "message": "已有视频正在分析，请等待完成后再试。",
    }
    assert dispatched == [first.json()["jobId"]]


@pytest.mark.asyncio
async def test_active_job_limit_is_independent_per_installation(api_context):
    client, _, _, dispatched = api_context
    registered = await client.post(
        "/v1/installations/register",
        json={
            "installationId": OTHER_INSTALLATION_ID,
            "installationToken": OTHER_INSTALLATION_TOKEN,
        },
    )
    assert registered.status_code == 201
    payload = {
        "videoId": "aircAruvnKk",
        "sourceLanguage": "en",
        "targetLanguage": "zh-Hans",
        "llmConfig": LLM_CONFIG,
    }

    first = await client.post("/v1/analyses", json=payload)
    other = await client.post("/v1/analyses", json=payload, headers=OTHER_AUTH_HEADERS)

    assert first.status_code == 202
    assert other.status_code == 202
    assert first.json()["jobId"] != other.json()["jobId"]
    assert len(dispatched) == 2


@pytest.mark.asyncio
async def test_concurrent_x_creates_share_one_content_row_across_installations(
    api_context,
):
    client, app, factory, dispatched = api_context
    app.dependency_overrides[get_source_registry] = lambda: SourceRegistry(
        [FakeXAdapter()]
    )
    registered = await client.post(
        "/v1/installations/register",
        json={
            "installationId": OTHER_INSTALLATION_ID,
            "installationToken": OTHER_INSTALLATION_TOKEN,
        },
    )
    assert registered.status_code == 201
    payload = {
        "contentRef": {
            "platform": "x",
            "sourceContentId": "2075545587093807111",
            "mediaIndex": 1,
        },
        "sourceLanguage": "auto",
        "llmConfig": LLM_CONFIG,
    }

    first, second = await asyncio.gather(
        client.post("/v1/analyses", json=payload),
        client.post("/v1/analyses", json=payload, headers=OTHER_AUTH_HEADERS),
    )

    assert first.status_code == 202
    assert second.status_code == 202
    assert first.json()["contentId"] == second.json()["contentId"]
    assert first.json()["jobId"] != second.json()["jobId"]
    assert len(dispatched) == 2
    async with factory() as session:
        videos = (
            await session.scalars(
                select(Video).where(
                    Video.platform == "x",
                    Video.source_content_id == "2075545587093807111",
                )
            )
        ).all()
        jobs = (await session.scalars(select(AnalysisJob))).all()
        assert len(videos) == 1
        assert {job.content_id for job in jobs} == {videos[0].content_id}


@pytest.mark.asyncio
async def test_simultaneous_different_analyses_create_only_one_active_job(api_context):
    client, _, _, dispatched = api_context
    base = {
        "videoId": "aircAruvnKk",
        "sourceLanguage": "en",
        "llmConfig": LLM_CONFIG,
    }

    first, second = await asyncio.gather(
        client.post("/v1/analyses", json={**base, "targetLanguage": "zh-Hans"}),
        client.post("/v1/analyses", json={**base, "targetLanguage": "fr"}),
    )

    assert sorted([first.status_code, second.status_code]) == [202, 429]
    blocked = first if first.status_code == 429 else second
    assert blocked.json()["detail"]["code"] == "analysis_concurrency_limit"
    assert len(dispatched) == 1


@pytest.mark.asyncio
async def test_history_and_job_reads_are_private_to_the_installation(api_context):
    client, _, factory, _ = api_context
    registered = await client.post(
        "/v1/installations/register",
        json={
            "installationId": OTHER_INSTALLATION_ID,
            "installationToken": OTHER_INSTALLATION_TOKEN,
        },
    )
    assert registered.status_code == 201
    payload = {
        "videoId": "aircAruvnKk",
        "sourceLanguage": "en",
        "targetLanguage": "zh-Hans",
        "llmConfig": LLM_CONFIG,
    }
    created_a = await client.post("/v1/analyses", json=payload)
    created_b = await client.post(
        "/v1/analyses", json=payload, headers=OTHER_AUTH_HEADERS
    )
    job_a = created_a.json()["jobId"]
    job_b = created_b.json()["jobId"]
    async with factory() as session:
        for job_id in (job_a, job_b):
            job = await session.get(AnalysisJob, job_id)
            job.status = "completed"
            job.completed_at = datetime.now(timezone.utc)
            job.result = AnalysisResult(
                one_line_summary=f"Summary {job_id}",
                summary_points=[],
                chapters=[],
                highlights=[],
                model_name="fake",
                model_version="test",
            )
        await session.commit()

    history_a = await client.get("/v1/analyses/history")
    history_b = await client.get("/v1/analyses/history", headers=OTHER_AUTH_HEADERS)

    assert [item["jobId"] for item in history_a.json()["items"]] == [job_a]
    assert [item["jobId"] for item in history_b.json()["items"]] == [job_b]
    for path in (f"/v1/analyses/{job_b}", f"/v1/analyses/{job_b}/result"):
        hidden = await client.get(path)
        assert hidden.status_code == 404
        assert hidden.json()["detail"]["code"] == "analysis_not_found"


@pytest.mark.asyncio
async def test_x_analysis_uses_content_id_for_history_without_weakening_ownership(
    api_context,
):
    client, app, factory, _ = api_context
    app.dependency_overrides[get_source_registry] = lambda: SourceRegistry(
        [FakeXAdapter()]
    )
    registered = await client.post(
        "/v1/installations/register",
        json={
            "installationId": OTHER_INSTALLATION_ID,
            "installationToken": OTHER_INSTALLATION_TOKEN,
        },
    )
    assert registered.status_code == 201

    inspected = await client.post(
        "/v1/videos/inspect",
        json={
            "url": "https://x.com/viktoroddy/status/2075545587093807111/video/1",
            "clientDurationMs": 1_283_000,
        },
    )
    content_id = inspected.json()["contentId"]
    created = await client.post(
        "/v1/analyses",
        json={
            "contentRef": {
                "platform": "x",
                "sourceContentId": "2075545587093807111",
                "mediaIndex": 1,
            },
            "targetLanguage": "zh-Hans",
            "title": "X fixture",
            "llmConfig": LLM_CONFIG,
        },
    )

    assert created.status_code == 202
    assert created.json()["videoId"] is None
    assert created.json()["contentId"] == content_id
    assert created.json()["contentRef"] == {
        "platform": "x",
        "sourceContentId": "2075545587093807111",
        "mediaIndex": 1,
    }
    job_id = created.json()["jobId"]
    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        assert job.content_id == content_id
        video = await session.get(Video, job.video_id)
        assert video.platform == "x"
        assert job.source_language == "auto"
        job.status = "completed"
        job.completed_at = datetime.now(timezone.utc)
        job.result = AnalysisResult(
            one_line_summary="X summary",
            summary_points=[],
            chapters=[],
            highlights=[],
            model_name="fake",
            model_version="test",
        )
        await session.commit()

    history = await client.get("/v1/analyses/history", params={"contentId": content_id})
    assert history.status_code == 200
    assert [item["jobId"] for item in history.json()["items"]] == [job_id]
    assert history.json()["items"][0]["videoId"] is None
    assert history.json()["items"][0]["contentRef"] == created.json()["contentRef"]

    result = await client.get(f"/v1/analyses/{job_id}/result")
    assert result.status_code == 200
    assert result.json()["contentId"] == content_id
    assert result.json()["videoId"] is None
    assert result.json()["contentRef"] == created.json()["contentRef"]

    hidden = await client.get(
        f"/v1/analyses/{job_id}/result", headers=OTHER_AUTH_HEADERS
    )
    assert hidden.status_code == 404
    assert hidden.json()["detail"]["code"] == "analysis_not_found"


@pytest.mark.asyncio
async def test_x_create_uses_pending_identity_and_encrypts_direct_media_url(
    api_context,
):
    client, app, factory, dispatched = api_context
    app.dependency_overrides[get_source_registry] = lambda: SourceRegistry(
        [FakeXAdapter()]
    )
    media_url = "https://video.twimg.com/ext_tw_video/file.mp4?token=private"

    created = await client.post(
        "/v1/analyses",
        json={
            "contentRef": {
                "platform": "x",
                "sourceContentId": "2075545587093807111",
                "mediaIndex": 1,
            },
            "targetLanguage": "zh-Hans",
            "mediaUrl": media_url,
            "llmConfig": LLM_CONFIG,
        },
    )

    assert created.status_code == 202
    job_id = created.json()["jobId"]
    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        assert job.source_language == "auto"
        assert job.transcript_version == f"pending:{job_id}"
        assert job.cache_key == f"pending:{INSTALLATION_ID}:{job_id}"
        assert job.media_url_ciphertext
        assert media_url not in job.media_url_ciphertext
        assert job.force_run is False
    assert dispatched == [job_id]


@pytest.mark.asyncio
@pytest.mark.parametrize("port", [443, 444, "abc", 99999])
async def test_x_create_rejects_direct_media_urls_with_explicit_ports(
    api_context, port
):
    client, app, _, dispatched = api_context
    app.dependency_overrides[get_source_registry] = lambda: SourceRegistry(
        [FakeXAdapter()]
    )

    response = await client.post(
        "/v1/analyses",
        json={
            "contentRef": {
                "platform": "x",
                "sourceContentId": "2075545587093807111",
                "mediaIndex": 1,
            },
            "targetLanguage": "zh-Hans",
            "mediaUrl": f"https://video.twimg.com:{port}/file.mp4",
            "llmConfig": LLM_CONFIG,
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_media_url"
    assert dispatched == []


async def _store_history_job(
    factory,
    *,
    video_id: str,
    title: str,
    status: str,
    completed_at: datetime | None,
    with_result: bool = True,
    cache_suffix: str,
) -> str:
    async with factory() as session:
        video = await session.get(Video, video_id)
        if video is None:
            video = Video(
                video_id=video_id,
                title=title,
                duration_ms=754_000,
                source_url=f"https://www.youtube.com/watch?v={video_id}",
            )
            session.add(video)
        job = AnalysisJob(
            installation_id=INSTALLATION_ID,
            video_id=video_id,
            source_language="en",
            target_language="zh-Hans",
            transcript_version="transcript-v1",
            cache_key=f"history:{cache_suffix}",
            llm_config={
                "provider": "deepseek",
                "api_url": "https://api.example.com/v1",
                "api_key": "must-not-leak",
                "model": "deepseek-v4-flash",
            },
            status=status,
            completed_at=completed_at,
        )
        if with_result:
            job.result = AnalysisResult(
                one_line_summary=f"Summary {cache_suffix}",
                summary_points=[],
                chapters=[],
                highlights=[],
                model_name="deepseek",
                model_version="deepseek-v4-flash",
            )
        session.add(job)
        await session.commit()
        return job.id


@pytest.mark.asyncio
async def test_history_returns_only_completed_results_newest_first(api_context):
    client, _, factory, _ = api_context
    now = datetime.now(timezone.utc)
    older_id = await _store_history_job(
        factory,
        video_id="aircAruvnKk",
        title="Neural networks",
        status="completed",
        completed_at=now - timedelta(hours=2),
        cache_suffix="older",
    )
    newest_id = await _store_history_job(
        factory,
        video_id="3eExfC63uSc",
        title="A newer video",
        status="completed",
        completed_at=now - timedelta(hours=1),
        cache_suffix="newest",
    )
    await _store_history_job(
        factory,
        video_id="queuedVid01",
        title="Queued",
        status="queued",
        completed_at=None,
        cache_suffix="queued",
    )
    await _store_history_job(
        factory,
        video_id="failedVid01",
        title="Failed",
        status="failed",
        completed_at=now,
        cache_suffix="failed",
    )
    await _store_history_job(
        factory,
        video_id="noResult001",
        title="No result",
        status="completed",
        completed_at=now,
        with_result=False,
        cache_suffix="no-result",
    )

    response = await client.get("/v1/analyses/history")

    assert response.status_code == 200
    assert [item["jobId"] for item in response.json()["items"]] == [
        newest_id,
        older_id,
    ]
    newest = response.json()["items"][0]
    assert newest["videoTitle"] == "A newer video"
    assert newest["durationMs"] == 754_000
    assert newest["modelName"] == "deepseek"
    assert newest["modelVersion"] == "deepseek-v4-flash"
    assert response.json()["hasMore"] is False
    assert "llmConfig" not in newest
    assert "must-not-leak" not in response.text


@pytest.mark.asyncio
async def test_history_filters_by_video_and_paginates(api_context):
    client, _, factory, _ = api_context
    now = datetime.now(timezone.utc)
    expected_ids = []
    for index in range(3):
        expected_ids.append(
            await _store_history_job(
                factory,
                video_id="aircAruvnKk",
                title="Neural networks",
                status="completed",
                completed_at=now + timedelta(minutes=index),
                cache_suffix=f"matching-{index}",
            )
        )
    await _store_history_job(
        factory,
        video_id="3eExfC63uSc",
        title="Another video",
        status="completed",
        completed_at=now + timedelta(hours=1),
        cache_suffix="other-video",
    )

    first_page = await client.get(
        "/v1/analyses/history",
        params={"videoId": "aircAruvnKk", "limit": 2, "offset": 0},
    )
    second_page = await client.get(
        "/v1/analyses/history",
        params={"videoId": "aircAruvnKk", "limit": 2, "offset": 2},
    )

    assert [item["jobId"] for item in first_page.json()["items"]] == list(
        reversed(expected_ids[1:])
    )
    assert first_page.json()["hasMore"] is True
    assert [item["jobId"] for item in second_page.json()["items"]] == [expected_ids[0]]
    assert second_page.json()["hasMore"] is False


@pytest.mark.asyncio
async def test_history_validates_pagination(api_context):
    client, _, _, _ = api_context

    assert (await client.get("/v1/analyses/history?limit=0")).status_code == 422
    assert (await client.get("/v1/analyses/history?limit=101")).status_code == 422
    assert (await client.get("/v1/analyses/history?offset=-1")).status_code == 422


@pytest.mark.asyncio
async def test_force_create_generates_new_jobs_and_preserves_cached_result(api_context):
    client, _, factory, dispatched = api_context
    payload = {
        "videoId": "aircAruvnKk",
        "sourceLanguage": "en",
        "targetLanguage": "zh-Hans",
        "title": "Neural networks",
        "llmConfig": LLM_CONFIG,
    }
    original = await client.post("/v1/analyses", json=payload)
    original_id = original.json()["jobId"]
    async with factory() as session:
        job = await session.get(AnalysisJob, original_id)
        job.status = "completed"
        job.completed_at = datetime.now(timezone.utc)
        job.result = AnalysisResult(
            one_line_summary="Original summary",
            summary_points=["Original point"],
            chapters=[],
            highlights=[],
            model_name="fake",
            model_version="test",
        )
        await session.commit()

    cached = await client.post("/v1/analyses", json={**payload, "force": False})
    forced_once = await client.post("/v1/analyses", json={**payload, "force": True})
    async with factory() as session:
        forced_job = await session.get(AnalysisJob, forced_once.json()["jobId"])
        forced_job.status = "completed"
        forced_job.completed_at = datetime.now(timezone.utc)
        await session.commit()
    forced_twice = await client.post("/v1/analyses", json={**payload, "force": True})

    assert cached.status_code == 200
    assert cached.json()["jobId"] == original_id
    assert cached.json()["cacheHit"] is True
    assert forced_once.status_code == 202
    assert forced_twice.status_code == 202
    assert (
        len({original_id, forced_once.json()["jobId"], forced_twice.json()["jobId"]})
        == 3
    )
    assert dispatched == [
        original_id,
        forced_once.json()["jobId"],
        forced_twice.json()["jobId"],
    ]
    original_result = await client.get(f"/v1/analyses/{original_id}/result")
    assert original_result.json()["oneLineSummary"] == "Original summary"
    assert original_result.json()["summaryPoints"] == ["Original point"]


@pytest.mark.asyncio
async def test_create_requeues_an_interrupted_in_progress_job(api_context):
    client, _, factory, dispatched = api_context
    payload = {
        "videoId": "aircAruvnKk",
        "sourceLanguage": "en",
        "targetLanguage": "zh-Hans",
        "llmConfig": LLM_CONFIG,
    }
    created = await client.post("/v1/analyses", json=payload)
    job_id = created.json()["jobId"]

    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        job.status = "translating"
        await session.commit()

    resumed = await client.post("/v1/analyses", json=payload)

    assert resumed.status_code == 202
    assert resumed.json() == {
        "jobId": job_id,
        "cacheHit": False,
        "status": "queued",
        "contentId": resumed.json()["contentId"],
        "contentRef": {
            "platform": "youtube",
            "sourceContentId": "aircAruvnKk",
            "mediaIndex": 1,
        },
        "videoId": "aircAruvnKk",
    }
    assert dispatched == [job_id, job_id]


@pytest.mark.asyncio
async def test_create_reuses_an_in_progress_job_with_a_live_lease(api_context):
    client, _, factory, dispatched = api_context
    payload = {
        "videoId": "aircAruvnKk",
        "sourceLanguage": "en",
        "targetLanguage": "zh-Hans",
        "llmConfig": LLM_CONFIG,
    }
    created = await client.post("/v1/analyses", json=payload)
    job_id = created.json()["jobId"]

    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        job.status = "translating"
        job.lease_token = "active-worker-token"
        job.lease_expires_at = datetime.now(timezone.utc) + timedelta(minutes=5)
        await session.commit()

    reused = await client.post("/v1/analyses", json=payload)

    assert reused.status_code == 202
    assert reused.json()["jobId"] == job_id
    assert reused.json()["status"] == "translating"
    assert dispatched == [job_id]
    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        assert job.status == "translating"
        assert job.lease_token == "active-worker-token"


@pytest.mark.asyncio
async def test_concurrent_create_requests_reuse_one_job(api_context):
    client, _, _, dispatched = api_context
    payload = {
        "videoId": "aircAruvnKk",
        "sourceLanguage": "en",
        "targetLanguage": "zh-Hans",
        "llmConfig": LLM_CONFIG,
    }

    first, second = await asyncio.gather(
        client.post("/v1/analyses", json=payload),
        client.post("/v1/analyses", json=payload),
    )

    assert {first.status_code, second.status_code} == {202}
    assert first.json()["jobId"] == second.json()["jobId"]
    assert dispatched == [first.json()["jobId"]]


@pytest.mark.asyncio
async def test_database_rejects_second_active_job_after_redis_lock_expires(api_context):
    client, app, _, dispatched = api_context
    app.dependency_overrides[get_quota_limiter] = lambda: UnlockedQuotaLimiter()
    first_payload = {
        "videoId": "aircAruvnKk",
        "sourceLanguage": "en",
        "targetLanguage": "zh-Hans",
        "llmConfig": LLM_CONFIG,
    }
    second_payload = {**first_payload, "targetLanguage": "fr"}

    first, second = await asyncio.gather(
        client.post("/v1/analyses", json=first_payload),
        client.post("/v1/analyses", json=second_payload),
    )

    responses = {first.status_code: first, second.status_code: second}
    assert set(responses) == {202, 429}
    assert responses[429].json()["detail"]["code"] == "analysis_concurrency_limit"
    assert len(dispatched) == 1


@pytest.mark.asyncio
async def test_legacy_result_without_llm_snapshot_does_not_guess_translation_ownership(
    api_context,
):
    client, _, factory, _ = api_context
    created = await client.post(
        "/v1/analyses",
        json={
            "videoId": "aircAruvnKk",
            "sourceLanguage": "en",
            "targetLanguage": "zh-Hans",
            "llmConfig": LLM_CONFIG,
        },
    )
    job_id = created.json()["jobId"]
    await _complete_job_with_translation(
        factory,
        job_id,
        provider="legacy-provider",
        provider_version="legacy-v1",
        llm_config=None,
    )

    response = await client.get(f"/v1/analyses/{job_id}/result")

    assert response.status_code == 200
    assert response.json()["transcript"][0]["translated"] is None


@pytest.mark.asyncio
async def test_legacy_result_without_llm_snapshot_or_translation_does_not_error(
    api_context,
):
    client, _, factory, _ = api_context
    created = await client.post(
        "/v1/analyses",
        json={
            "videoId": "aircAruvnKk",
            "sourceLanguage": "en",
            "targetLanguage": "zh-Hans",
            "llmConfig": LLM_CONFIG,
        },
    )
    job_id = created.json()["jobId"]
    await _complete_job_with_translation(
        factory,
        job_id,
        provider="legacy-provider",
        provider_version="legacy-v1",
        llm_config=None,
        store_translation=False,
    )

    response = await client.get(f"/v1/analyses/{job_id}/result")

    assert response.status_code == 200
    assert response.json()["transcript"][0]["translated"] is None


@pytest.mark.asyncio
async def test_legacy_result_does_not_guess_between_multiple_translation_providers(
    api_context,
):
    client, _, factory, _ = api_context
    created = await client.post(
        "/v1/analyses",
        json={
            "videoId": "aircAruvnKk",
            "sourceLanguage": "en",
            "targetLanguage": "zh-Hans",
            "llmConfig": LLM_CONFIG,
        },
    )
    job_id = created.json()["jobId"]
    await _complete_job_with_translation(
        factory,
        job_id,
        provider="legacy-provider",
        provider_version="legacy-v1",
        llm_config=None,
    )
    async with factory() as session:
        track = await session.scalar(select(TranscriptTrack))
        segment = await session.scalar(
            select(StoredTranscriptSegment).where(
                StoredTranscriptSegment.track_id == track.id
            )
        )
        session.add(
            Translation(
                track_id=track.id,
                target_language="zh-Hans",
                provider="another-provider",
                provider_version="another-v1",
                transcript_version=track.transcript_version,
                segments=[
                    {
                        "segment_id": segment.id,
                        "start_ms": 0,
                        "duration_ms": 1500,
                        "text": "Unrelated translation",
                    }
                ],
            )
        )
        await session.commit()

    response = await client.get(f"/v1/analyses/{job_id}/result")

    assert response.status_code == 200
    assert response.json()["transcript"][0]["translated"] is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("provider", "provider_version"),
    [
        (
            "deepseek",
            provider_translation_version(
                "https://api.example.com/v1/chat/completions",
                provider="deepseek",
                version="kimi-k2.5",
            ),
        ),
        (
            "kimi",
            provider_translation_version(
                "https://api.example.com/v1/chat/completions",
                provider="kimi",
                version="different-model",
            ),
        ),
        (
            "kimi",
            provider_translation_version(
                "https://other.example.com/v1/chat/completions",
                provider="kimi",
                version="kimi-k2.5",
            ),
        ),
    ],
)
async def test_modern_result_does_not_fall_back_to_another_translation_identity(
    api_context, provider, provider_version
):
    client, _, factory, _ = api_context
    created = await client.post(
        "/v1/analyses",
        json={
            "videoId": "aircAruvnKk",
            "sourceLanguage": "en",
            "targetLanguage": "zh-Hans",
            "llmConfig": LLM_CONFIG,
        },
    )
    job_id = created.json()["jobId"]
    await _complete_job_with_translation(
        factory,
        job_id,
        provider=provider,
        provider_version=provider_version,
    )

    response = await client.get(f"/v1/analyses/{job_id}/result")

    assert response.status_code == 200
    assert response.json()["transcript"][0]["translated"] is None


@pytest.mark.asyncio
async def test_result_tolerates_an_invalid_historical_llm_endpoint(api_context):
    client, _, factory, _ = api_context
    created = await client.post(
        "/v1/analyses",
        json={
            "videoId": "aircAruvnKk",
            "sourceLanguage": "en",
            "targetLanguage": "zh-Hans",
            "llmConfig": LLM_CONFIG,
        },
    )
    job_id = created.json()["jobId"]
    await _complete_job_with_translation(
        factory,
        job_id,
        provider="kimi",
        provider_version="historical-version",
    )
    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        job.llm_config = {**job.llm_config, "api_url": "not a valid endpoint"}
        await session.commit()

    response = await client.get(f"/v1/analyses/{job_id}/result")

    assert response.status_code == 200
    assert response.json()["transcript"][0]["translated"] is None


@pytest.mark.asyncio
async def test_status_and_result_endpoints(api_context):
    client, _, factory, _ = api_context
    created = await client.post(
        "/v1/analyses",
        json={
            "videoId": "aircAruvnKk",
            "sourceLanguage": "en",
            "targetLanguage": "zh-Hans",
            "llmConfig": LLM_CONFIG,
        },
    )
    job_id = created.json()["jobId"]

    status = await client.get(f"/v1/analyses/{job_id}")
    assert status.json()["status"] == "queued"
    pending_result = await client.get(f"/v1/analyses/{job_id}/result")
    assert pending_result.status_code == 409

    from app.db.models import AnalysisJob

    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        job.status = "completed"
        job.result = AnalysisResult(
            one_line_summary="神经网络从样本中学习。",
            summary_points=["输入层保存像素值"],
            chapters=[
                {"start_ms": 0, "end_ms": 1500, "title": "输入", "summary": "像素"}
            ],
            highlights=[],
            model_name="fake",
            model_version="test",
        )
        version = job.transcript_version
        track = TranscriptTrack(
            video_id=job.video_id,
            language_code="en",
            language_name="English",
            is_generated=False,
            is_translatable=True,
            transcript_version=version,
        )
        track.segments = [
            StoredTranscriptSegment(
                sequence=0,
                start_ms=0,
                duration_ms=1500,
                text="Hello world",
            )
        ]
        session.add(track)
        await session.flush()
        session.add(
            Translation(
                track_id=track.id,
                target_language="zh-Hans",
                provider="kimi",
                provider_version=provider_translation_version(
                    "https://api.example.com/v1/chat/completions",
                    provider="kimi",
                    version="kimi-k2.5",
                ),
                transcript_version=version,
                segments=[
                    {
                        "segment_id": track.segments[0].id,
                        "start_ms": 0,
                        "duration_ms": 1500,
                        "text": "你好，世界",
                    }
                ],
            )
        )
        await session.commit()

    result = await client.get(f"/v1/analyses/{job_id}/result")
    assert result.status_code == 200
    assert result.json()["oneLineSummary"] == "神经网络从样本中学习。"
    assert result.json()["videoTitle"] == "YouTube video aircAruvnKk"
    assert result.json()["durationMs"] == 1500
    assert result.json()["isGenerated"] is False
    assert result.json()["transcript"] == [
        {
            "id": result.json()["transcript"][0]["id"],
            "startMs": 0,
            "durationMs": 1500,
            "original": "Hello world",
            "translated": "你好，世界",
        }
    ]


@pytest.mark.asyncio
async def test_translation_failure_returns_original_transcript(api_context):
    client, _, factory, _ = api_context
    created = await client.post(
        "/v1/analyses",
        json={
            "videoId": "aircAruvnKk",
            "sourceLanguage": "en",
            "targetLanguage": "zh-Hans",
            "llmConfig": LLM_CONFIG,
        },
    )
    job_id = created.json()["jobId"]

    from app.db.models import AnalysisJob

    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        version = job.transcript_version
        job.status = "failed"
        job.failure_code = "translation_failed"
        track = TranscriptTrack(
            video_id=job.video_id,
            language_code="en",
            language_name="English",
            is_generated=True,
            is_translatable=True,
            transcript_version=version,
        )
        track.segments = [
            StoredTranscriptSegment(
                sequence=0,
                start_ms=0,
                duration_ms=1500,
                text="Hello world",
            )
        ]
        session.add(track)
        await session.commit()

    result = await client.get(f"/v1/analyses/{job_id}/result")

    assert result.status_code == 200
    assert result.json()["partial"] is True
    assert result.json()["failureCode"] == "translation_failed"
    assert result.json()["isGenerated"] is True
    assert result.json()["transcript"][0]["original"] == "Hello world"
    assert result.json()["transcript"][0]["translated"] is None


@pytest.mark.asyncio
async def test_result_returns_summary_while_translation_is_still_running(api_context):
    client, _, factory, _ = api_context
    created = await client.post(
        "/v1/analyses",
        json={
            "videoId": "aircAruvnKk",
            "sourceLanguage": "en",
            "targetLanguage": "zh-Hans",
            "llmConfig": LLM_CONFIG,
        },
    )
    job_id = created.json()["jobId"]

    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        version = job.transcript_version
        job.status = "translating"
        job.result = AnalysisResult(
            one_line_summary="视频介绍了神经网络的输入层。",
            summary_points=["像素输入", "权重连接", "逐层计算"],
            chapters=[
                {"start_ms": 0, "end_ms": 1500, "title": "输入", "summary": "像素"}
            ],
            highlights=[],
            model_name="fake",
            model_version="test",
        )
        track = TranscriptTrack(
            video_id=job.video_id,
            language_code="en",
            language_name="English",
            is_generated=False,
            is_translatable=True,
            transcript_version=version,
        )
        track.segments = [
            StoredTranscriptSegment(
                sequence=0,
                start_ms=0,
                duration_ms=1500,
                text="Hello world",
            )
        ]
        session.add(track)
        await session.commit()

    result = await client.get(f"/v1/analyses/{job_id}/result")

    assert result.status_code == 200
    assert result.json()["partial"] is True
    assert result.json()["failureCode"] is None
    assert result.json()["oneLineSummary"] == "视频介绍了神经网络的输入层。"
    assert result.json()["transcript"][0]["translated"] is None


@pytest.mark.asyncio
async def test_pipeline_revision_change_creates_a_new_job(api_context):
    client, app, factory, dispatched = api_context
    payload = {
        "videoId": "aircAruvnKk",
        "sourceLanguage": "en",
        "targetLanguage": "zh-Hans",
        "llmConfig": LLM_CONFIG,
    }
    first = await client.post("/v1/analyses", json=payload)
    async with factory() as session:
        first_job = await session.get(AnalysisJob, first.json()["jobId"])
        first_job.status = "completed"
        first_job.completed_at = datetime.now(timezone.utc)
        await session.commit()
    app.dependency_overrides[get_pipeline_revision] = lambda: "next-pipeline"

    second = await client.post("/v1/analyses", json=payload)

    assert second.status_code == 202
    assert second.json()["jobId"] != first.json()["jobId"]
    assert dispatched == [first.json()["jobId"], second.json()["jobId"]]


@pytest.mark.asyncio
async def test_dispatch_failure_can_be_retried(api_context):
    client, app, factory, dispatched = api_context

    def fail_dispatch(_job_id):
        raise ConnectionError("redis unavailable")

    app.dependency_overrides[get_job_dispatcher] = lambda: fail_dispatch
    payload = {
        "videoId": "aircAruvnKk",
        "sourceLanguage": "en",
        "targetLanguage": "zh-Hans",
        "llmConfig": LLM_CONFIG,
    }
    failed = await client.post("/v1/analyses", json=payload)

    assert failed.status_code == 503
    assert failed.json()["detail"]["code"] == "dispatch_failed"
    async with factory() as session:
        job = await session.scalar(select(AnalysisJob))
        assert job.llm_credential_ciphertext is None
        assert job.llm_credential_expires_at is None
        assert job.failure_detail is None

    app.dependency_overrides[get_job_dispatcher] = lambda: dispatched.append
    retried = await client.post("/v1/analyses", json=payload)

    assert retried.status_code == 202
    assert dispatched == [retried.json()["jobId"]]


def test_dispatch_requires_a_live_celery_worker(monkeypatch):
    monkeypatch.setattr("app.workers.tasks.celery_app.control.ping", lambda timeout: [])

    with pytest.raises(WorkerUnavailableError, match="Worker"):
        dispatch_analysis_job("aircAruvnKk")


@pytest.mark.asyncio
async def test_create_reports_when_the_background_worker_is_unavailable(api_context):
    client, app, factory, _ = api_context

    def unavailable_dispatcher(_job_id):
        raise WorkerUnavailableError("Worker is unavailable")

    app.dependency_overrides[get_job_dispatcher] = lambda: unavailable_dispatcher
    response = await client.post(
        "/v1/analyses",
        json={
            "videoId": "aircAruvnKk",
            "sourceLanguage": "en",
            "targetLanguage": "zh-Hans",
            "llmConfig": LLM_CONFIG,
        },
    )

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "worker_unavailable"
    async with factory() as session:
        job = await session.scalar(
            select(AnalysisJob).where(AnalysisJob.video_id == "aircAruvnKk")
        )
        assert job.status == "failed"
        assert job.failure_code == "worker_unavailable"
        assert job.llm_credential_ciphertext is None
        assert job.llm_credential_expires_at is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("dispatch_error", "failure_code"),
    [
        (WorkerUnavailableError("Worker is unavailable"), "worker_unavailable"),
        (ConnectionError("redis unavailable"), "dispatch_failed"),
    ],
)
async def test_x_create_dispatch_failure_expires_its_completed_upload(
    api_context, dispatch_error, failure_code
):
    client, app, factory, _ = api_context
    app.dependency_overrides[get_source_registry] = lambda: SourceRegistry(
        [FakeXAdapter()]
    )

    inspected = await client.post(
        "/v1/videos/inspect",
        json={
            "url": "https://x.com/example/status/2075545587093807111",
            "activeMediaIndex": 1,
        },
    )
    assert inspected.status_code == 200
    content_id = inspected.json()["contentId"]
    settings = app.dependency_overrides[get_settings]()
    directory_key = "88888888-8888-4888-8888-888888888888"
    upload_dir = Path(settings.media_temp_root) / directory_key
    upload_dir.mkdir(parents=True)
    (upload_dir / "media.mp4").write_bytes(b"media")
    (upload_dir / ".media.mp4.assembling").write_bytes(b"temporary")
    (upload_dir / "part-00000000.bin").write_bytes(b"part")
    async with factory() as session:
        session.add(
            MediaUploadSession(
                id="dispatch-upload",
                installation_id=INSTALLATION_ID,
                content_id=content_id,
                status="complete",
                expected_bytes=5,
                received_bytes=5,
                media_kind="mp4",
                part_count=1,
                part_size_bytes=5,
                directory_key=directory_key,
                expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
            )
        )
        await session.commit()

    def fail_dispatch(_job_id):
        raise dispatch_error

    app.dependency_overrides[get_job_dispatcher] = lambda: fail_dispatch
    response = await client.post(
        "/v1/analyses",
        json={
            "contentId": content_id,
            "sourceLanguage": "auto",
            "targetLanguage": "zh-Hans",
            "mediaSessionId": "dispatch-upload",
            "llmConfig": LLM_CONFIG,
        },
    )

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == failure_code
    async with factory() as session:
        job = await session.scalar(
            select(AnalysisJob).where(AnalysisJob.content_id == content_id)
        )
        upload = await session.get(MediaUploadSession, "dispatch-upload")
        assert job.status == "failed"
        assert job.failure_code == failure_code
        assert job.llm_credential_ciphertext is None
        assert job.llm_credential_expires_at is None
        assert upload.status == "expired"
        assert upload.received_bytes == 0
    assert not upload_dir.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("dispatch_error", "failure_code"),
    [
        (WorkerUnavailableError("Worker is unavailable"), "worker_unavailable"),
        (ConnectionError("redis unavailable"), "dispatch_failed"),
    ],
)
async def test_existing_job_dispatch_failure_expires_its_completed_upload(
    api_context, dispatch_error, failure_code
):
    client, app, factory, _ = api_context
    payload = {
        "videoId": "aircAruvnKk",
        "sourceLanguage": "en",
        "targetLanguage": "zh-Hans",
        "llmConfig": LLM_CONFIG,
    }
    created = await client.post("/v1/analyses", json=payload)
    job_id = created.json()["jobId"]
    settings = app.dependency_overrides[get_settings]()
    directory_key = "99999999-9999-4999-8999-999999999999"
    upload_dir = Path(settings.media_temp_root) / directory_key
    upload_dir.mkdir(parents=True)
    (upload_dir / "media.mp4").write_bytes(b"media")
    (upload_dir / ".temporary").write_bytes(b"temporary")
    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        upload = MediaUploadSession(
            id="existing-dispatch-upload",
            installation_id=job.installation_id,
            content_id=job.content_id,
            status="complete",
            expected_bytes=5,
            received_bytes=5,
            media_kind="mp4",
            part_count=1,
            part_size_bytes=5,
            directory_key=directory_key,
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        )
        job.status = "analyzing"
        job.media_session_id = upload.id
        job.lease_token = "active-worker-token"
        job.lease_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        session.add(upload)
        await session.commit()

    def fail_dispatch(_job_id):
        raise dispatch_error

    app.dependency_overrides[get_job_dispatcher] = lambda: fail_dispatch
    response = await client.post("/v1/analyses", json=payload)

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == failure_code
    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        upload = await session.get(MediaUploadSession, "existing-dispatch-upload")
        assert job.status == "failed"
        assert job.failure_code == failure_code
        assert job.llm_credential_ciphertext is None
        assert job.llm_credential_expires_at is None
        assert job.lease_token is None
        assert job.lease_expires_at is None
        assert upload.status == "expired"
        assert upload.received_bytes == 0
    assert not upload_dir.exists()


@pytest.mark.asyncio
async def test_dispatch_failure_does_not_revoke_a_concurrent_worker_lease(
    api_context, monkeypatch
):
    client, app, factory, _ = api_context
    payload = {
        "videoId": "aircAruvnKk",
        "sourceLanguage": "en",
        "targetLanguage": "zh-Hans",
        "llmConfig": LLM_CONFIG,
    }
    created = await client.post("/v1/analyses", json=payload)
    job_id = created.json()["jobId"]
    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        job.status = "analyzing"
        job.lease_token = "expired-worker-token"
        job.lease_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        await session.commit()

    original_fail_dispatch = analyses_api._fail_dispatch

    async def claim_before_cleanup(session, settings, job, failure_code):
        async with factory() as worker_session:
            claim = await claim_job_lease(
                worker_session, job.id, resume=True, lease_seconds=60
            )
        assert claim.token is not None
        await original_fail_dispatch(session, settings, job, failure_code)

    monkeypatch.setattr(analyses_api, "_fail_dispatch", claim_before_cleanup)

    def fail_dispatch(_job_id):
        raise ConnectionError("broker unavailable")

    app.dependency_overrides[get_job_dispatcher] = lambda: fail_dispatch
    response = await client.post("/v1/analyses", json=payload)

    assert response.status_code == 503
    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        assert job.status == "queued"
        assert job.lease_token is not None
        assert job.failure_code is None


@pytest.mark.asyncio
async def test_dispatch_cleanup_storage_failure_preserves_error_and_retries_later(
    api_context, monkeypatch
):
    client, app, factory, _ = api_context
    app.dependency_overrides[get_source_registry] = lambda: SourceRegistry(
        [FakeXAdapter()]
    )
    inspected = await client.post(
        "/v1/videos/inspect",
        json={
            "url": "https://x.com/example/status/2075545587093807111",
            "activeMediaIndex": 1,
        },
    )
    content_id = inspected.json()["contentId"]
    settings = app.dependency_overrides[get_settings]()
    directory_key = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    upload_dir = Path(settings.media_temp_root) / directory_key
    upload_dir.mkdir(parents=True)
    (upload_dir / "media.mp4").write_bytes(b"media")
    async with factory() as session:
        session.add(
            MediaUploadSession(
                id="retry-cleanup-upload",
                installation_id=INSTALLATION_ID,
                content_id=content_id,
                status="complete",
                expected_bytes=5,
                received_bytes=5,
                media_kind="mp4",
                part_count=1,
                part_size_bytes=5,
                directory_key=directory_key,
                expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
            )
        )
        await session.commit()

    def fail_dispatch(_job_id):
        raise ConnectionError("redis unavailable")

    def fail_cleanup(*_args):
        raise OSError("storage offline")

    app.dependency_overrides[get_job_dispatcher] = lambda: fail_dispatch
    with monkeypatch.context() as cleanup_patch:
        cleanup_patch.setattr(
            media_upload_service, "_remove_session_directory_sync", fail_cleanup
        )
        try:
            response = await client.post(
                "/v1/analyses",
                json={
                    "contentId": content_id,
                    "sourceLanguage": "auto",
                    "targetLanguage": "zh-Hans",
                    "mediaSessionId": "retry-cleanup-upload",
                    "llmConfig": LLM_CONFIG,
                },
            )
        except media_upload_service.MediaUploadError:
            pytest.fail("cleanup failure replaced the dispatch failure response")

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "dispatch_failed"
    async with factory() as session:
        job = await session.scalar(
            select(AnalysisJob).where(AnalysisJob.content_id == content_id)
        )
        upload = await session.get(MediaUploadSession, "retry-cleanup-upload")
        assert job.status == "failed"
        assert job.llm_credential_ciphertext is None
        assert upload.status == "complete"
        expires_at = upload.expires_at
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        assert expires_at <= datetime.now(timezone.utc)
        assert upload_dir.is_dir()
        assert await media_upload_service.cleanup_expired_uploads(
            session, settings
        ) == {"processed": 1, "expired": 1, "failed": 0}

    assert not upload_dir.exists()
