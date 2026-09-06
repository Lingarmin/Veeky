from __future__ import annotations

import asyncio
import threading
import time
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

import app.api.analyses as analyses_api
import app.services.job_lease as job_lease
import app.services.media_upload as media_upload
from app.db.models import AnalysisJob, MediaUploadSession, TranscriptTrack
from app.services.job_lease import finish_owned_job, update_owned_job
from app.services.media_upload import cleanup_expired_uploads
from app.services.translation import provider_translation_version
from tests.test_x_pipeline import (
    INSTALLATION_ID,
    AnalysisPipeline,
    FakeAnalysis,
    FakeAudioExtractor,
    FakeDownloader,
    FakeTranscriber,
    FakeTranslation,
    make_pipeline,
    x_context,
)


class WorkerStopped(BaseException):
    pass


class CountingTranscriber(FakeTranscriber):
    def __init__(self):
        super().__init__()
        self.calls = 0

    def transcribe(self, audio_path):
        self.calls += 1
        return super().transcribe(audio_path)


class CountingAnalysis(FakeAnalysis):
    def __init__(self):
        self.calls = 0

    async def analyze(self, *args, **kwargs):
        self.calls += 1
        return await super().analyze(*args, **kwargs)


class CountingTranslation(FakeTranslation):
    def __init__(self):
        super().__init__()
        self.calls = 0

    async def translate(self, *args, **kwargs):
        self.calls += 1
        return await super().translate(*args, **kwargs)


async def expire_lease(factory, job_id="job-x"):
    async with factory() as session:
        job = await session.get(AnalysisJob, job_id)
        job.lease_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        await session.commit()


@pytest.mark.asyncio
async def test_lost_lease_rolls_back_pending_worker_writes(x_context):
    factory, _, _, _ = x_context
    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        job.lease_token = "winner-token"
        job.lease_expires_at = datetime.now(timezone.utc) + timedelta(minutes=1)
        await session.commit()

    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        job.failure_detail = "stale worker write"
        changed = await update_owned_job(
            session,
            job.id,
            "loser-token",
            lease_seconds=30,
            values={"status": "analyzing"},
        )

    assert changed is False
    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        assert job.failure_detail is None


@pytest.mark.asyncio
async def test_terminal_job_rejects_updates_from_its_old_lease(x_context):
    factory, _, _, _ = x_context
    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        job.status = "failed"
        job.lease_token = "old-worker-token"
        job.lease_expires_at = datetime.now(timezone.utc) + timedelta(minutes=1)
        await session.commit()

    async with factory() as session:
        changed = await update_owned_job(
            session,
            "job-x",
            "old-worker-token",
            lease_seconds=30,
            values={"status": "analyzing"},
        )

    assert changed is False
    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        assert job.status == "failed"


@pytest.mark.asyncio
async def test_expired_owner_cannot_commit_terminal_writes(x_context):
    factory, _, _, _ = x_context
    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        job.status = "analyzing"
        job.lease_token = "expired-worker-token"
        job.lease_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        await session.commit()

    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        job.failure_detail = "pending stale write"
        finished = await finish_owned_job(
            session,
            job.id,
            "expired-worker-token",
            values={"status": "completed"},
        )

    assert finished is False
    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        assert job.status == "analyzing"
        assert job.failure_detail is None
        assert job.lease_token == "expired-worker-token"


@pytest.mark.asyncio
async def test_lease_expiry_uses_database_time(x_context, monkeypatch):
    factory, _, _, _ = x_context

    class SkewedWorkerClock:
        @classmethod
        def now(cls, tz=None):
            return datetime(2099, 1, 1, tzinfo=timezone.utc)

    monkeypatch.setattr(job_lease, "datetime", SkewedWorkerClock)
    async with factory() as session:
        claim = await job_lease.claim_job_lease(
            session,
            "job-x",
            resume=False,
            lease_seconds=60,
        )
    assert claim.token is not None

    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        expires_at = job.lease_expires_at
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        assert expires_at < datetime.now(timezone.utc) + timedelta(minutes=2)


@pytest.mark.asyncio
async def test_duplicate_sqlite_delivery_returns_retry_without_duplicate_paid_calls(
    x_context,
):
    entered = asyncio.Event()
    release = asyncio.Event()

    class BlockingDownloader(FakeDownloader):
        def __init__(self):
            super().__init__()
            self.calls = 0

        async def download(self, url, destination):
            self.calls += 1
            entered.set()
            await release.wait()
            return await super().download(url, destination)

    downloader = BlockingDownloader()
    transcriber = CountingTranscriber()
    analysis = CountingAnalysis()
    translation = CountingTranslation()
    first = make_pipeline(
        x_context,
        downloader=downloader,
        transcriber=transcriber,
        analysis=analysis,
        translation=translation,
    )
    duplicate = make_pipeline(
        x_context,
        downloader=downloader,
        transcriber=transcriber,
        analysis=analysis,
        translation=translation,
    )

    running = asyncio.create_task(first.run("job-x"))
    await entered.wait()
    retry_at = await duplicate.run("job-x", resume=True)
    release.set()
    await running

    assert retry_at is not None
    assert retry_at > datetime.now(timezone.utc)
    assert downloader.calls == 1
    assert transcriber.calls == 1
    assert analysis.calls == 1
    assert translation.calls == 1


@pytest.mark.asyncio
async def test_active_worker_heartbeats_a_short_lease(x_context):
    entered = asyncio.Event()
    release = asyncio.Event()
    _, _, settings, _ = x_context
    settings.analysis_job_lease_seconds = 1

    class BlockingDownloader(FakeDownloader):
        async def download(self, url, destination):
            entered.set()
            await release.wait()
            return await super().download(url, destination)

    class MustNotDownload(FakeDownloader):
        async def download(self, url, destination):
            raise AssertionError("active lease was stolen")

    running = asyncio.create_task(
        make_pipeline(x_context, downloader=BlockingDownloader()).run("job-x")
    )
    await entered.wait()
    await asyncio.sleep(1.2)
    retry_at = await make_pipeline(
        x_context, downloader=MustNotDownload()
    ).run("job-x", resume=True)
    release.set()
    await running

    assert retry_at is not None
    assert retry_at > datetime.now(timezone.utc)


@pytest.mark.asyncio
async def test_heartbeat_lease_loss_cancels_the_running_pipeline(x_context):
    factory, _, settings, _ = x_context
    settings.analysis_job_lease_seconds = 1
    entered = asyncio.Event()
    cancelled = asyncio.Event()

    class BlockingDownloader(FakeDownloader):
        async def download(self, url, destination):
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                raise

    running = asyncio.create_task(
        make_pipeline(x_context, downloader=BlockingDownloader()).run("job-x")
    )
    await entered.wait()
    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        job.lease_token = "replacement-worker-token"
        job.lease_expires_at = datetime.now(timezone.utc) + timedelta(minutes=1)
        await session.commit()

    retry = await asyncio.wait_for(running, timeout=2)
    assert retry is not None
    assert retry.terminate_worker is False
    assert cancelled.is_set()


@pytest.mark.asyncio
async def test_heartbeat_database_failures_cancel_at_the_lease_deadline(
    x_context, monkeypatch
):
    _, _, settings, _ = x_context
    settings.analysis_job_lease_seconds = 1
    entered = asyncio.Event()
    cancelled = asyncio.Event()

    class BlockingDownloader(FakeDownloader):
        async def download(self, url, destination):
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                raise

    running = asyncio.create_task(
        make_pipeline(x_context, downloader=BlockingDownloader()).run("job-x")
    )
    await entered.wait()

    async def fail_renewal(*args, **kwargs):
        raise ConnectionError("database unavailable")

    monkeypatch.setattr("app.workers.tasks.update_owned_job", fail_renewal)

    retry = await asyncio.wait_for(running, timeout=2)
    assert retry is not None
    assert retry.terminate_worker is False
    assert cancelled.is_set()


@pytest.mark.asyncio
@pytest.mark.parametrize("lease_failure", ["stolen", "database"])
async def test_lease_loss_during_asr_requires_retry_and_worker_exit(
    x_context,
    monkeypatch,
    lease_failure,
):
    factory, _, settings, _ = x_context
    settings.analysis_job_lease_seconds = 1
    entered = threading.Event()
    release = threading.Event()

    class BlockingTranscriber(FakeTranscriber):
        def transcribe(self, audio_path):
            entered.set()
            release.wait(timeout=5)
            return super().transcribe(audio_path)

    running = asyncio.create_task(
        make_pipeline(x_context, transcriber=BlockingTranscriber()).run("job-x")
    )
    assert await asyncio.to_thread(entered.wait, 2)
    if lease_failure == "stolen":
        async with factory() as session:
            job = await session.get(AnalysisJob, "job-x")
            job.lease_token = "replacement-worker-token"
            job.lease_expires_at = datetime.now(timezone.utc) + timedelta(minutes=1)
            await session.commit()
    else:
        async def fail_renewal(*args, **kwargs):
            raise ConnectionError("database unavailable")

        monkeypatch.setattr("app.workers.tasks.update_owned_job", fail_renewal)

    retry = await asyncio.wait_for(running, timeout=2)
    release.set()

    assert retry is not None
    assert retry.terminate_worker is True


@pytest.mark.asyncio
async def test_lease_loss_during_artifact_hash_requires_worker_exit(
    x_context,
    monkeypatch,
):
    factory, _, settings, _ = x_context
    settings.analysis_job_lease_seconds = 1
    entered = threading.Event()
    release = threading.Event()
    finished = threading.Event()

    def blocking_hash(path):
        entered.set()
        release.wait(timeout=5)
        finished.set()
        return "a" * 64

    monkeypatch.setattr(
        AnalysisPipeline,
        "_sha256_file",
        staticmethod(blocking_hash),
    )
    running = asyncio.create_task(make_pipeline(x_context).run("job-x"))
    assert await asyncio.to_thread(entered.wait, 2)
    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        job.lease_token = "replacement-worker-token"
        job.lease_expires_at = datetime.now(timezone.utc) + timedelta(minutes=1)
        await session.commit()

    retry = await asyncio.wait_for(running, timeout=2)

    assert retry is not None
    assert retry.terminate_worker is True
    assert not finished.is_set()
    release.set()
    assert await asyncio.to_thread(finished.wait, 2)


@pytest.mark.asyncio
async def test_external_pipeline_cancellation_is_not_treated_as_lease_loss(x_context):
    entered = asyncio.Event()
    cancelled = asyncio.Event()

    class BlockingDownloader(FakeDownloader):
        async def download(self, url, destination):
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                raise

    running = asyncio.create_task(
        make_pipeline(x_context, downloader=BlockingDownloader()).run("job-x")
    )
    await entered.wait()
    running.cancel()

    with pytest.raises(asyncio.CancelledError):
        await running
    assert cancelled.is_set()


@pytest.mark.asyncio
async def test_expired_owner_cannot_persist_x_transcript(x_context):
    factory, _, settings, _ = x_context
    settings.analysis_job_lease_seconds = 1

    class NoHeartbeatPipeline(AnalysisPipeline):
        async def _heartbeat_lease(
            self,
            job_id,
            lease_token,
            owner_task,
            lease_lost,
            lease_deadline,
        ):
            await asyncio.Event().wait()

    class SlowTranscriber(FakeTranscriber):
        def transcribe(self, audio_path):
            time.sleep(1.1)
            return super().transcribe(audio_path)

    original = make_pipeline(x_context)
    pipeline = NoHeartbeatPipeline(
        original.session_factory,
        original.source_registry,
        original.translation_provider,
        original.analysis_service,
        credential_cipher=original.credential_cipher,
        media_downloader=original.media_downloader,
        audio_extractor=original.audio_extractor,
        transcriber=SlowTranscriber(),
        settings=settings,
    )
    await pipeline.run("job-x")

    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        assert job.status == "transcribing"
        assert await session.scalar(select(TranscriptTrack)) is None


@pytest.mark.asyncio
async def test_expired_lease_retries_encrypted_direct_url_after_download_loss(x_context):
    factory, _, _, _ = x_context

    class CrashDownloader(FakeDownloader):
        async def download(self, url, destination):
            raise WorkerStopped()

    with pytest.raises(WorkerStopped):
        await make_pipeline(x_context, downloader=CrashDownloader()).run("job-x")

    await expire_lease(factory)
    transcriber = CountingTranscriber()
    analysis = CountingAnalysis()
    await make_pipeline(
        x_context,
        downloader=FakeDownloader(),
        transcriber=transcriber,
        analysis=analysis,
    ).run("job-x", resume=True)

    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        assert job.status == "completed"
        assert job.lease_token is None
        assert job.lease_expires_at is None
    assert transcriber.calls == 1
    assert analysis.calls == 1


@pytest.mark.asyncio
async def test_expired_lease_reuses_consumed_upload_after_extraction_loss(
    x_context, monkeypatch
):
    factory, _, settings, media_root = x_context
    upload_dir = media_root / "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    upload_dir.mkdir()
    (upload_dir / "media.mp4").write_bytes(b"uploaded-media")
    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        job.status = "waiting_for_media"
        job.media_url_ciphertext = None
        upload = MediaUploadSession(
            id="recoverable-upload",
            installation_id=job.installation_id,
            content_id=job.content_id,
            status="complete",
            expected_bytes=14,
            received_bytes=14,
            media_kind="mp4",
            part_count=1,
            part_size_bytes=14,
            directory_key=upload_dir.name,
            expires_at=datetime.now(timezone.utc) + timedelta(seconds=1),
        )
        job.media_session_id = upload.id
        session.add(upload)
        await session.commit()

    class CrashExtractor(FakeAudioExtractor):
        async def extract(self, media_path, audio_path, **kwargs):
            raise WorkerStopped()

    with pytest.raises(WorkerStopped):
        await make_pipeline(x_context, extractor=CrashExtractor()).run(
            "job-x", resume=True
        )

    async with factory() as session:
        upload = await session.get(MediaUploadSession, "recoverable-upload")
        assert upload.status == "consumed"
        extended_expires_at = upload.expires_at
        if extended_expires_at.tzinfo is None:
            extended_expires_at = extended_expires_at.replace(tzinfo=timezone.utc)
        assert extended_expires_at > datetime.now(timezone.utc) + timedelta(minutes=2)

    cleanup_time = datetime.now(timezone.utc) + timedelta(minutes=2)
    monkeypatch.setattr(media_upload, "utc_now", lambda: cleanup_time)
    async with factory() as session:
        assert await cleanup_expired_uploads(session, settings) == {
            "processed": 0,
            "expired": 0,
            "failed": 0,
        }
    assert (upload_dir / "media.mp4").is_file()

    await expire_lease(factory)
    transcriber = CountingTranscriber()
    analysis = CountingAnalysis()
    await make_pipeline(
        x_context,
        extractor=FakeAudioExtractor(),
        transcriber=transcriber,
        analysis=analysis,
    ).run("job-x", resume=True)

    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        assert job.status == "completed"
    assert transcriber.calls == 1
    assert analysis.calls == 1
    assert not upload_dir.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("copy_error", "worker_crashed"),
    [(WorkerStopped(), True), (OSError("temporary copy failure"), False)],
)
async def test_redelivery_retries_copy_after_consumption_commit(
    x_context,
    copy_error,
    worker_crashed,
):
    factory, _, _, media_root = x_context
    upload_dir = media_root / "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    upload_dir.mkdir()
    (upload_dir / "media.mp4").write_bytes(b"uploaded-media")
    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        job.media_url_ciphertext = None
        upload = MediaUploadSession(
            id="copy-retry-upload",
            installation_id=INSTALLATION_ID,
            content_id=job.content_id,
            status="complete",
            expected_bytes=14,
            received_bytes=14,
            media_kind="mp4",
            part_count=1,
            part_size_bytes=14,
            directory_key=upload_dir.name,
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=1),
        )
        job.media_session_id = upload.id
        session.add(upload)
        await session.commit()

    original = make_pipeline(x_context)

    class CrashDuringCopy(AnalysisPipeline):
        @staticmethod
        def _copy_upload_artifact(*args, **kwargs):
            raise copy_error

    crashing = CrashDuringCopy(
        original.session_factory,
        original.source_registry,
        original.translation_provider,
        original.analysis_service,
        credential_cipher=original.credential_cipher,
        media_downloader=original.media_downloader,
        audio_extractor=original.audio_extractor,
        transcriber=original.transcriber,
        settings=original.settings,
    )

    if worker_crashed:
        with pytest.raises(WorkerStopped):
            await crashing.run("job-x")
    else:
        retry = await crashing.run("job-x")
        assert retry is not None
        assert retry.terminate_worker is False

    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        upload = await session.get(MediaUploadSession, "copy-retry-upload")
        assert job.status == "downloading_media"
        assert upload.status == "consumed"
        assert upload_dir.is_dir()

    await expire_lease(factory)
    assert await make_pipeline(x_context).run("job-x", resume=True) is None

    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        assert job.status == "completed"


@pytest.mark.asyncio
async def test_terminal_cleanup_is_not_cancelled_by_heartbeat(x_context):
    factory, _, settings, _ = x_context
    settings.analysis_job_lease_seconds = 1
    cleanup_started = asyncio.Event()
    release_cleanup = asyncio.Event()
    pipeline = make_pipeline(x_context)

    async def blocking_cleanup(job_id):
        cleanup_started.set()
        await release_cleanup.wait()

    pipeline._cleanup_consumed_upload = blocking_cleanup
    running = asyncio.create_task(pipeline.run("job-x"))
    await cleanup_started.wait()
    await asyncio.sleep(0.5)

    assert not running.done()
    release_cleanup.set()
    assert await asyncio.wait_for(running, timeout=1) is None
    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        assert job.status == "completed"
        assert job.lease_token is None


@pytest.mark.asyncio
async def test_expired_lease_reuses_persisted_transcript_without_media_or_asr(x_context):
    factory, cipher, settings, _ = x_context

    class CrashAfterTranscript(AnalysisPipeline):
        async def _acquire_x(self, job, *args, **kwargs):
            await super()._acquire_x(job, *args, **kwargs)
            raise WorkerStopped()

    pipeline = CrashAfterTranscript(
        factory,
        None,
        FakeTranslation(),
        FakeAnalysis(),
        credential_cipher=cipher,
        media_downloader=FakeDownloader(),
        audio_extractor=FakeAudioExtractor(),
        transcriber=FakeTranscriber(),
        settings=settings,
    )
    with pytest.raises(WorkerStopped):
        await pipeline.run("job-x")

    async with factory() as session:
        assert await session.scalar(select(TranscriptTrack)) is not None
    await expire_lease(factory)

    class MustNotRun:
        def __getattr__(self, name):
            raise AssertionError(f"media or ASR dependency accessed: {name}")

    analysis = CountingAnalysis()
    translation = CountingTranslation()
    await make_pipeline(
        x_context,
        downloader=MustNotRun(),
        extractor=MustNotRun(),
        transcriber=MustNotRun(),
        analysis=analysis,
        translation=translation,
    ).run("job-x", resume=True)

    assert analysis.calls == 1
    assert translation.calls == 1


@pytest.mark.asyncio
async def test_expired_lease_reuses_persisted_result_without_duplicate_analysis(
    x_context,
):
    factory, _, _, _ = x_context

    class CrashTranslation(FakeTranslation):
        async def translate(self, *args, **kwargs):
            raise WorkerStopped()

    analysis = CountingAnalysis()
    with pytest.raises(WorkerStopped):
        await make_pipeline(
            x_context, analysis=analysis, translation=CrashTranslation()
        ).run("job-x")

    await expire_lease(factory)

    class MustNotAnalyze(FakeAnalysis):
        async def analyze(self, *args, **kwargs):
            raise AssertionError("persisted analysis result was regenerated")

    translation = CountingTranslation()
    await make_pipeline(
        x_context, analysis=MustNotAnalyze(), translation=translation
    ).run("job-x", resume=True)

    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        assert job.status == "completed"
    assert analysis.calls == 1
    assert translation.calls == 1


@pytest.mark.asyncio
async def test_expired_lease_reuses_committed_translation_before_finalization(x_context):
    factory, _, _, _ = x_context

    class CrashBeforeComplete(AnalysisPipeline):
        async def _complete(self, *args, **kwargs):
            raise WorkerStopped()

    class MatchingTranslation(FakeTranslation):
        name = "kimi"
        version = provider_translation_version(
            "https://api.example.com/v1/chat/completions",
            provider="kimi",
            version="kimi-k2.5",
        )

    original = make_pipeline(x_context, translation=MatchingTranslation())
    crash = CrashBeforeComplete(
        original.session_factory,
        original.source_registry,
        original.translation_provider,
        original.analysis_service,
        credential_cipher=original.credential_cipher,
        media_downloader=original.media_downloader,
        audio_extractor=original.audio_extractor,
        transcriber=original.transcriber,
        settings=original.settings,
    )
    with pytest.raises(WorkerStopped):
        await crash.run("job-x")

    await expire_lease(factory)
    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        job.llm_credential_expires_at = datetime.now(timezone.utc) - timedelta(
            seconds=1
        )
        await session.commit()

    class MustNotAnalyze(FakeAnalysis):
        async def analyze(self, *args, **kwargs):
            raise AssertionError("analysis provider was called")

    class MustNotTranslate(FakeTranslation):
        async def translate(self, *args, **kwargs):
            raise AssertionError("translation provider was called")

    resumed = make_pipeline(
        x_context, analysis=MustNotAnalyze(), translation=MustNotTranslate()
    )
    resumed._uses_default_providers = True
    await resumed.run("job-x", resume=True)

    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        assert job.status == "completed"


@pytest.mark.asyncio
async def test_waiting_for_media_clears_unusable_session_for_a_new_upload(x_context):
    factory, _, _, media_root = x_context
    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        job.status = "waiting_for_media"
        job.media_url_ciphertext = None
        unusable = MediaUploadSession(
            id="failed-upload",
            installation_id=job.installation_id,
            content_id=job.content_id,
            status="failed",
            expected_bytes=5,
            received_bytes=5,
            media_kind="mp4",
            part_count=1,
            part_size_bytes=5,
            directory_key="cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        )
        job.media_session_id = unusable.id
        session.add(unusable)
        await session.commit()

    await make_pipeline(x_context).run("job-x", resume=True)

    upload_dir = media_root / "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    upload_dir.mkdir()
    (upload_dir / "media.mp4").write_bytes(b"media")
    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        replacement = MediaUploadSession(
            id="replacement-upload",
            installation_id=job.installation_id,
            content_id=job.content_id,
            status="complete",
            expected_bytes=5,
            received_bytes=5,
            media_kind="mp4",
            part_count=1,
            part_size_bytes=5,
            directory_key=upload_dir.name,
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        )
        session.add(replacement)
        await session.commit()
        assert job.status == "waiting_for_media"
        assert job.media_session_id is None
        assert job.lease_token is None
        assert (
            await analyses_api.attach_completed_upload_to_waiting_job(
                session, replacement.id, INSTALLATION_ID
            )
            == job.id
        )


@pytest.mark.asyncio
async def test_successful_direct_download_expires_unused_fallback_upload(x_context):
    factory, _, _, media_root = x_context
    upload_dir = media_root / "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
    upload_dir.mkdir()
    (upload_dir / "media.mp4").write_bytes(b"fallback")
    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        upload = MediaUploadSession(
            id="unused-fallback-upload",
            installation_id=job.installation_id,
            content_id=job.content_id,
            status="complete",
            expected_bytes=8,
            received_bytes=8,
            media_kind="mp4",
            part_count=1,
            part_size_bytes=8,
            directory_key=upload_dir.name,
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        )
        job.media_session_id = upload.id
        session.add(upload)
        await session.commit()

    await make_pipeline(x_context).run("job-x")

    async with factory() as session:
        upload = await session.get(MediaUploadSession, "unused-fallback-upload")
        assert upload.status == "expired"
        assert upload.received_bytes == 0
    assert not upload_dir.exists()
