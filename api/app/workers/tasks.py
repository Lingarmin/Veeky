from __future__ import annotations

import asyncio
import binascii
import hashlib
import json
import math
import shutil
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from datetime import datetime, timedelta, timezone

import anyio
from billiard.exceptions import SoftTimeLimitExceeded
from celery import Celery
from celery.exceptions import WorkerTerminate
from cryptography.exceptions import InvalidTag
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import selectinload

from app.core.settings import get_settings
from app.db.models import (
    AnalysisJob,
    AnalysisResult as StoredAnalysisResult,
    TranscriptSegment as StoredTranscriptSegment,
    TranscriptTrack,
    Translation,
    MediaUploadSession,
    Video,
)
from app.services.asr import AsrError, get_default_transcriber
from app.services.media_download import MediaDownloadError, MediaDownloader
from app.services.analysis import (
    AnalysisGenerationError,
    AnalysisSegment,
    HttpAnalysisProvider,
    StructuredAnalysisService,
    LlmAnalysisProvider,
)
from app.services.llm import (
    build_llm_client,
    normalize_chat_completions_url,
    normalize_provider_config,
)
from app.services.job_lease import (
    JobLeaseClaim,
    claim_job_lease,
    finish_owned_job,
    timeout_job_delivery,
    update_owned_job,
)
from app.services.media_upload import expire_complete_upload_if_unreferenced
from app.services.transcripts import TranscriptService, transcript_version
from app.services.video_metadata import VideoMetadataService
from app.sources.base import ContentRef, SourceRegistry
from app.sources.youtube import YouTubeAdapter
from app.sources.x import XAdapter
from app.services.translation import (
    CachedTranslationService,
    LibreTranslateProvider,
    TranslatedSegment,
    TranslationCacheKey,
    TranslationProvider,
    TranslationProviderError,
    TranslationSegment,
    LlmTranslationProvider,
    provider_translation_version,
)
from app.security.credentials import JobCredentialCipher


class AudioExtractionError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class JobLeaseLost(RuntimeError):
    pass


STDERR_CAPTURE_LIMIT_BYTES = 64 * 1024
STDOUT_CAPTURE_LIMIT_BYTES = 64 * 1024
PCM_SAMPLE_RATE = 16_000
PCM_SAMPLE_WIDTH_BYTES = 2
WAV_HEADER_BYTES = 44
PCM_DURATION_TOLERANCE_MS = 100
CELERY_HARD_LIMIT_GRACE_SECONDS = 60
WORKER_TERMINATION_REQUIRED = "worker_termination_required"


@dataclass
class TaskLeaseState:
    token: str | None = None


class FFmpegAudioExtractor:
    def __init__(
        self,
        media_root: str,
        *,
        timeout_seconds: int,
        max_bytes: int,
        runner=None,
    ):
        self.media_root = Path(media_root).resolve()
        self.timeout_seconds = timeout_seconds
        self.max_bytes = max_bytes
        self.runner = runner or self._run_subprocess

    async def probe_duration_ms(self, media_path: Path) -> float:
        self._validate_path(media_path)
        process = await self.runner(
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(media_path),
        )
        if process.returncode:
            raise AudioExtractionError("media_probe_failed", "无法读取媒体时长")
        try:
            duration = float(json.loads(process.stdout)["format"]["duration"])
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            raise AudioExtractionError(
                "media_probe_failed", "无法读取媒体时长"
            ) from None
        if not math.isfinite(duration) or duration < 0:
            raise AudioExtractionError("media_probe_failed", "无法读取媒体时长")
        return duration * 1000

    async def extract(
        self,
        media_path: Path,
        audio_path: Path,
        *,
        expected_duration_ms: float | None = None,
    ) -> Path:
        self._validate_path(media_path)
        self._validate_path(audio_path)
        if (
            expected_duration_ms is not None
            and self._required_wav_bytes(expected_duration_ms) > self.max_bytes
        ):
            raise AudioExtractionError("media_too_large", "媒体文件过大")
        process = await self.runner(
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-i",
            str(media_path),
            "-map",
            "0:a:0",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-bitexact",
            "-fs",
            str(self.max_bytes),
            "-y",
            str(audio_path),
        )
        if process.returncode:
            stderr = process.stderr.lower()
            code = (
                "audio_track_missing"
                if any(
                    marker in stderr
                    for marker in (
                        "matches no streams",
                        "stream map",
                        "does not contain any stream",
                    )
                )
                else "audio_extraction_failed"
            )
            raise AudioExtractionError(
                code,
                "媒体没有可用音轨" if code == "audio_track_missing" else "音频提取失败",
            )
        if not audio_path.is_file() or audio_path.stat().st_size > self.max_bytes:
            raise AudioExtractionError("media_too_large", "媒体文件过大")
        if expected_duration_ms is not None:
            self._validate_wav_duration(audio_path, expected_duration_ms)
        return audio_path

    async def _run_subprocess(self, *arguments: str):
        process = None
        try:
            process = await asyncio.create_subprocess_exec(
                *arguments,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            assert process.stdout is not None
            assert process.stderr is not None
            stdout_task = asyncio.create_task(
                self._read_bounded(process.stdout, STDOUT_CAPTURE_LIMIT_BYTES)
            )
            stderr_task = asyncio.create_task(
                self._read_bounded(process.stderr, STDERR_CAPTURE_LIMIT_BYTES)
            )
            await asyncio.wait_for(process.wait(), timeout=self.timeout_seconds)
            stdout, stderr = await asyncio.gather(stdout_task, stderr_task)
        except TimeoutError:
            if process is not None and process.returncode is None:
                process.kill()
                await process.wait()
            if "stdout_task" in locals() and "stderr_task" in locals():
                await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)
            raise AudioExtractionError(
                "audio_extraction_timeout", "音频处理超时"
            ) from None
        except OSError:
            raise AudioExtractionError(
                "audio_extraction_failed", "音频提取失败"
            ) from None
        except asyncio.CancelledError:
            if process is not None and process.returncode is None:
                process.kill()
                await process.wait()
            if "stdout_task" in locals() and "stderr_task" in locals():
                await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)
            raise
        return SimpleNamespace(
            returncode=process.returncode,
            stdout=stdout.decode("utf-8", "replace"),
            stderr=stderr.decode("utf-8", "replace"),
        )

    @staticmethod
    async def _read_bounded(stream, limit: int) -> bytes:
        captured = bytearray()
        while chunk := await stream.read(64 * 1024):
            remaining = limit - len(captured)
            if remaining > 0:
                captured.extend(chunk[:remaining])
        return bytes(captured)

    @staticmethod
    def _required_wav_bytes(duration_ms: float) -> int:
        samples = math.ceil(duration_ms * PCM_SAMPLE_RATE / 1000)
        return WAV_HEADER_BYTES + samples * PCM_SAMPLE_WIDTH_BYTES

    @staticmethod
    def _validate_wav_duration(audio_path: Path, expected_duration_ms: float) -> None:
        try:
            import wave

            with wave.open(str(audio_path), "rb") as audio:
                if (
                    audio.getnchannels() != 1
                    or audio.getsampwidth() != PCM_SAMPLE_WIDTH_BYTES
                    or audio.getframerate() != PCM_SAMPLE_RATE
                ):
                    raise ValueError("unexpected PCM format")
                actual_duration_ms = audio.getnframes() * 1000 / audio.getframerate()
        except (OSError, EOFError, ValueError, wave.Error):
            raise AudioExtractionError(
                "audio_extraction_failed", "音频提取失败"
            ) from None
        if actual_duration_ms + PCM_DURATION_TOLERANCE_MS < expected_duration_ms:
            raise AudioExtractionError("audio_extraction_failed", "音频提取失败")

    def _validate_path(self, path: Path) -> None:
        resolved = path.resolve()
        if resolved != self.media_root and self.media_root not in resolved.parents:
            raise AudioExtractionError("unsafe_media_path", "媒体路径无效")


settings = get_settings()
celery_app = Celery(
    "youtube_preview", broker=settings.redis_url, backend=settings.redis_url
)
celery_app.conf.update(
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    task_track_started=True,
    beat_schedule={
        "clear-expired-llm-credentials": {
            "task": "maintenance.clear_expired_llm_credentials",
            "schedule": 600.0,
        }
    },
)


class SqlTranslationCache:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def get(self, key: TranslationCacheKey) -> list[TranslatedSegment] | None:
        translation = await self.session.scalar(
            select(Translation).where(
                Translation.track_id == key.track_id,
                Translation.target_language == key.target_language,
                Translation.transcript_version == key.transcript_version,
                Translation.provider == key.provider,
                Translation.provider_version == key.provider_version,
            )
        )
        if translation is None:
            return None
        return [TranslatedSegment(**segment) for segment in translation.segments]

    async def put(
        self, key: TranslationCacheKey, value: list[TranslatedSegment]
    ) -> None:
        self.session.add(
            Translation(
                track_id=key.track_id,
                target_language=key.target_language,
                provider=key.provider,
                provider_version=key.provider_version,
                transcript_version=key.transcript_version,
                segments=[
                    {
                        "segment_id": segment.segment_id,
                        "start_ms": segment.start_ms,
                        "duration_ms": segment.duration_ms,
                        "text": segment.text,
                    }
                    for segment in value
                ],
            )
        )


def build_llm_services(
    config: dict[str, str]
) -> tuple[TranslationProvider, StructuredAnalysisService]:
    client = build_llm_client(config)
    return LlmTranslationProvider(client), StructuredAnalysisService(
        LlmAnalysisProvider(client)
    )


class AnalysisPipeline:
    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        source_registry: SourceRegistry | TranscriptService,
        translation_provider: TranslationProvider,
        analysis_service: StructuredAnalysisService,
        credential_cipher: JobCredentialCipher | None = None,
        media_downloader=None,
        audio_extractor=None,
        transcriber=None,
        settings=None,
    ):
        self.session_factory = session_factory
        if isinstance(source_registry, SourceRegistry):
            self.source_registry = source_registry
        else:
            current = get_settings()
            self.source_registry = SourceRegistry(
                [
                    YouTubeAdapter(
                        source_registry,
                        VideoMetadataService(
                            proxy_url=current.youtube_transcript_proxy_url
                        ),
                        max_duration_seconds=current.max_video_duration_seconds,
                    )
                ]
            )
        self.translation_provider = translation_provider
        self.analysis_service = analysis_service
        self.credential_cipher = credential_cipher
        self.settings = settings or get_settings()
        self.media_downloader = media_downloader
        self.audio_extractor = audio_extractor
        self.transcriber = transcriber
        self._uses_default_providers = False
        self.lease_state: TaskLeaseState | None = None
        self._lease_released: asyncio.Event | None = None

    async def run(
        self, job_id: str, *, resume: bool = False
    ) -> datetime | str | None:
        loop = asyncio.get_running_loop()
        claim_started_at = loop.time()
        claim = await self._claim(job_id, resume=resume)
        if claim.retry_at is not None:
            return claim.retry_at
        if claim.token is None:
            return None
        lease_token = claim.token
        if self.lease_state is not None:
            self.lease_state.token = lease_token
        job = await self._load_claimed_job(job_id, lease_token)
        if job is None:
            return None
        owner_task = asyncio.current_task()
        assert owner_task is not None
        lease_lost = asyncio.Event()
        self._lease_released = asyncio.Event()
        lease_deadline = claim_started_at + self._lease_seconds
        heartbeat_task = asyncio.create_task(
            self._heartbeat_lease(
                job_id,
                lease_token,
                owner_task,
                lease_lost,
                lease_deadline,
            )
        )
        deadline = loop.time() + self.settings.asr_job_timeout_seconds
        translation_provider = self.translation_provider
        analysis_service = self.analysis_service
        try:
            track = await self._load_persisted_track(job)
            if (
                self._uses_default_providers
                and job.result is not None
                and track is not None
                and await self._translation_is_persisted(job, track)
            ):
                await self._complete(job_id, lease_token)
                return None
            if self._uses_default_providers:
                if not self._credential_is_current(job):
                    await self._fail(
                        job_id,
                        lease_token,
                        "llm_credentials_expired",
                        None,
                        expire_complete_upload=True,
                    )
                    return
                assert self.credential_cipher is not None
                try:
                    api_key = self.credential_cipher.decrypt(
                        job.id, job.llm_credential_ciphertext
                    )
                except (ValueError, binascii.Error, InvalidTag, UnicodeDecodeError):
                    await self._fail(
                        job_id,
                        lease_token,
                        "llm_credentials_expired",
                        None,
                        expire_complete_upload=True,
                    )
                    return
                provider_config = dict(job.llm_config or {})
                provider_config["api_key"] = api_key
                translation_provider, analysis_service = build_llm_services(
                    provider_config
                )
                api_key = ""
                provider_config.clear()

            if track is None:
                initial_status = (
                    "downloading_media"
                    if job.video.platform == "x"
                    else "fetching_transcript"
                )
                await self._set_status(job_id, lease_token, initial_status)
                acquired = (
                    await self._before_deadline(
                        self._acquire_x(job, lease_token), deadline
                    )
                    if job.video.platform == "x"
                    else await self._before_deadline(
                        self._acquire_youtube(job, lease_token), deadline
                    )
                )
                if acquired is None:
                    return None
                track, stored_segments, version = acquired
            else:
                stored_segments = list(track.segments)
                version = track.transcript_version

            if job.result is None:
                await self._set_status(job_id, lease_token, "analyzing")
                analysis_segments = [
                    AnalysisSegment(
                        segment_id=segment.id,
                        start_ms=segment.start_ms,
                        duration_ms=segment.duration_ms,
                        original=segment.text,
                    )
                    for segment in stored_segments
                ]
                result = await self._before_deadline(
                    analysis_service.analyze(
                        analysis_segments,
                        job.target_language,
                        duration_ms=job.video.duration_ms,
                    ),
                    deadline,
                )
                result_values = {
                    "one_line_summary": result.one_line_summary,
                    "summary_points": result.summary_points,
                    "chapters": [chapter.model_dump() for chapter in result.chapters],
                    "highlights": [
                        highlight.model_dump() for highlight in result.highlights
                    ],
                    "model_name": result.model_name,
                    "model_version": result.model_version,
                    "generated_at": result.generated_at,
                }
                await self._store_analysis_result(
                    job_id, lease_token, result_values
                )
            else:
                await self._set_status(job_id, lease_token, "translating")

            translation_inputs = [
                TranslationSegment(
                    segment_id=segment.id,
                    start_ms=segment.start_ms,
                    duration_ms=segment.duration_ms,
                    text=segment.text,
                )
                for segment in stored_segments
            ]
            async with self.session_factory() as session:
                if not await self._owns_lease(session, job_id, lease_token):
                    raise JobLeaseLost()
                cache = SqlTranslationCache(session)
                translation_service = CachedTranslationService(
                    translation_provider, cache
                )
                await self._before_deadline(
                    translation_service.translate(
                        track.id,
                        translation_inputs,
                        track.language_code,
                        job.target_language,
                        version,
                    ),
                    deadline,
                )
                if not await self._renew_owned_job(
                    session, job_id, lease_token, status="translating"
                ):
                    raise JobLeaseLost()
                await session.commit()
            await self._complete(job_id, lease_token)
        except asyncio.CancelledError:
            if lease_lost.is_set():
                return None
            raise
        except JobLeaseLost:
            return None
        except (TimeoutError, SoftTimeLimitExceeded):
            await self._fail(job_id, lease_token, "analysis_timeout", None)
            return WORKER_TERMINATION_REQUIRED
        except MediaDownloadError:
            await self._wait_for_media(job_id, lease_token)
        except (AudioExtractionError, AsrError) as error:
            failure_detail = (
                str(error)
                if isinstance(error, AudioExtractionError)
                and error.code == "video_too_long"
                else None
            )
            await self._fail(job_id, lease_token, error.code, failure_detail)
        except TranslationProviderError as error:
            await self._fail(
                job_id,
                lease_token,
                "translation_failed",
                None,
            )
        except AnalysisGenerationError as error:
            await self._fail(job_id, lease_token, error.code, None)
        except Exception as error:
            await self._fail(job_id, lease_token, "analysis_internal_error", None)
            raise
        finally:
            heartbeat_task.cancel()
            await asyncio.gather(heartbeat_task, return_exceptions=True)
            await self._cleanup_job_temp(job_id, lease_token)
        return None

    async def _acquire_youtube(self, job, lease_token: str):
        ref = ContentRef(
            platform=job.video.platform,
            source_content_id=job.video.source_content_id,
            media_index=job.video.media_index,
        )
        source_adapter = self.source_registry.adapter_for(ref.platform)
        inspection = await source_adapter.acquire_transcript(ref, [job.source_language])
        if not inspection.available:
            await self._fail(
                job.id,
                lease_token,
                inspection.failure_code or "transcript_unavailable",
                None,
            )
            return None
        if (
            inspection.selected is None
            or inspection.selected.language_code != job.source_language
        ):
            await self._fail(
                job.id, lease_token, "source_language_unavailable", None
            )
            return None

        version = transcript_version(inspection.segments)
        if version != job.transcript_version:
            await self._fail(
                job.id,
                lease_token,
                "transcript_changed",
                "YouTube captions changed after the task was created",
            )
            return None
        async with self.session_factory() as session:
            if not await self._owns_lease(session, job.id, lease_token):
                raise JobLeaseLost()
            track = await self._persist_transcript(
                session, job.video_id, inspection, version
            )
            stored_segments = list(track.segments)
            if not await self._renew_owned_job(
                session, job.id, lease_token, status="fetching_transcript"
            ):
                raise JobLeaseLost()
            await session.commit()
        return track, stored_segments, version

    async def _acquire_x(self, job, lease_token: str):
        root = Path(self.settings.media_temp_root).resolve()
        job_dir = root / f"job-{job.id}-{lease_token}"
        job_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        media_path = job_dir / "media.bin"
        uploaded_dir = None
        if job.media_url_ciphertext:
            if self.credential_cipher is None:
                raise MediaDownloadError("media candidate expired")
            try:
                media_url = self.credential_cipher.decrypt(
                    job.id, job.media_url_ciphertext
                )
            except (ValueError, binascii.Error, InvalidTag, UnicodeDecodeError):
                raise MediaDownloadError("media candidate expired") from None
            await self._set_status(job.id, lease_token, "downloading_media")
            downloader = self.media_downloader or MediaDownloader(
                max_bytes=self.settings.max_media_bytes,
                timeout_seconds=self.settings.media_download_timeout_seconds,
            )
            try:
                await downloader.download(media_url, media_path)
            except MediaDownloadError:
                await self._clear_media_candidate(job.id, lease_token)
                if not job.media_session_id:
                    raise
            media_url = ""
        if not media_path.exists():
            async with self.session_factory() as session:
                current = await session.scalar(
                    select(AnalysisJob)
                    .where(
                        AnalysisJob.id == job.id,
                        AnalysisJob.lease_token == lease_token,
                        AnalysisJob.lease_expires_at > func.now(),
                    )
                    .with_for_update()
                )
                if current is None:
                    raise JobLeaseLost()
                upload = await session.scalar(
                    select(MediaUploadSession)
                    .where(
                        MediaUploadSession.id == current.media_session_id,
                        MediaUploadSession.installation_id
                        == current.installation_id,
                        MediaUploadSession.content_id == current.content_id,
                        MediaUploadSession.status.in_(("complete", "consumed")),
                    )
                    .with_for_update()
                )
                if upload is None or (
                    upload.status == "complete"
                    and self._as_utc(upload.expires_at) <= datetime.now(timezone.utc)
                ):
                    raise MediaDownloadError("media upload required")
                uploaded_dir = root / upload.directory_key
                try:
                    await anyio.to_thread.run_sync(
                        self._copy_upload_artifact,
                        uploaded_dir,
                        upload.media_kind,
                        media_path,
                        self.settings.max_media_bytes,
                        abandon_on_cancel=True,
                    )
                except AudioExtractionError as error:
                    if error.code != "media_artifact_missing":
                        raise
                    raise MediaDownloadError("media upload required") from None
                upload.status = "consumed"
                now = datetime.now(timezone.utc)
                retention_seconds = max(
                    self.settings.media_upload_session_ttl_seconds,
                    self.settings.asr_job_timeout_seconds
                    + CELERY_HARD_LIMIT_GRACE_SECONDS
                    + self.settings.analysis_job_lease_seconds,
                )
                retained_until = now + timedelta(seconds=retention_seconds)
                if self._as_utc(upload.expires_at) < retained_until:
                    upload.expires_at = retained_until
                if not await update_owned_job(
                    session,
                    job.id,
                    lease_token,
                    lease_seconds=self._lease_seconds,
                    values={},
                ):
                    raise JobLeaseLost()
        media_size = media_path.stat().st_size
        if media_size > min(
            self.settings.max_media_bytes, self.settings.max_temp_bytes_per_job
        ):
            raise AudioExtractionError("media_too_large", "媒体文件过大")
        max_audio_bytes = self.settings.max_temp_bytes_per_job - media_size
        if max_audio_bytes <= 0:
            raise AudioExtractionError("media_too_large", "媒体文件过大")
        extractor = self.audio_extractor or FFmpegAudioExtractor(
            str(root),
            timeout_seconds=self.settings.asr_job_timeout_seconds,
            max_bytes=max_audio_bytes,
        )
        exact_duration_ms = await extractor.probe_duration_ms(media_path)
        if exact_duration_ms > self.settings.max_video_duration_seconds * 1000:
            duration_limit = self._format_duration_limit(
                self.settings.max_video_duration_seconds
            )
            raise AudioExtractionError(
                "video_too_long", f"视频时长不能超过 {duration_limit}"
            )
        duration_ms = round(exact_duration_ms)
        job.video.duration_ms = duration_ms
        await self._set_status(job.id, lease_token, "extracting_audio")
        audio_path = await extractor.extract(
            media_path,
            job_dir / "audio.wav",
            expected_duration_ms=exact_duration_ms,
        )
        if (
            media_size + audio_path.stat().st_size
            > self.settings.max_temp_bytes_per_job
        ):
            raise AudioExtractionError("media_too_large", "媒体文件过大")
        await self._set_status(job.id, lease_token, "transcribing")
        transcriber = self.transcriber or get_default_transcriber(
            settings=self.settings
        )
        segments, language = await anyio.to_thread.run_sync(
            transcriber.transcribe,
            audio_path,
            abandon_on_cancel=True,
        )
        artifact_hash = await anyio.to_thread.run_sync(
            self._sha256_file,
            media_path,
            abandon_on_cancel=True,
        )
        version = self._x_transcript_version(
            segments, artifact_hash, transcriber.version
        )
        async with self.session_factory() as session:
            current = await session.scalar(
                select(AnalysisJob)
                .options(selectinload(AnalysisJob.result))
                .where(
                    AnalysisJob.id == job.id,
                    AnalysisJob.lease_token == lease_token,
                    AnalysisJob.lease_expires_at > func.now(),
                )
                .with_for_update()
            )
            if current is None:
                raise JobLeaseLost()
            llm_cache_fingerprint = self._x_llm_cache_fingerprint(current.llm_config)
            final_cache_key = ":".join(
                (
                    current.installation_id,
                    current.content_id,
                    language,
                    current.target_language,
                    version,
                    llm_cache_fingerprint or f"uncacheable-{current.id}",
                )
            )
            cached = None
            if not current.force_run and llm_cache_fingerprint is not None:
                candidates = list(
                    await session.scalars(
                        select(AnalysisJob)
                        .options(selectinload(AnalysisJob.result))
                        .where(
                            AnalysisJob.id != current.id,
                            AnalysisJob.installation_id == current.installation_id,
                            AnalysisJob.content_id == current.content_id,
                            AnalysisJob.source_language == language,
                            AnalysisJob.target_language == current.target_language,
                            AnalysisJob.transcript_version == version,
                            AnalysisJob.status == "completed",
                        )
                    )
                )
                cached = next(
                    (
                        candidate
                        for candidate in candidates
                        if candidate.result is not None
                        and self._x_llm_cache_fingerprint(candidate.llm_config)
                        == llm_cache_fingerprint
                    ),
                    None,
                )
            if cached is not None and cached.result is not None:
                current.source_language = language
                current.transcript_version = version
                current.cache_key = f"{final_cache_key}:reuse:{current.id}"
                current.result = StoredAnalysisResult(
                    one_line_summary=cached.result.one_line_summary,
                    summary_points=cached.result.summary_points,
                    chapters=cached.result.chapters,
                    highlights=cached.result.highlights,
                    model_name=cached.result.model_name,
                    model_version=cached.result.model_version,
                    generated_at=cached.result.generated_at,
                )
                self._mark_lease_released()
                if not await finish_owned_job(
                    session,
                    current.id,
                    lease_token,
                    values={
                        "source_language": language,
                        "transcript_version": version,
                        "cache_key": f"{final_cache_key}:reuse:{current.id}",
                        "status": "completed",
                        "completed_at": datetime.now(timezone.utc),
                        "failure_code": None,
                        "failure_detail": None,
                        "llm_credential_ciphertext": None,
                        "llm_credential_expires_at": None,
                        "media_url_ciphertext": None,
                    },
                ):
                    raise JobLeaseLost()
                await self._cleanup_consumed_upload(job.id)
                await self._expire_complete_upload(job.id)
                return None
            current.source_language = language
            current.transcript_version = version
            current.cache_key = final_cache_key
            if current.force_run:
                current.cache_key += f":run:{current.id}"
            video = await session.get(Video, current.video_id)
            video.duration_ms = duration_ms
            inspection = type("Inspection", (), {})()
            inspection.selected = type(
                "Selected",
                (),
                {
                    "language_code": language,
                    "language_name": language,
                    "is_generated": True,
                    "is_translatable": False,
                },
            )()
            inspection.segments = segments
            track = await self._persist_transcript(
                session, current.video_id, inspection, version
            )
            track.transcript_source = "faster_whisper"
            track.asr_model = transcriber.model_size
            if not await update_owned_job(
                session,
                job.id,
                lease_token,
                lease_seconds=self._lease_seconds,
                values={"media_url_ciphertext": None},
            ):
                raise JobLeaseLost()
            stored_segments = list(track.segments)
        return track, stored_segments, version

    @staticmethod
    async def _before_deadline(awaitable, deadline: float):
        async with asyncio.timeout_at(deadline):
            return await awaitable

    @staticmethod
    def _format_duration_limit(seconds: int) -> str:
        hours, remainder = divmod(seconds, 3600)
        minutes, remaining_seconds = divmod(remainder, 60)
        parts = []
        if hours:
            parts.append(f"{hours} 小时")
        if minutes:
            parts.append(f"{minutes} 分钟")
        if remaining_seconds or not parts:
            parts.append(f"{remaining_seconds} 秒")
        return " ".join(parts)

    async def _set_status(
        self, job_id: str, lease_token: str, status: str
    ) -> None:
        async with self.session_factory() as session:
            if not await update_owned_job(
                session,
                job_id,
                lease_token,
                lease_seconds=self._lease_seconds,
                values={"status": status},
            ):
                raise JobLeaseLost()

    async def _clear_media_candidate(
        self, job_id: str, lease_token: str
    ) -> None:
        async with self.session_factory() as session:
            if not await update_owned_job(
                session,
                job_id,
                lease_token,
                lease_seconds=self._lease_seconds,
                values={"media_url_ciphertext": None},
            ):
                raise JobLeaseLost()

    async def _wait_for_media(self, job_id: str, lease_token: str) -> None:
        self._mark_lease_released()
        async with self.session_factory() as session:
            job = await session.scalar(
                select(AnalysisJob)
                .where(
                    AnalysisJob.id == job_id,
                    AnalysisJob.lease_token == lease_token,
                )
            )
            if job is None:
                return
            media_session_id = job.media_session_id
            if job.media_session_id:
                upload = await session.get(MediaUploadSession, job.media_session_id)
                if not await asyncio.to_thread(
                    self._upload_is_recoverable, job, upload
                ):
                    media_session_id = None
            await finish_owned_job(
                session,
                job_id,
                lease_token,
                values={
                    "status": "waiting_for_media",
                    "failure_code": None,
                    "failure_detail": None,
                    "completed_at": None,
                    "media_url_ciphertext": None,
                    "media_session_id": media_session_id,
                },
            )

    async def _complete(self, job_id: str, lease_token: str) -> None:
        self._mark_lease_released()
        async with self.session_factory() as session:
            if not await finish_owned_job(
                session,
                job_id,
                lease_token,
                values={
                    "status": "completed",
                    "completed_at": datetime.now(timezone.utc),
                    "failure_code": None,
                    "failure_detail": None,
                    "llm_credential_ciphertext": None,
                    "llm_credential_expires_at": None,
                    "media_url_ciphertext": None,
                },
            ):
                raise JobLeaseLost()
        await self._cleanup_consumed_upload(job_id)
        await self._expire_complete_upload(job_id)

    async def _cleanup_job_temp(self, job_id: str, lease_token: str) -> None:
        root = Path(self.settings.media_temp_root).resolve()
        await asyncio.to_thread(
            shutil.rmtree, root / f"job-{job_id}-{lease_token}", True
        )

    async def _cleanup_consumed_upload(self, job_id: str) -> None:
        async with self.session_factory() as session:
            job = await session.get(AnalysisJob, job_id)
            if job is None or not job.media_session_id:
                return
            upload = await session.get(MediaUploadSession, job.media_session_id)
            if upload is None or upload.status != "consumed":
                return
            directory = (
                Path(self.settings.media_temp_root).resolve() / upload.directory_key
            )
        await asyncio.to_thread(shutil.rmtree, directory, True)

    @staticmethod
    def _sha256_file(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
        return digest.hexdigest()

    @staticmethod
    def _copy_upload_artifact(
        directory: Path, kind: str, destination: Path, max_bytes: int
    ) -> None:
        if kind == "mp4":
            source = directory / "media.mp4"
            if not source.is_file():
                raise AudioExtractionError("media_artifact_missing", "媒体文件不存在")
            shutil.copyfile(source, destination)
            return
        try:
            part_numbers = json.loads((directory / "manifest.json").read_text())[
                "parts"
            ]
        except (OSError, KeyError, TypeError, json.JSONDecodeError):
            raise AudioExtractionError(
                "media_artifact_missing", "媒体文件不存在"
            ) from None
        total = 0
        with destination.open("xb") as output:
            for part_number in part_numbers:
                if type(part_number) is not int or part_number < 0:
                    raise AudioExtractionError(
                        "media_artifact_missing", "媒体文件不存在"
                    )
                part = directory / f"part-{part_number:08d}.bin"
                try:
                    with part.open("rb") as source:
                        while chunk := source.read(1024 * 1024):
                            total += len(chunk)
                            if total > max_bytes:
                                raise AudioExtractionError(
                                    "media_too_large", "媒体文件过大"
                                )
                            output.write(chunk)
                except FileNotFoundError:
                    raise AudioExtractionError(
                        "media_artifact_missing", "媒体文件不存在"
                    ) from None

    def _upload_is_recoverable(
        self, job: AnalysisJob, upload: MediaUploadSession | None
    ) -> bool:
        if (
            upload is None
            or upload.installation_id != job.installation_id
            or upload.content_id != job.content_id
            or upload.status not in {"complete", "consumed"}
        ):
            return False
        if (
            upload.status == "complete"
            and self._as_utc(upload.expires_at) <= datetime.now(timezone.utc)
        ):
            return False
        root = Path(self.settings.media_temp_root).resolve()
        directory = (root / upload.directory_key).resolve()
        if directory != root and root not in directory.parents:
            return False
        if upload.media_kind == "mp4":
            return (directory / "media.mp4").is_file()
        try:
            part_numbers = json.loads((directory / "manifest.json").read_text())[
                "parts"
            ]
        except (OSError, KeyError, TypeError, json.JSONDecodeError):
            return False
        return bool(part_numbers) and all(
            type(part_number) is int
            and part_number >= 0
            and (directory / f"part-{part_number:08d}.bin").is_file()
            for part_number in part_numbers
        )

    @staticmethod
    def _x_transcript_version(segments, artifact_hash, asr_version):
        body = json.dumps(
            [[s.sequence, s.start_ms, s.duration_ms, s.text] for s in segments],
            ensure_ascii=False,
            separators=(",", ":"),
        )
        return (
            "schema:x-asr-v1:artifact:"
            + artifact_hash[:16]
            + ":asr:"
            + hashlib.sha256(asr_version.encode()).hexdigest()[:16]
            + ":segments:"
            + hashlib.sha256(body.encode()).hexdigest()[:16]
        )

    @staticmethod
    def _x_llm_cache_fingerprint(config: dict[str, str] | None) -> str | None:
        if not config or not config.get("pipeline_revision"):
            return None
        try:
            normalized = normalize_provider_config(
                config.get("provider"),
                config["api_url"],
                "unused",
                config.get("model"),
            )
            endpoint = normalize_chat_completions_url(normalized.api_url)
        except (KeyError, ValueError):
            return None
        endpoint_fingerprint = hashlib.sha256(endpoint.encode()).hexdigest()
        identity = json.dumps(
            {
                "provider": normalized.provider,
                "model": normalized.model,
                "api_endpoint_fingerprint": endpoint_fingerprint,
                "pipeline_revision": config["pipeline_revision"],
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(identity.encode()).hexdigest()

    @property
    def _lease_seconds(self) -> float:
        return max(1.0, float(self.settings.analysis_job_lease_seconds))

    async def _heartbeat_lease(
        self,
        job_id: str,
        lease_token: str,
        owner_task: asyncio.Task,
        lease_lost: asyncio.Event,
        lease_deadline: float,
    ) -> None:
        interval = max(0.25, self._lease_seconds / 3)
        loop = asyncio.get_running_loop()
        while True:
            await asyncio.sleep(interval)
            renewal_started_at = loop.time()
            try:
                async with self.session_factory() as session:
                    renewed = await update_owned_job(
                        session,
                        job_id,
                        lease_token,
                        lease_seconds=self._lease_seconds,
                        values={},
                    )
            except asyncio.CancelledError:
                raise
            except Exception:
                if loop.time() < lease_deadline:
                    continue
                renewed = False
            if renewed:
                lease_deadline = renewal_started_at + self._lease_seconds
                continue
            if self._lease_released is not None and self._lease_released.is_set():
                return
            lease_lost.set()
            owner_task.cancel()
            return

    @staticmethod
    def _as_utc(value: datetime) -> datetime:
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    async def _claim(self, job_id: str, *, resume: bool) -> JobLeaseClaim:
        async with self.session_factory() as session:
            return await claim_job_lease(
                session,
                job_id,
                resume=resume,
                lease_seconds=self._lease_seconds,
            )

    async def _load_claimed_job(
        self, job_id: str, lease_token: str
    ) -> AnalysisJob | None:
        async with self.session_factory() as session:
            return await session.scalar(
                select(AnalysisJob)
                .options(
                    selectinload(AnalysisJob.video),
                    selectinload(AnalysisJob.result),
                )
                .where(
                    AnalysisJob.id == job_id,
                    AnalysisJob.lease_token == lease_token,
                    AnalysisJob.lease_expires_at > func.now(),
                )
            )

    async def _load_persisted_track(
        self, job: AnalysisJob
    ) -> TranscriptTrack | None:
        if job.transcript_version.startswith("pending:"):
            return None
        async with self.session_factory() as session:
            return await session.scalar(
                select(TranscriptTrack)
                .options(selectinload(TranscriptTrack.segments))
                .where(
                    TranscriptTrack.video_id == job.video_id,
                    TranscriptTrack.language_code == job.source_language,
                    TranscriptTrack.transcript_version == job.transcript_version,
                )
            )

    async def _translation_is_persisted(
        self, job: AnalysisJob, track: TranscriptTrack
    ) -> bool:
        config = job.llm_config or {}
        provider = config.get("provider")
        model = config.get("model")
        api_url = config.get("api_url")
        if not all(
            isinstance(value, str) and value
            for value in (provider, model, api_url)
        ):
            return False
        try:
            version = provider_translation_version(
                normalize_chat_completions_url(api_url),
                provider=provider,
                version=model,
            )
        except ValueError:
            return False
        async with self.session_factory() as session:
            return (
                await session.scalar(
                    select(Translation.id).where(
                        Translation.track_id == track.id,
                        Translation.target_language == job.target_language,
                        Translation.transcript_version == track.transcript_version,
                        Translation.provider == provider,
                        Translation.provider_version == version,
                    )
                )
                is not None
            )

    async def _owns_lease(
        self, session: AsyncSession, job_id: str, lease_token: str
    ) -> bool:
        return (
            await session.scalar(
                select(AnalysisJob.id).where(
                    AnalysisJob.id == job_id,
                    AnalysisJob.lease_token == lease_token,
                    AnalysisJob.lease_expires_at > func.now(),
                )
            )
            is not None
        )

    async def _renew_owned_job(
        self,
        session: AsyncSession,
        job_id: str,
        lease_token: str,
        *,
        status: str,
    ) -> bool:
        return await update_owned_job(
            session,
            job_id,
            lease_token,
            lease_seconds=self._lease_seconds,
            values={"status": status},
        )

    async def _store_analysis_result(
        self,
        job_id: str,
        lease_token: str,
        result_values: dict,
    ) -> None:
        async with self.session_factory() as session:
            job = await session.scalar(
                select(AnalysisJob)
                .options(selectinload(AnalysisJob.result))
                .where(
                    AnalysisJob.id == job_id,
                    AnalysisJob.lease_token == lease_token,
                    AnalysisJob.lease_expires_at > func.now(),
                )
                .with_for_update()
            )
            if job is None:
                raise JobLeaseLost()
            if job.result is None:
                job.result = StoredAnalysisResult(**result_values)
            else:
                for field, value in result_values.items():
                    setattr(job.result, field, value)
            if not await update_owned_job(
                session,
                job_id,
                lease_token,
                lease_seconds=self._lease_seconds,
                values={"status": "translating"},
            ):
                raise JobLeaseLost()

    async def _persist_transcript(self, session, video_id, inspection, version):
        selected = inspection.selected
        track = await session.scalar(
            select(TranscriptTrack)
            .options(selectinload(TranscriptTrack.segments))
            .where(
                TranscriptTrack.video_id == video_id,
                TranscriptTrack.language_code == selected.language_code,
                TranscriptTrack.is_generated == selected.is_generated,
                TranscriptTrack.transcript_version == version,
            )
        )
        if track is not None:
            return track
        track = TranscriptTrack(
            video_id=video_id,
            language_code=selected.language_code,
            language_name=selected.language_name,
            is_generated=selected.is_generated,
            is_translatable=selected.is_translatable,
            transcript_version=version,
        )
        track.segments = [
            StoredTranscriptSegment(
                sequence=segment.sequence,
                start_ms=segment.start_ms,
                duration_ms=segment.duration_ms,
                text=segment.text,
            )
            for segment in inspection.segments
        ]
        session.add(track)
        await session.flush()
        return track

    async def _fail(
        self,
        job_id: str,
        lease_token: str,
        failure_code: str,
        failure_detail: str | None,
        *,
        expire_complete_upload: bool = False,
    ) -> None:
        self._mark_lease_released()
        async with self.session_factory() as session:
            if not await finish_owned_job(
                session,
                job_id,
                lease_token,
                values={
                    "status": "failed",
                    "failure_code": failure_code,
                    "failure_detail": failure_detail,
                    "completed_at": datetime.now(timezone.utc),
                    "llm_credential_ciphertext": None,
                    "llm_credential_expires_at": None,
                    "media_url_ciphertext": None,
                },
            ):
                return
        if expire_complete_upload:
            await self._expire_complete_upload(job_id)
        await self._cleanup_consumed_upload(job_id)

    def _mark_lease_released(self) -> None:
        if self._lease_released is not None:
            self._lease_released.set()

    async def _expire_complete_upload(self, job_id: str) -> None:
        async with self.session_factory() as session:
            job = await session.get(AnalysisJob, job_id)
            if job is None or not job.media_session_id:
                return
            await expire_complete_upload_if_unreferenced(
                session,
                self.settings,
                session_id=job.media_session_id,
                installation_id=job.installation_id,
                content_id=job.content_id,
                excluding_job_id=job.id,
            )

    def _credential_is_current(self, job: AnalysisJob) -> bool:
        if (
            self.credential_cipher is None
            or not job.llm_config
            or not job.llm_credential_ciphertext
            or job.llm_credential_expires_at is None
        ):
            return False
        expires_at = job.llm_credential_expires_at
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        return expires_at > datetime.now(timezone.utc)

def build_default_pipeline(
    session_factory: async_sessionmaker[AsyncSession],
) -> AnalysisPipeline:
    current = get_settings()
    translation_key = (
        current.libretranslate_api_key.get_secret_value()
        if current.libretranslate_api_key
        else None
    )
    analysis_key = (
        current.analysis_provider_api_key.get_secret_value()
        if current.analysis_provider_api_key
        else None
    )
    translation_provider = LibreTranslateProvider(
        current.libretranslate_url,
        api_key=translation_key,
        version=current.libretranslate_version,
    )
    analysis_provider = HttpAnalysisProvider(
        current.analysis_provider_url,
        model=current.analysis_provider_model,
        api_key=analysis_key,
        version=(
            f"{current.analysis_provider_version}"
            f"+prompt.{current.analysis_prompt_version}"
        ),
    )
    pipeline = AnalysisPipeline(
        session_factory,
        SourceRegistry(
            [
                YouTubeAdapter(
                    TranscriptService(proxy_url=current.youtube_transcript_proxy_url),
                    VideoMetadataService(
                        proxy_url=current.youtube_transcript_proxy_url
                    ),
                    max_duration_seconds=current.max_video_duration_seconds,
                ),
                XAdapter(),
            ]
        ),
        translation_provider,
        StructuredAnalysisService(analysis_provider),
        credential_cipher=JobCredentialCipher(current.llm_credential_encryption_key),
    )
    pipeline._uses_default_providers = True
    return pipeline


async def run_analysis_task(
    job_id: str,
    *,
    resume: bool = False,
    lease_state: TaskLeaseState | None = None,
) -> datetime | str | None:
    current = get_settings()
    engine = create_async_engine(current.database_url, pool_pre_ping=True)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        pipeline = build_default_pipeline(session_factory)
        pipeline.lease_state = lease_state
        return await pipeline.run(job_id, resume=resume)
    finally:
        await engine.dispose()


async def recover_analysis_soft_timeout(
    job_id: str,
    lease_token: str | None,
) -> datetime | None:
    current = get_settings()
    engine = create_async_engine(current.database_url, pool_pre_ping=True)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with session_factory() as session:
            media_session_id, retry_at = await timeout_job_delivery(
                session, job_id, lease_token
            )
        if media_session_id is not None:
            await _cleanup_terminal_job_media(
                session_factory,
                current,
                job_id,
                media_session_id,
            )
        return retry_at
    finally:
        await engine.dispose()


async def _cleanup_terminal_job_media(
    session_factory: async_sessionmaker[AsyncSession],
    current,
    job_id: str,
    media_session_id: str,
) -> None:
    async with session_factory() as session:
        job = await session.get(AnalysisJob, job_id)
        upload = await session.get(MediaUploadSession, media_session_id)
        if job is None or upload is None:
            return
        if upload.status == "consumed":
            root = Path(current.media_temp_root).resolve()
            directory = (root / upload.directory_key).resolve()
            if directory != root and root not in directory.parents:
                return
        elif upload.status == "complete":
            await expire_complete_upload_if_unreferenced(
                session,
                current,
                session_id=upload.id,
                installation_id=job.installation_id,
                content_id=job.content_id,
                excluding_job_id=job.id,
            )
            return
        else:
            return
    await anyio.to_thread.run_sync(shutil.rmtree, directory, True)


async def clear_expired_llm_credentials_async(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    now: datetime | None = None,
) -> int:
    cutoff = now or datetime.now(timezone.utc)
    async with session_factory() as session:
        result = await session.execute(
            update(AnalysisJob)
            .where(
                AnalysisJob.llm_credential_ciphertext.is_not(None),
                AnalysisJob.llm_credential_expires_at.is_not(None),
                AnalysisJob.llm_credential_expires_at <= cutoff,
            )
            .values(
                llm_credential_ciphertext=None,
                llm_credential_expires_at=None,
                media_url_ciphertext=None,
            )
        )
        await session.commit()
        return result.rowcount


async def run_expired_credential_cleanup() -> int:
    current = get_settings()
    engine = create_async_engine(current.database_url, pool_pre_ping=True)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        return await clear_expired_llm_credentials_async(session_factory)
    finally:
        await engine.dispose()


@celery_app.task(
    bind=True,
    name="analysis.analyze_video",
    soft_time_limit=settings.asr_job_timeout_seconds,
    time_limit=settings.asr_job_timeout_seconds + CELERY_HARD_LIMIT_GRACE_SECONDS,
)
def analyze_video(task, job_id: str, *, resume: bool = False) -> None:
    delivery_info = task.request.delivery_info or {}
    lease_state = TaskLeaseState()
    try:
        retry_at = asyncio.run(
            run_analysis_task(
                job_id,
                resume=resume or bool(delivery_info.get("redelivered")),
                lease_state=lease_state,
            )
        )
    except SoftTimeLimitExceeded:
        retry_at = asyncio.run(
            recover_analysis_soft_timeout(job_id, lease_state.token)
        )
        if retry_at is not None:
            countdown = max(
                1,
                math.ceil(
                    (retry_at - datetime.now(timezone.utc)).total_seconds()
                ),
            )
            task.retry(countdown=countdown, kwargs={"resume": True})
        raise WorkerTerminate() from None
    if retry_at == WORKER_TERMINATION_REQUIRED:
        raise WorkerTerminate()
    if retry_at is not None:
        countdown = max(
            1,
            math.ceil(
                (retry_at - datetime.now(timezone.utc)).total_seconds()
            ),
        )
        task.retry(countdown=countdown, kwargs={"resume": True})


@celery_app.task(name="maintenance.clear_expired_llm_credentials")
def clear_expired_llm_credentials() -> int:
    return asyncio.run(run_expired_credential_cleanup())
