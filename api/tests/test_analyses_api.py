from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api.analyses import (
    get_job_dispatcher,
    get_pipeline_revision,
    get_session,
    get_transcript_service,
)
from app.core.settings import Settings
from app.db.models import (
    AnalysisResult,
    Base,
    TranscriptSegment as StoredTranscriptSegment,
    TranscriptTrack,
    Translation,
)
from app.main import create_app
from app.services.transcripts import (
    TranscriptInspection,
    TranscriptSegment,
    TranscriptTrackInfo,
)


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


@pytest.fixture
async def api_context(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'api.sqlite'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    app = create_app(Settings())
    dispatched = []

    async def session_dependency() -> AsyncIterator[AsyncSession]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_session] = session_dependency
    app.dependency_overrides[get_transcript_service] = lambda: FakeTranscriptService()
    app.dependency_overrides[get_job_dispatcher] = lambda: dispatched.append

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield client, app, factory, dispatched

    await engine.dispose()


@pytest.mark.asyncio
async def test_inspect_rejects_non_youtube_url(api_context):
    client, _, _, _ = api_context
    response = await client.post("/v1/videos/inspect", json={"url": "https://example.com/watch?v=aircAruvnKk"})

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_youtube_url"


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
async def test_inspect_reports_no_caption_track(api_context):
    client, app, _, _ = api_context
    app.dependency_overrides[get_transcript_service] = lambda: FakeTranscriptService(False)

    response = await client.post(
        "/v1/videos/inspect", json={"url": "https://youtu.be/aircAruvnKk"}
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "no_caption_track"


@pytest.mark.asyncio
async def test_create_reuses_active_and_completed_jobs(api_context):
    client, _, factory, dispatched = api_context
    payload = {
        "videoId": "aircAruvnKk",
        "sourceLanguage": "en",
        "targetLanguage": "zh-Hans",
        "title": "But what is a neural network?",
    }
    first = await client.post("/v1/analyses", json=payload)
    second = await client.post("/v1/analyses", json=payload)

    assert first.status_code == 202
    assert second.status_code == 202
    assert second.json()["jobId"] == first.json()["jobId"]
    assert second.json()["cacheHit"] is False
    assert dispatched == [first.json()["jobId"]]

    async with factory() as session:
        job = await session.get(__import__("app.db.models", fromlist=["AnalysisJob"]).AnalysisJob, first.json()["jobId"])
        job.status = "completed"
        await session.commit()

    completed = await client.post("/v1/analyses", json=payload)
    assert completed.status_code == 200
    assert completed.json()["cacheHit"] is True


@pytest.mark.asyncio
async def test_concurrent_create_requests_reuse_one_job(api_context):
    client, _, _, dispatched = api_context
    payload = {
        "videoId": "aircAruvnKk",
        "sourceLanguage": "en",
        "targetLanguage": "zh-Hans",
    }

    first, second = await asyncio.gather(
        client.post("/v1/analyses", json=payload),
        client.post("/v1/analyses", json=payload),
    )

    assert {first.status_code, second.status_code} == {202}
    assert first.json()["jobId"] == second.json()["jobId"]
    assert dispatched == [first.json()["jobId"]]


@pytest.mark.asyncio
async def test_status_and_result_endpoints(api_context):
    client, _, factory, _ = api_context
    created = await client.post(
        "/v1/analyses",
        json={
            "videoId": "aircAruvnKk",
            "sourceLanguage": "en",
            "targetLanguage": "zh-Hans",
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
            chapters=[{"start_ms": 0, "end_ms": 1500, "title": "输入", "summary": "像素"}],
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
                provider="fake",
                provider_version="test",
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
async def test_pipeline_revision_change_creates_a_new_job(api_context):
    client, app, _, dispatched = api_context
    payload = {
        "videoId": "aircAruvnKk",
        "sourceLanguage": "en",
        "targetLanguage": "zh-Hans",
    }
    first = await client.post("/v1/analyses", json=payload)
    app.dependency_overrides[get_pipeline_revision] = lambda: "next-pipeline"

    second = await client.post("/v1/analyses", json=payload)

    assert second.status_code == 202
    assert second.json()["jobId"] != first.json()["jobId"]
    assert dispatched == [first.json()["jobId"], second.json()["jobId"]]


@pytest.mark.asyncio
async def test_dispatch_failure_can_be_retried(api_context):
    client, app, _, dispatched = api_context

    def fail_dispatch(_job_id):
        raise ConnectionError("redis unavailable")

    app.dependency_overrides[get_job_dispatcher] = lambda: fail_dispatch
    payload = {
        "videoId": "aircAruvnKk",
        "sourceLanguage": "en",
        "targetLanguage": "zh-Hans",
    }
    failed = await client.post("/v1/analyses", json=payload)

    assert failed.status_code == 503
    assert failed.json()["detail"]["code"] == "dispatch_failed"

    app.dependency_overrides[get_job_dispatcher] = lambda: dispatched.append
    retried = await client.post("/v1/analyses", json=payload)

    assert retried.status_code == 202
    assert dispatched == [retried.json()["jobId"]]
