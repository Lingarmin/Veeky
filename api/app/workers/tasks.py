from __future__ import annotations

import asyncio
import binascii
import hashlib
import json
import math
import shutil
from pathlib import Path
from types import SimpleNamespace
from datetime import datetime, timezone

from celery import Celery
from cryptography.exceptions import InvalidTag
from sqlalchemy import select, update
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
)
from app.security.credentials import JobCredentialCipher


class AudioExtractionError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


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

    async def extract(self, media_path: Path, audio_path: Path) -> Path:
        self._validate_path(media_path)
        self._validate_path(audio_path)
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
        return audio_path

    async def _run_subprocess(self, *arguments: str):
        try:
            process = await asyncio.create_subprocess_exec(
                *arguments,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(
                process.communicate(), timeout=self.timeout_seconds
            )
        except (OSError, TimeoutError):
            if "process" in locals() and process.returncode is None:
                process.kill()
                await process.communicate()
            raise AudioExtractionError(
                "audio_extraction_failed", "音频提取失败"
            ) from None
        return SimpleNamespace(
            returncode=process.returncode,
            stdout=stdout.decode("utf-8", "replace"),
            stderr=stderr.decode("utf-8", "replace"),
        )

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

    async def run(self, job_id: str, *, resume: bool = False) -> None:
        job = await self._claim(job_id, resume=resume)
        if job is None:
            return
        translation_provider = self.translation_provider
        analysis_service = self.analysis_service
        try:
            if self._uses_default_providers:
                if not self._credential_is_current(job):
                    await self._fail(
                        job_id,
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

            acquired = (
                await self._acquire_x(job)
                if job.video.platform == "x"
                else await self._acquire_youtube(job)
            )
            if acquired is None:
                return
            track, stored_segments, version = acquired

            await self._set_status(job_id, "analyzing")
            analysis_segments = [
                AnalysisSegment(
                    segment_id=segment.id,
                    start_ms=segment.start_ms,
                    duration_ms=segment.duration_ms,
                    original=segment.text,
                )
                for segment in stored_segments
            ]
            result = await analysis_service.analyze(
                analysis_segments,
                job.target_language,
                duration_ms=job.video.duration_ms,
            )
            async with self.session_factory() as session:
                job_row = await session.scalar(
                    select(AnalysisJob)
                    .options(selectinload(AnalysisJob.result))
                    .where(AnalysisJob.id == job_id)
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
                if job_row.result is None:
                    job_row.result = StoredAnalysisResult(**result_values)
                else:
                    for field, value in result_values.items():
                        setattr(job_row.result, field, value)
                job_row.status = "translating"
                await session.commit()

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
                cache = SqlTranslationCache(session)
                translation_service = CachedTranslationService(
                    translation_provider, cache
                )
                await translation_service.translate(
                    track.id,
                    translation_inputs,
                    track.language_code,
                    job.target_language,
                    version,
                )
                await session.commit()
            await self._complete(job_id)
        except MediaDownloadError:
            await self._wait_for_media(job_id)
        except (AudioExtractionError, AsrError) as error:
            await self._fail(job_id, error.code, str(error))
        except TranslationProviderError as error:
            await self._fail(job_id, "translation_failed", f"{error.code}: {error}")
        except AnalysisGenerationError as error:
            await self._fail(job_id, error.code, str(error))
        except Exception as error:
            await self._fail(job_id, "analysis_internal_error", None)
            raise
        finally:
            await self._cleanup_job_temp(job_id)

    async def _acquire_youtube(self, job):
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
                inspection.failure_code or "transcript_unavailable",
                inspection.failure_detail,
            )
            return None
        if (
            inspection.selected is None
            or inspection.selected.language_code != job.source_language
        ):
            await self._fail(job.id, "source_language_unavailable", None)
            return None

        version = transcript_version(inspection.segments)
        if version != job.transcript_version:
            await self._fail(
                job.id,
                "transcript_changed",
                "YouTube captions changed after the task was created",
            )
            return None
        async with self.session_factory() as session:
            track = await self._persist_transcript(
                session, job.video_id, inspection, version
            )
            stored_segments = list(track.segments)
            await session.commit()
        return track, stored_segments, version

    async def _acquire_x(self, job):
        root = Path(self.settings.media_temp_root).resolve()
        job_dir = root / f"job-{job.id}"
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
            await self._set_status(job.id, "downloading_media")
            downloader = self.media_downloader or MediaDownloader(
                max_bytes=self.settings.max_media_bytes,
                timeout_seconds=self.settings.media_download_timeout_seconds,
            )
            try:
                await downloader.download(media_url, media_path)
            except MediaDownloadError:
                await self._clear_media_candidate(job.id)
                if not job.media_session_id:
                    raise
            media_url = ""
            await self._clear_media_candidate(job.id)
        if not media_path.exists():
            async with self.session_factory() as session:
                upload = await session.scalar(
                    select(MediaUploadSession)
                    .where(
                        MediaUploadSession.id == job.media_session_id,
                        MediaUploadSession.installation_id == job.installation_id,
                        MediaUploadSession.content_id == job.content_id,
                        MediaUploadSession.status == "complete",
                        MediaUploadSession.expires_at > datetime.now(timezone.utc),
                    )
                    .with_for_update()
                )
                if upload is None:
                    raise MediaDownloadError("media upload required")
                upload.status = "consumed"
                uploaded_dir = root / upload.directory_key
                await asyncio.to_thread(
                    self._copy_upload_artifact,
                    uploaded_dir,
                    upload.media_kind,
                    media_path,
                    self.settings.max_media_bytes,
                )
                await session.commit()
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
            raise AudioExtractionError("video_too_long", "视频时长不能超过 4 小时")
        duration_ms = round(exact_duration_ms)
        job.video.duration_ms = duration_ms
        await self._set_status(job.id, "extracting_audio")
        audio_path = await extractor.extract(media_path, job_dir / "audio.wav")
        if (
            media_size + audio_path.stat().st_size
            > self.settings.max_temp_bytes_per_job
        ):
            raise AudioExtractionError("media_too_large", "媒体文件过大")
        await self._set_status(job.id, "transcribing")
        transcriber = self.transcriber or get_default_transcriber(
            settings=self.settings
        )
        segments, language = await asyncio.to_thread(transcriber.transcribe, audio_path)
        artifact_hash = await asyncio.to_thread(self._sha256_file, media_path)
        version = self._x_transcript_version(
            segments, artifact_hash, transcriber.version
        )
        async with self.session_factory() as session:
            current = await session.get(AnalysisJob, job.id)
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
                current.status = "completed"
                current.completed_at = datetime.now(timezone.utc)
                self._clear_credential(current)
                await session.commit()
                if uploaded_dir is not None:
                    await asyncio.to_thread(shutil.rmtree, uploaded_dir, True)
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
            await session.commit()
            stored_segments = list(track.segments)
        if uploaded_dir is not None:
            await asyncio.to_thread(shutil.rmtree, uploaded_dir, True)
        return track, stored_segments, version

    async def _set_status(self, job_id: str, status: str) -> None:
        async with self.session_factory() as session:
            job = await session.get(AnalysisJob, job_id)
            if job is not None:
                job.status = status
                await session.commit()

    async def _clear_media_candidate(self, job_id: str) -> None:
        async with self.session_factory() as session:
            job = await session.get(AnalysisJob, job_id)
            if job is not None:
                job.media_url_ciphertext = None
                await session.commit()

    async def _wait_for_media(self, job_id: str) -> None:
        async with self.session_factory() as session:
            job = await session.get(AnalysisJob, job_id)
            if job is None:
                return
            job.status = "waiting_for_media"
            job.failure_code = None
            job.failure_detail = None
            job.completed_at = None
            job.media_url_ciphertext = None
            await session.commit()

    async def _complete(self, job_id: str) -> None:
        async with self.session_factory() as session:
            job = await session.get(AnalysisJob, job_id)
            if job is None:
                return
            job.status = "completed"
            job.completed_at = datetime.now(timezone.utc)
            job.failure_code = None
            job.failure_detail = None
            self._clear_credential(job)
            await session.commit()
        await self._cleanup_consumed_upload(job_id)

    async def _cleanup_job_temp(self, job_id: str) -> None:
        root = Path(self.settings.media_temp_root).resolve()
        await asyncio.to_thread(shutil.rmtree, root / f"job-{job_id}", True)

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

    async def _claim(self, job_id: str, *, resume: bool) -> AnalysisJob | None:
        async with self.session_factory() as session:
            job = await session.scalar(
                select(AnalysisJob)
                .options(selectinload(AnalysisJob.video))
                .where(AnalysisJob.id == job_id)
                .with_for_update()
            )
            resumable = job is not None and job.status in {
                "waiting_for_media",
                "downloading_media",
                "extracting_audio",
                "transcribing",
                "fetching_transcript",
                "translating",
                "analyzing",
            }
            if job is not None and job.video.platform == "x":
                resumable = job.status == "waiting_for_media"
            if job is None or (job.status != "queued" and not (resume and resumable)):
                return None
            job.status = (
                "downloading_media"
                if job.video.platform == "x"
                else "fetching_transcript"
            )
            await session.commit()
            return job

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
        failure_code: str,
        failure_detail: str | None,
        *,
        expire_complete_upload: bool = False,
    ) -> None:
        async with self.session_factory() as session:
            job = await session.get(AnalysisJob, job_id)
            if job is None:
                return
            job.status = "failed"
            job.failure_code = failure_code
            job.failure_detail = failure_detail
            job.completed_at = datetime.now(timezone.utc)
            self._clear_credential(job)
            await session.commit()
        if expire_complete_upload:
            await self._expire_complete_upload(job_id)
        await self._cleanup_consumed_upload(job_id)

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

    @staticmethod
    def _clear_credential(job: AnalysisJob) -> None:
        job.llm_credential_ciphertext = None
        job.llm_credential_expires_at = None
        job.media_url_ciphertext = None


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


async def run_analysis_task(job_id: str, *, resume: bool = False) -> None:
    current = get_settings()
    engine = create_async_engine(current.database_url, pool_pre_ping=True)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        await build_default_pipeline(session_factory).run(job_id, resume=resume)
    finally:
        await engine.dispose()


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


@celery_app.task(bind=True, name="analysis.analyze_video")
def analyze_video(task, job_id: str, *, resume: bool = False) -> None:
    delivery_info = task.request.delivery_info or {}
    asyncio.run(
        run_analysis_task(
            job_id,
            resume=resume or bool(delivery_info.get("redelivered")),
        )
    )


@celery_app.task(name="maintenance.clear_expired_llm_credentials")
def clear_expired_llm_credentials() -> int:
    return asyncio.run(run_expired_credential_cleanup())
