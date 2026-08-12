from __future__ import annotations

import asyncio
import base64
from collections.abc import AsyncIterator
from datetime import datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api.analyses import (
    WorkerUnavailableError,
    dispatch_analysis_job,
    get_job_dispatcher,
    get_pipeline_revision,
    get_job_credential_cipher,
    get_session,
    get_transcript_service,
)
from app.core.settings import Settings
from app.db.models import (
    AnalysisResult,
    AnalysisJob,
    Base,
    Installation,
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
from app.security.credentials import JobCredentialCipher


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


LLM_CONFIG = {"apiUrl": "https://api.example.com/v1", "apiKey": "test-key"}
VALID_TEST_KEY = base64.b64encode(b"v" * 32).decode("ascii")
INSTALLATION_ID = "11111111-1111-4111-8111-111111111111"
INSTALLATION_TOKEN = "installation-token-with-at-least-forty-three-characters"
AUTH_HEADERS = {
    "Authorization": f"Bearer {INSTALLATION_TOKEN}",
    "X-Veeky-Installation-Id": INSTALLATION_ID,
}
OTHER_INSTALLATION_ID = "22222222-2222-4222-8222-222222222222"
OTHER_INSTALLATION_TOKEN = "other-installation-token-with-at-least-forty-three-characters"
OTHER_AUTH_HEADERS = {
    "Authorization": f"Bearer {OTHER_INSTALLATION_TOKEN}",
    "X-Veeky-Installation-Id": OTHER_INSTALLATION_ID,
}


@pytest.fixture
async def api_context(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'api.sqlite'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    app = create_app(Settings(llm_credential_encryption_key=VALID_TEST_KEY))
    dispatched = []

    async def session_dependency() -> AsyncIterator[AsyncSession]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_session] = session_dependency
    app.dependency_overrides[get_transcript_service] = lambda: FakeTranscriptService()
    app.dependency_overrides[get_job_dispatcher] = lambda: dispatched.append
    app.dependency_overrides[get_job_credential_cipher] = lambda: JobCredentialCipher(
        VALID_TEST_KEY
    )

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
async def test_create_requires_llm_configuration(api_context):
    client, _, _, dispatched = api_context
    response = await client.post(
        "/v1/analyses",
        json={"videoId": "aircAruvnKk", "sourceLanguage": "en", "targetLanguage": "zh-Hans"},
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
        job = await session.get(__import__("app.db.models", fromlist=["AnalysisJob"]).AnalysisJob, first.json()["jobId"])
        job.status = "completed"
        await session.commit()

    completed = await client.post("/v1/analyses", json=payload)
    assert completed.status_code == 200
    assert completed.json()["cacheHit"] is True


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
    history_b = await client.get(
        "/v1/analyses/history", headers=OTHER_AUTH_HEADERS
    )

    assert [item["jobId"] for item in history_a.json()["items"]] == [job_a]
    assert [item["jobId"] for item in history_b.json()["items"]] == [job_b]
    for path in (f"/v1/analyses/{job_b}", f"/v1/analyses/{job_b}/result"):
        hidden = await client.get(path)
        assert hidden.status_code == 404
        assert hidden.json()["detail"]["code"] == "analysis_not_found"


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
    assert [item["jobId"] for item in second_page.json()["items"]] == [
        expected_ids[0]
    ]
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
    forced_twice = await client.post("/v1/analyses", json={**payload, "force": True})

    assert cached.status_code == 200
    assert cached.json()["jobId"] == original_id
    assert cached.json()["cacheHit"] is True
    assert forced_once.status_code == 202
    assert forced_twice.status_code == 202
    assert len({original_id, forced_once.json()["jobId"], forced_twice.json()["jobId"]}) == 3
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
    assert resumed.json() == {"jobId": job_id, "cacheHit": False, "status": "queued"}
    assert dispatched == [job_id, job_id]


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
            chapters=[{"start_ms": 0, "end_ms": 1500, "title": "输入", "summary": "像素"}],
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
    client, app, _, dispatched = api_context
    payload = {
        "videoId": "aircAruvnKk",
        "sourceLanguage": "en",
        "targetLanguage": "zh-Hans",
        "llmConfig": LLM_CONFIG,
    }
    first = await client.post("/v1/analyses", json=payload)
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

    app.dependency_overrides[get_job_dispatcher] = lambda: dispatched.append
    retried = await client.post("/v1/analyses", json=payload)

    assert retried.status_code == 202
    assert dispatched == [retried.json()["jobId"]]


def test_dispatch_requires_a_live_celery_worker(monkeypatch):
    monkeypatch.setattr(
        "app.workers.tasks.celery_app.control.ping", lambda timeout: []
    )

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
