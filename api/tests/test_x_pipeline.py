from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import selectinload

from app.core.settings import Settings
from app.db.models import (
    AnalysisJob,
    Base,
    Installation,
    MediaUploadSession,
    TranscriptTrack,
    Video,
)
from app.security.credentials import JobCredentialCipher
from app.services.analysis import AnalysisResult, Highlight, TimedSummary
from app.services.asr import AsrError
from app.services.media_download import MediaDownloadError
from app.services.transcripts import TranscriptSegment
from app.services.translation import TranslatedSegment, TranslationProviderError
from app.workers.tasks import (
    AnalysisPipeline,
    AudioExtractionError,
    FFmpegAudioExtractor,
)
import app.api.analyses as analyses_api


KEY = base64.b64encode(b"x" * 32).decode("ascii")
INSTALLATION_ID = "11111111-1111-4111-8111-111111111111"


class FakeDownloader:
    def __init__(self, error: Exception | None = None):
        self.error = error

    async def download(self, url: str, destination: Path) -> Path:
        if self.error:
            raise self.error
        destination.write_bytes(b"media")
        return destination


class FakeAudioExtractor:
    def __init__(self, *, duration_ms: int = 2000, error: Exception | None = None):
        self.duration_ms = duration_ms
        self.error = error

    async def probe_duration_ms(self, media_path: Path) -> int:
        return self.duration_ms

    async def extract(self, media_path: Path, audio_path: Path) -> Path:
        if self.error:
            raise self.error
        audio_path.write_bytes(b"audio")
        return audio_path


class FakeTranscriber:
    model_size = "small"
    version = "fake-asr-v1"

    def __init__(self, error: Exception | None = None):
        self.error = error

    def transcribe(self, audio_path: Path):
        if self.error:
            raise self.error
        return (
            [
                TranscriptSegment(0, 0, 1000, "Hello"),
                TranscriptSegment(1, 1000, 1000, "world"),
            ],
            "en",
        )


class FakeAnalysis:
    async def analyze(self, segments, target_language, *, duration_ms):
        return AnalysisResult(
            one_line_summary="Summary",
            summary_points=["One", "Two", "Three"],
            chapters=[
                TimedSummary(start_ms=0, end_ms=2000, title="Title", summary="Text")
            ],
            highlights=[
                Highlight(
                    start_ms=0,
                    end_ms=1000,
                    title="Title",
                    summary="Text",
                    original_excerpt="Hello",
                    translated_excerpt="你好",
                )
            ],
            model_name="fake-analysis",
            model_version="v1",
            generated_at=datetime.now(timezone.utc),
        )


class FakeTranslation:
    name = "fake-translation"
    version = "v1"

    def __init__(self, error: Exception | None = None):
        self.error = error

    async def translate(self, segments, source_language, target_language):
        if self.error:
            raise self.error
        return [
            TranslatedSegment(s.segment_id, s.start_ms, s.duration_ms, f"ZH:{s.text}")
            for s in segments
        ]


@pytest.fixture
async def x_context(tmp_path):
    media_root = tmp_path / "media"
    media_root.mkdir()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    cipher = JobCredentialCipher(KEY)
    async with factory() as session:
        installation = Installation(id=INSTALLATION_ID, token_hash="a" * 64)
        video = Video(
            video_id="x:2075545587093807111:1",
            platform="x",
            source_content_id="2075545587093807111",
            media_index=1,
            title="X fixture",
            duration_ms=1,
            source_url="https://x.com/i/status/2075545587093807111/video/1",
        )
        job = AnalysisJob(
            installation=installation,
            video=video,
            source_language="auto",
            target_language="zh-Hans",
            transcript_version="pending:job-x",
            cache_key=f"pending:{INSTALLATION_ID}:job-x",
            llm_config={"provider": "kimi"},
            llm_credential_ciphertext=cipher.encrypt("job-x", "llm-secret"),
            llm_credential_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
            media_url_ciphertext=cipher.encrypt(
                "job-x", "https://video.twimg.com/file.mp4?token=secret"
            ),
        )
        job.id = "job-x"
        session.add(job)
        await session.commit()
    settings = Settings(
        media_temp_root=str(media_root),
        max_media_bytes=1024,
        max_temp_bytes_per_job=2048,
        asr_job_timeout_seconds=30,
        llm_credential_encryption_key=KEY,
    )
    yield factory, cipher, settings, media_root
    await engine.dispose()


def make_pipeline(
    context,
    *,
    downloader=None,
    extractor=None,
    transcriber=None,
    translation=None,
    analysis=None,
):
    factory, cipher, settings, _ = context
    return AnalysisPipeline(
        factory,
        None,
        translation or FakeTranslation(),
        analysis or FakeAnalysis(),
        credential_cipher=cipher,
        media_downloader=downloader or FakeDownloader(),
        audio_extractor=extractor or FakeAudioExtractor(),
        transcriber=transcriber or FakeTranscriber(),
        settings=settings,
    )


@pytest.mark.asyncio
async def test_x_direct_media_runs_all_stages_and_persists_asr_identity(x_context):
    factory, _, _, media_root = x_context
    observed = []

    class ObservingDownloader(FakeDownloader):
        async def download(self, url, destination):
            observed.append(await _status(factory))
            return await super().download(url, destination)

    class ObservingExtractor(FakeAudioExtractor):
        async def extract(self, media_path, audio_path):
            observed.append(await _status(factory))
            return await super().extract(media_path, audio_path)

    class ObservingTranscriber(FakeTranscriber):
        def transcribe(self, audio_path):
            observed.append("transcribing")
            return super().transcribe(audio_path)

    class ObservingAnalysis(FakeAnalysis):
        async def analyze(self, *args, **kwargs):
            observed.append(await _status(factory))
            return await super().analyze(*args, **kwargs)

    class ObservingTranslation(FakeTranslation):
        async def translate(self, *args, **kwargs):
            observed.append(await _status(factory))
            return await super().translate(*args, **kwargs)

    await make_pipeline(
        x_context,
        downloader=ObservingDownloader(),
        extractor=ObservingExtractor(),
        transcriber=ObservingTranscriber(),
        analysis=ObservingAnalysis(),
        translation=ObservingTranslation(),
    ).run("job-x")

    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        track = await session.scalar(
            select(TranscriptTrack).options(selectinload(TranscriptTrack.segments))
        )
        assert job.status == "completed"
        assert job.source_language == "en"
        assert job.transcript_version == track.transcript_version
        assert job.cache_key.endswith(track.transcript_version)
        assert track.transcript_source == "faster_whisper"
        assert track.asr_model == "small"
        assert [s.text for s in track.segments] == ["Hello", "world"]
        assert "schema:x-asr-v1" in track.transcript_version
        assert "artifact:" in track.transcript_version
        assert "asr:" in track.transcript_version
        assert job.llm_credential_ciphertext is None
        assert job.media_url_ciphertext is None
    assert observed == [
        "downloading_media",
        "extracting_audio",
        "transcribing",
        "analyzing",
        "translating",
    ]
    assert not any(media_root.iterdir())


@pytest.mark.asyncio
async def test_expired_direct_candidate_waits_for_upload_and_retains_credential(
    x_context,
):
    factory, _, _, media_root = x_context
    await make_pipeline(
        x_context, downloader=FakeDownloader(MediaDownloadError("HTTP 403"))
    ).run("job-x")

    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        assert job.status == "waiting_for_media"
        assert job.completed_at is None
        assert job.llm_credential_ciphertext is not None
        assert job.llm_credential_expires_at is not None
        assert job.media_url_ciphertext is None
    assert not any(media_root.iterdir())


@pytest.mark.asyncio
async def test_completed_owned_upload_resumes_waiting_job_once(x_context):
    factory, _, settings, media_root = x_context
    upload_dir = media_root / "22222222-2222-4222-8222-222222222222"
    upload_dir.mkdir()
    (upload_dir / "media.mp4").write_bytes(b"uploaded-media")
    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        job.status = "waiting_for_media"
        job.media_url_ciphertext = None
        upload = MediaUploadSession(
            id="upload-x",
            installation_id=INSTALLATION_ID,
            content_id=job.content_id,
            status="complete",
            expected_bytes=14,
            received_bytes=14,
            media_kind="mp4",
            part_count=1,
            part_size_bytes=14,
            directory_key=upload_dir.name,
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        )
        job.media_session_id = upload.id
        session.add(upload)
        await session.commit()

    pipeline = make_pipeline(x_context)
    await pipeline.run("job-x", resume=True)
    await pipeline.run("job-x", resume=True)

    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        upload = await session.get(MediaUploadSession, "upload-x")
        assert job.status == "completed"
        assert upload.status == "consumed"
        assert job.llm_credential_ciphertext is None
    assert not upload_dir.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("dependency", "error", "code"),
    [
        (
            "extractor",
            AudioExtractionError("audio_track_missing", "no audio"),
            "audio_track_missing",
        ),
        (
            "transcriber",
            AsrError("asr_transcription_failed", "bad asr"),
            "asr_transcription_failed",
        ),
    ],
)
async def test_x_media_or_asr_failure_is_terminal_and_cleans_temp(
    x_context, dependency, error, code
):
    factory, _, _, media_root = x_context
    kwargs = {
        dependency: (
            FakeAudioExtractor(error=error)
            if dependency == "extractor"
            else FakeTranscriber(error)
        )
    }
    await make_pipeline(x_context, **kwargs).run("job-x")

    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        assert job.status == "failed"
        assert job.failure_code == code
        assert job.llm_credential_ciphertext is None
        assert job.media_url_ciphertext is None
    assert not any(media_root.iterdir())


@pytest.mark.asyncio
async def test_translation_failure_preserves_x_transcript_and_cleans_temp(x_context):
    factory, _, _, media_root = x_context
    error = TranslationProviderError("translation_unavailable", "offline")
    await make_pipeline(x_context, translation=FakeTranslation(error)).run("job-x")

    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        track = await session.scalar(select(TranscriptTrack))
        assert job.status == "failed"
        assert job.failure_code == "translation_failed"
        assert track is not None
        assert job.llm_credential_ciphertext is None
    assert not any(media_root.iterdir())


@pytest.mark.asyncio
async def test_matching_final_x_transcript_reuses_result_without_llm_calls(x_context):
    factory, cipher, _, _ = x_context
    await make_pipeline(x_context).run("job-x")
    async with factory() as session:
        first = await session.get(AnalysisJob, "job-x")
        second = AnalysisJob(
            id="job-x-2",
            installation_id=first.installation_id,
            video_id=first.video_id,
            content_id=first.content_id,
            source_language="auto",
            target_language=first.target_language,
            transcript_version="pending:job-x-2",
            cache_key=f"pending:{INSTALLATION_ID}:job-x-2",
            llm_config={"provider": "kimi"},
            llm_credential_ciphertext=cipher.encrypt("job-x-2", "secret"),
            llm_credential_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
            media_url_ciphertext=cipher.encrypt(
                "job-x-2", "https://video.twimg.com/file.mp4?token=new"
            ),
        )
        session.add(second)
        await session.commit()

    class MustNotAnalyze:
        async def analyze(self, *args, **kwargs):
            raise AssertionError("analysis provider was called")

    class MustNotTranslate(FakeTranslation):
        async def translate(self, *args, **kwargs):
            raise AssertionError("translation provider was called")

    pipeline = AnalysisPipeline(
        factory,
        None,
        MustNotTranslate(),
        MustNotAnalyze(),
        credential_cipher=cipher,
        media_downloader=FakeDownloader(),
        audio_extractor=FakeAudioExtractor(),
        transcriber=FakeTranscriber(),
        settings=x_context[2],
    )
    await pipeline.run("job-x-2")

    async with factory() as session:
        second = await session.scalar(
            select(AnalysisJob)
            .options(selectinload(AnalysisJob.result))
            .where(AnalysisJob.id == "job-x-2")
        )
        assert second.status == "completed"
        assert second.result.one_line_summary == "Summary"


async def _status(factory) -> str:
    async with factory() as session:
        return (await session.get(AnalysisJob, "job-x")).status


@pytest.mark.asyncio
async def test_completed_upload_attaches_only_to_owned_matching_waiting_job(x_context):
    factory, _, _, media_root = x_context
    upload_dir = media_root / "33333333-3333-4333-8333-333333333333"
    upload_dir.mkdir()
    (upload_dir / "media.mp4").write_bytes(b"media")
    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        job.status = "waiting_for_media"
        job.media_url_ciphertext = None
        upload = MediaUploadSession(
            id="matching-upload",
            installation_id=INSTALLATION_ID,
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
        session.add(upload)
        await session.commit()

        assert (
            await analyses_api.attach_completed_upload_to_waiting_job(
                session, "matching-upload", INSTALLATION_ID
            )
            == "job-x"
        )
        assert (
            await analyses_api.attach_completed_upload_to_waiting_job(
                session, "matching-upload", INSTALLATION_ID
            )
            is None
        )
        await session.refresh(job)
        assert job.media_session_id == "matching-upload"
        assert job.status == "queued"
        assert upload.status == "complete"


@pytest.mark.asyncio
async def test_ffmpeg_extractor_probes_exact_four_hours_and_extracts_pcm(tmp_path):
    media_root = tmp_path / "media"
    media_root.mkdir()
    media_path = media_root / "input.mp4"
    audio_path = media_root / "output.wav"
    media_path.write_bytes(b"media")
    calls = []

    async def runner(*arguments):
        calls.append(arguments)
        if arguments[0] == "ffmpeg":
            Path(arguments[-1]).write_bytes(b"wav")
            return type("Result", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        return type(
            "Result",
            (),
            {
                "returncode": 0,
                "stdout": '{"format":{"duration":"14400.000"}}',
                "stderr": "",
            },
        )()

    extractor = FFmpegAudioExtractor(
        str(media_root), timeout_seconds=10, max_bytes=100, runner=runner
    )

    assert await extractor.probe_duration_ms(media_path) == 14_400_000
    assert await extractor.extract(media_path, audio_path) == audio_path
    assert calls[1][:4] == ("ffmpeg", "-nostdin", "-v", "error")
    assert ("-ac", "1") == calls[1][calls[1].index("-ac") : calls[1].index("-ac") + 2]
    assert ("-ar", "16000") == calls[1][
        calls[1].index("-ar") : calls[1].index("-ar") + 2
    ]


@pytest.mark.asyncio
async def test_ffmpeg_extractor_maps_missing_audio_without_leaking_paths(tmp_path):
    media_root = tmp_path / "media"
    media_root.mkdir()
    media_path = media_root / "private-input.mp4"
    media_path.write_bytes(b"media")

    async def runner(*arguments):
        return type(
            "Result",
            (),
            {
                "returncode": 1,
                "stdout": "",
                "stderr": f"Stream map '0:a:0' matches no streams in {media_path}",
            },
        )()

    extractor = FFmpegAudioExtractor(
        str(media_root), timeout_seconds=10, max_bytes=100, runner=runner
    )
    with pytest.raises(AudioExtractionError) as raised:
        await extractor.extract(media_path, media_root / "output.wav")

    assert raised.value.code == "audio_track_missing"
    assert str(media_path) not in str(raised.value)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("duration_ms", "expected_status", "expected_code"),
    [
        (14_400_000, "completed", None),
        (14_400_001, "failed", "video_too_long"),
    ],
)
async def test_x_pipeline_uses_authoritative_four_hour_boundary(
    x_context, duration_ms, expected_status, expected_code
):
    factory, _, _, _ = x_context
    await make_pipeline(
        x_context, extractor=FakeAudioExtractor(duration_ms=duration_ms)
    ).run("job-x")

    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        assert job.status == expected_status
        assert job.failure_code == expected_code


@pytest.mark.asyncio
async def test_unexpected_x_failure_does_not_persist_signed_url_or_path(x_context):
    factory, _, _, media_root = x_context
    sensitive = "https://video.twimg.com/file.mp4?token=must-not-persist"

    class UnsafeFailureDownloader(FakeDownloader):
        async def download(self, url, destination):
            raise RuntimeError(f"failed {sensitive} at {destination}")

    with pytest.raises(RuntimeError):
        await make_pipeline(x_context, downloader=UnsafeFailureDownloader()).run(
            "job-x"
        )

    async with factory() as session:
        job = await session.get(AnalysisJob, "job-x")
        assert job.status == "failed"
        assert sensitive not in (job.failure_detail or "")
        assert str(media_root) not in (job.failure_detail or "")
