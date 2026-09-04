from __future__ import annotations

import asyncio
import base64
from datetime import datetime, timedelta, timezone

import pytest
from billiard.exceptions import SoftTimeLimitExceeded
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import selectinload

from app.db.models import (
    AnalysisJob,
    AnalysisResult as StoredAnalysisResult,
    Base,
    Installation,
    MediaUploadSession,
    TranscriptSegment as StoredSegment,
    Video,
)
from app.core.settings import Settings
from app.services.analysis import AnalysisSegment
from app.services.transcripts import (
    TranscriptInspection,
    TranscriptSegment,
    TranscriptTrackInfo,
    transcript_version,
)
from app.services.translation import TranslatedSegment, TranslationProviderError
from app.sources.base import ContentRef, SourceRegistry
from app.workers.tasks import (
    WORKER_TERMINATION_REQUIRED,
    AnalysisPipeline,
    analyze_video,
    build_llm_services,
    settings,
)
from app.security.credentials import JobCredentialCipher
from app.workers.tasks import clear_expired_llm_credentials_async
import app.workers.tasks as worker_tasks


VALID_TEST_KEY = base64.b64encode(b"v" * 32).decode("ascii")


def test_analysis_task_time_limits_derive_from_asr_job_timeout():
    assert analyze_video.soft_time_limit == settings.asr_job_timeout_seconds
    assert analyze_video.time_limit == settings.asr_job_timeout_seconds + 60


class FakeTranscriptService:
    def __init__(self, available=True):
        self.available = available
        self.calls = 0

    def inspect(self, video_id, preferred_languages=()):
        self.calls += 1
        if not self.available:
            return TranscriptInspection(
                video_id=video_id,
                tracks=[],
                available=False,
                failure_code="captions_disabled",
            )
        track = TranscriptTrackInfo("en", "English", False, True)
        return TranscriptInspection(
            video_id=video_id,
            tracks=[track],
            selected=track,
            segments=[
                TranscriptSegment(0, 0, 1000, "Pixels"),
                TranscriptSegment(1, 1000, 1000, "Weights"),
            ],
            available=True,
        )


class FakeTranslationProvider:
    name = "fake-translation"
    version = "test-1"

    def __init__(self, fails=False):
        self.fails = fails
        self.calls = 0

    async def translate(self, segments, source_language, target_language):
        self.calls += 1
        if self.fails:
            raise TranslationProviderError("translation_unavailable", "offline")
        return [
            TranslatedSegment(
                item.segment_id, item.start_ms, item.duration_ms, f"ZH:{item.text}"
            )
            for item in segments
        ]


class FakeAnalysisService:
    async def analyze(self, segments, target_language, *, duration_ms):
        from app.services.analysis import AnalysisResult, Highlight, TimedSummary
        from datetime import datetime, timezone

        assert all(isinstance(item, AnalysisSegment) for item in segments)
        return AnalysisResult(
            one_line_summary="神经网络从像素中学习。",
            summary_points=["像素进入输入层", "权重控制连接", "偏置调整激活"],
            chapters=[
                TimedSummary(start_ms=0, end_ms=2000, title="输入", summary="像素")
            ],
            highlights=[
                Highlight(
                    start_ms=1000,
                    end_ms=2000,
                    title="权重",
                    summary="连接强度",
                    original_excerpt="Weights",
                    translated_excerpt="ZH:Weights",
                )
            ],
            model_name="fake-analysis",
            model_version="test-1",
            generated_at=datetime.now(timezone.utc),
        )


@pytest.fixture
async def pipeline_context():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    transcript = FakeTranscriptService().inspect("aircAruvnKk").segments
    version = transcript_version(transcript)
    async with factory() as session:
        installation = Installation(
            id="11111111-1111-4111-8111-111111111111", token_hash="a" * 64
        )
        video = Video(
            video_id="aircAruvnKk",
            title="Neural networks",
            duration_ms=2000,
            source_url="https://www.youtube.com/watch?v=aircAruvnKk",
        )
        job = AnalysisJob(
            installation=installation,
            video=video,
            source_language="en",
            target_language="zh-Hans",
            transcript_version=version,
            cache_key=f"aircAruvnKk:en:zh-Hans:{version}:revision",
        )
        session.add(job)
        await session.commit()
        job_id = job.id
    yield factory, job_id
    await engine.dispose()


@pytest.mark.asyncio
async def test_pipeline_persists_transcript_translation_and_result(pipeline_context):
    factory, job_id = pipeline_context
    transcript_service = FakeTranscriptService()
    translation_provider = FakeTranslationProvider()
    pipeline = AnalysisPipeline(
        factory, transcript_service, translation_provider, FakeAnalysisService()
    )

    await pipeline.run(job_id)

    async with factory() as session:
        job = await session.scalar(
            select(AnalysisJob)
            .options(selectinload(AnalysisJob.result))
            .where(AnalysisJob.id == job_id)
        )
        segment_count = await session.scalar(
            select(func.count()).select_from(StoredSegment)
        )
        assert job.status == "completed"
        assert job.result.one_line_summary == "神经网络从像素中学习。"
        assert segment_count == 2
        assert job.llm_credential_ciphertext is None
        assert job.llm_credential_expires_at is None
    assert transcript_service.calls == 1
    assert translation_provider.calls == 1


@pytest.mark.asyncio
async def test_pipeline_resolves_youtube_adapter_before_transcript_acquisition(
    pipeline_context,
):
    factory, job_id = pipeline_context

    class FakeYouTubeAdapter:
        platform = "youtube"

        def __init__(self):
            self.refs = []

        def parse_url(self, url, active_media_index=None):
            return None

        async def acquire_transcript(self, ref, preferred_languages):
            self.refs.append(ref)
            return FakeTranscriptService().inspect(
                ref.source_content_id, preferred_languages
            )

    adapter = FakeYouTubeAdapter()
    pipeline = AnalysisPipeline(
        factory,
        SourceRegistry([adapter]),
        FakeTranslationProvider(),
        FakeAnalysisService(),
    )

    await pipeline.run(job_id)

    assert adapter.refs == [ContentRef("youtube", "aircAruvnKk")]


@pytest.mark.asyncio
async def test_pipeline_uses_kimi_providers_from_job_snapshot(pipeline_context):
    factory, job_id = pipeline_context
    translation_provider, analysis_service = build_llm_services(
        {"api_url": "https://api.example.com/v1", "api_key": "secret"}
    )

    assert translation_provider.name == "kimi"
    assert analysis_service.provider.name == "kimi"


@pytest.mark.asyncio
async def test_translation_failure_preserves_original_transcript(pipeline_context):
    factory, job_id = pipeline_context
    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        job.llm_credential_ciphertext = "temporary-ciphertext"
        job.llm_credential_expires_at = datetime.now(timezone.utc) + timedelta(hours=1)
        await session.commit()
    pipeline = AnalysisPipeline(
        factory,
        FakeTranscriptService(),
        FakeTranslationProvider(fails=True),
        FakeAnalysisService(),
    )

    await pipeline.run(job_id)

    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        segment_count = await session.scalar(
            select(func.count()).select_from(StoredSegment)
        )
        assert job.status == "failed"
        assert job.failure_code == "translation_failed"
        assert segment_count == 2
        assert job.llm_credential_ciphertext is None
        assert job.llm_credential_expires_at is None


@pytest.mark.asyncio
async def test_default_pipeline_fails_when_temporary_credentials_expired(
    pipeline_context,
):
    factory, job_id = pipeline_context
    cipher = JobCredentialCipher(VALID_TEST_KEY)
    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        job.llm_config = {
            "provider": "kimi",
            "api_url": "https://api.example.com/v1",
            "model": "kimi-k2.5",
        }
        job.llm_credential_ciphertext = cipher.encrypt(job.id, "secret")
        job.llm_credential_expires_at = datetime.now(timezone.utc) - timedelta(
            seconds=1
        )
        await session.commit()
    pipeline = AnalysisPipeline(
        factory,
        FakeTranscriptService(),
        FakeTranslationProvider(),
        FakeAnalysisService(),
        credential_cipher=cipher,
    )
    pipeline._uses_default_providers = True

    await pipeline.run(job_id)

    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        assert job.status == "failed"
        assert job.failure_code == "llm_credentials_expired"
        assert job.llm_credential_ciphertext is None
        assert job.llm_credential_expires_at is None


@pytest.mark.asyncio
async def test_default_pipeline_treats_invalid_ciphertext_as_expired_credentials(
    pipeline_context,
):
    factory, job_id = pipeline_context
    cipher = JobCredentialCipher(VALID_TEST_KEY)
    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        job.llm_config = {
            "provider": "kimi",
            "api_url": "https://api.example.com/v1",
            "model": "kimi-k2.5",
        }
        job.llm_credential_ciphertext = "invalid-ciphertext"
        job.llm_credential_expires_at = datetime.now(timezone.utc) + timedelta(hours=1)
        await session.commit()
    pipeline = AnalysisPipeline(
        factory,
        FakeTranscriptService(),
        FakeTranslationProvider(),
        FakeAnalysisService(),
        credential_cipher=cipher,
    )
    pipeline._uses_default_providers = True

    await pipeline.run(job_id)

    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        assert job.status == "failed"
        assert job.failure_code == "llm_credentials_expired"
        assert job.llm_credential_ciphertext is None
        assert job.llm_credential_expires_at is None


@pytest.mark.asyncio
async def test_expired_credential_cleanup_clears_only_expired_secrets(pipeline_context):
    factory, expired_job_id = pipeline_context
    async with factory() as session:
        expired = await session.get(AnalysisJob, expired_job_id)
        expired.status = "failed"
        expired.llm_credential_ciphertext = "expired"
        expired.media_url_ciphertext = "expired-media"
        expired.llm_credential_expires_at = datetime.now(timezone.utc) - timedelta(
            seconds=1
        )
        current = AnalysisJob(
            installation_id=expired.installation_id,
            video_id=expired.video_id,
            source_language="en",
            target_language="fr",
            transcript_version=expired.transcript_version,
            cache_key="current-credential",
            llm_credential_ciphertext="current",
            media_url_ciphertext="current-media",
            llm_credential_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        )
        session.add(current)
        await session.commit()
        current_job_id = current.id

    cleared = await clear_expired_llm_credentials_async(
        factory, now=datetime.now(timezone.utc)
    )

    assert cleared == 1
    async with factory() as session:
        expired = await session.get(AnalysisJob, expired_job_id)
        current = await session.get(AnalysisJob, current_job_id)
        assert expired.llm_credential_ciphertext is None
        assert expired.llm_credential_expires_at is None
        assert expired.media_url_ciphertext is None
        assert current.llm_credential_ciphertext == "current"
        assert current.media_url_ciphertext == "current-media"


@pytest.mark.asyncio
async def test_translation_failure_preserves_the_generated_summary(pipeline_context):
    factory, job_id = pipeline_context
    pipeline = AnalysisPipeline(
        factory,
        FakeTranscriptService(),
        FakeTranslationProvider(fails=True),
        FakeAnalysisService(),
    )

    await pipeline.run(job_id)

    async with factory() as session:
        job = await session.scalar(
            select(AnalysisJob)
            .options(selectinload(AnalysisJob.result))
            .where(AnalysisJob.id == job_id)
        )
        assert job.status == "failed"
        assert job.failure_code == "translation_failed"
        assert job.result.one_line_summary == "神经网络从像素中学习。"


def test_analyze_video_accepts_explicit_resume_without_serializing_media(monkeypatch):
    captured = {}

    async def fake_run(job_id, *, resume=False, lease_state=None):
        captured.update(job_id=job_id, resume=resume)

    monkeypatch.setattr("app.workers.tasks.run_analysis_task", fake_run)
    from app.workers.tasks import analyze_video

    analyze_video.run("job-id", resume=True)

    assert captured == {"job_id": "job-id", "resume": True}


def test_analyze_video_retries_when_another_worker_owns_the_lease(monkeypatch):
    retry_at = datetime.now(timezone.utc) + timedelta(seconds=30)
    captured = {}

    async def fake_run(job_id, *, resume=False, lease_state=None):
        return retry_at

    class RetryRequested(RuntimeError):
        pass

    def fake_retry(*, countdown, kwargs):
        captured["countdown"] = countdown
        captured["kwargs"] = kwargs
        raise RetryRequested()

    monkeypatch.setattr("app.workers.tasks.run_analysis_task", fake_run)
    monkeypatch.setattr(analyze_video, "retry", fake_retry)

    with pytest.raises(RetryRequested):
        analyze_video.run("job-id", resume=True)

    assert 1 <= captured["countdown"] <= 30
    assert captured["kwargs"] == {"resume": True}


def test_analyze_video_terminates_worker_after_pipeline_timeout(monkeypatch):
    async def fake_run(job_id, *, resume=False, lease_state=None):
        return WORKER_TERMINATION_REQUIRED

    class WorkerTerminated(BaseException):
        pass

    monkeypatch.setattr("app.workers.tasks.run_analysis_task", fake_run)
    monkeypatch.setattr("app.workers.tasks.WorkerTerminate", WorkerTerminated)

    with pytest.raises(WorkerTerminated):
        analyze_video.run("job-id")


@pytest.mark.parametrize("terminate_worker", [False, True])
def test_analyze_video_publishes_one_lease_retry_before_optional_worker_exit(
    monkeypatch,
    terminate_worker,
):
    retry_at = datetime.now(timezone.utc) + timedelta(seconds=30)
    retry_outcome = worker_tasks.TaskRetry(
        retry_at=retry_at,
        terminate_worker=terminate_worker,
    )
    retry_calls = []
    terminations = []

    async def fake_run(job_id, *, resume=False, lease_state=None):
        return retry_outcome

    class RetryRequested(RuntimeError):
        pass

    class WorkerTerminated(BaseException):
        pass

    def fake_retry(*, countdown, kwargs):
        retry_calls.append((countdown, kwargs))
        raise RetryRequested()

    def fake_terminate():
        terminations.append(True)
        raise WorkerTerminated()

    monkeypatch.setattr(worker_tasks, "run_analysis_task", fake_run)
    monkeypatch.setattr(analyze_video, "retry", fake_retry)
    monkeypatch.setattr(
        worker_tasks,
        "terminate_worker_child",
        fake_terminate,
        raising=False,
    )

    expected_exception = WorkerTerminated if terminate_worker else RetryRequested
    with pytest.raises(expected_exception):
        analyze_video.run("job-id")

    assert len(retry_calls) == (0 if terminate_worker else 1)
    if retry_calls:
        countdown, kwargs = retry_calls[0]
        assert 1 <= countdown <= 30
        assert kwargs == {"resume": True}
    assert terminations == ([True] if terminate_worker else [])
    assert len(retry_calls) + len(terminations) == 1


def test_analyze_video_recovers_when_soft_limit_escapes_asyncio_run(
    tmp_path, monkeypatch
):
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'soft-timeout.db'}"
    job_id = "soft-timeout-job"
    lease_token = "soft-timeout-lease"
    media_root = tmp_path / "media"
    upload_dir = media_root / "11111111-1111-4111-8111-111111111112"
    upload_dir.mkdir(parents=True)
    (upload_dir / "media.mp4").write_bytes(b"media")

    async def seed_job():
        engine = create_async_engine(database_url)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        async with factory() as session:
            installation = Installation(
                id="11111111-1111-4111-8111-111111111111",
                token_hash="a" * 64,
            )
            video = Video(
                video_id="aircAruvnKk",
                title="Soft timeout fixture",
                duration_ms=2000,
                source_url="https://www.youtube.com/watch?v=aircAruvnKk",
            )
            job = AnalysisJob(
                id=job_id,
                installation=installation,
                video=video,
                source_language="en",
                target_language="zh-Hans",
                transcript_version="soft-timeout-version",
                cache_key="soft-timeout-cache-key",
                status="analyzing",
                lease_token=lease_token,
                lease_expires_at=datetime.now(timezone.utc) + timedelta(minutes=1),
                llm_credential_ciphertext="encrypted-secret",
                llm_credential_expires_at=datetime.now(timezone.utc)
                + timedelta(minutes=1),
                media_url_ciphertext="encrypted-media-url",
            )
            upload = MediaUploadSession(
                id="soft-timeout-upload",
                installation=installation,
                content=video,
                status="consumed",
                expected_bytes=5,
                received_bytes=5,
                media_kind="mp4",
                part_count=1,
                part_size_bytes=5,
                directory_key=upload_dir.name,
                expires_at=datetime.now(timezone.utc) + timedelta(minutes=1),
            )
            job.media_session_id = upload.id
            session.add_all([job, upload])
            await session.commit()
        await engine.dispose()

    asyncio.run(seed_job())
    test_settings = Settings(
        database_url=database_url,
        media_temp_root=str(media_root),
    )
    monkeypatch.setattr(worker_tasks, "get_settings", lambda: test_settings)

    async def raise_soft_limit(job_id, *, resume=False, lease_state=None):
        if lease_state is not None:
            lease_state.token = lease_token
        await asyncio.sleep(0)
        raise SoftTimeLimitExceeded()

    class WorkerTerminated(BaseException):
        pass

    monkeypatch.setattr(worker_tasks, "run_analysis_task", raise_soft_limit)
    monkeypatch.setattr(worker_tasks, "WorkerTerminate", WorkerTerminated)

    with pytest.raises(WorkerTerminated):
        analyze_video.run(job_id)

    async def load_job():
        engine = create_async_engine(database_url)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        async with factory() as session:
            job = await session.get(AnalysisJob, job_id)
            upload = await session.get(MediaUploadSession, "soft-timeout-upload")
        await engine.dispose()
        return job, upload

    job, upload = asyncio.run(load_job())
    assert job.status == "failed"
    assert job.failure_code == "analysis_timeout"
    assert job.lease_token is None
    assert job.lease_expires_at is None
    assert job.llm_credential_ciphertext is None
    assert job.llm_credential_expires_at is None
    assert job.media_url_ciphertext is None
    assert upload.status == "expired"
    assert upload.received_bytes == 0
    assert not upload_dir.exists()


@pytest.mark.asyncio
async def test_retry_after_translation_failure_reuses_existing_analysis_result(
    pipeline_context,
):
    factory, job_id = pipeline_context
    pipeline = AnalysisPipeline(
        factory,
        FakeTranscriptService(),
        FakeTranslationProvider(fails=True),
        FakeAnalysisService(),
    )

    await pipeline.run(job_id)
    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        job.status = "queued"
        await session.commit()

    retry_pipeline = AnalysisPipeline(
        factory,
        FakeTranscriptService(),
        FakeTranslationProvider(),
        FakeAnalysisService(),
    )
    await retry_pipeline.run(job_id)

    async with factory() as session:
        job = await session.scalar(
            select(AnalysisJob)
            .options(selectinload(AnalysisJob.result))
            .where(AnalysisJob.id == job_id)
        )
        result_count = await session.scalar(
            select(func.count()).select_from(StoredAnalysisResult)
        )
        assert job.status == "completed"
        assert job.result.one_line_summary == "神经网络从像素中学习。"
        assert result_count == 1


@pytest.mark.asyncio
async def test_transcript_failure_does_not_create_result(pipeline_context):
    factory, job_id = pipeline_context
    pipeline = AnalysisPipeline(
        factory,
        FakeTranscriptService(available=False),
        FakeTranslationProvider(),
        FakeAnalysisService(),
    )

    await pipeline.run(job_id)

    async with factory() as session:
        job = await session.scalar(
            select(AnalysisJob)
            .options(selectinload(AnalysisJob.result))
            .where(AnalysisJob.id == job_id)
        )
        assert job.status == "failed"
        assert job.failure_code == "captions_disabled"
        assert job.result is None


@pytest.mark.asyncio
async def test_completed_job_is_idempotent(pipeline_context):
    factory, job_id = pipeline_context
    transcript_service = FakeTranscriptService()
    pipeline = AnalysisPipeline(
        factory, transcript_service, FakeTranslationProvider(), FakeAnalysisService()
    )

    await pipeline.run(job_id)
    await pipeline.run(job_id)

    assert transcript_service.calls == 1


@pytest.mark.asyncio
async def test_redelivered_in_progress_job_resumes(pipeline_context):
    factory, job_id = pipeline_context
    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        job.status = "fetching_transcript"
        await session.commit()
    pipeline = AnalysisPipeline(
        factory,
        FakeTranscriptService(),
        FakeTranslationProvider(),
        FakeAnalysisService(),
    )

    await pipeline.run(job_id, resume=True)

    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        assert job.status == "completed"


@pytest.mark.asyncio
async def test_changed_transcript_fails_before_persistence(pipeline_context):
    factory, job_id = pipeline_context
    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        job.transcript_version = "outdated-version"
        await session.commit()
    pipeline = AnalysisPipeline(
        factory,
        FakeTranscriptService(),
        FakeTranslationProvider(),
        FakeAnalysisService(),
    )

    await pipeline.run(job_id)

    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        segment_count = await session.scalar(
            select(func.count()).select_from(StoredSegment)
        )
        assert job.status == "failed"
        assert job.failure_code == "transcript_changed"
        assert segment_count == 0
