from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from celery import Celery
from sqlalchemy import select
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
)
from app.services.analysis import (
    AnalysisGenerationError,
    AnalysisSegment,
    HttpAnalysisProvider,
    StructuredAnalysisService,
    LlmAnalysisProvider,
)
from app.services.llm import build_llm_client
from app.services.transcripts import TranscriptService, transcript_version
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


settings = get_settings()
celery_app = Celery("youtube_preview", broker=settings.redis_url, backend=settings.redis_url)
celery_app.conf.update(
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    task_track_started=True,
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


def build_llm_services(config: dict[str, str]) -> tuple[TranslationProvider, StructuredAnalysisService]:
    client = build_llm_client(config)
    return LlmTranslationProvider(client), StructuredAnalysisService(LlmAnalysisProvider(client))


class AnalysisPipeline:
    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        transcript_service: TranscriptService,
        translation_provider: TranslationProvider,
        analysis_service: StructuredAnalysisService,
    ):
        self.session_factory = session_factory
        self.transcript_service = transcript_service
        self.translation_provider = translation_provider
        self.analysis_service = analysis_service
        self._uses_default_providers = False
    async def run(self, job_id: str, *, resume: bool = False) -> None:
        job = await self._claim(job_id, resume=resume)
        if job is None:
            return
        translation_provider = self.translation_provider
        analysis_service = self.analysis_service
        if job.llm_config and self._uses_default_providers:
            translation_provider, analysis_service = build_llm_services(
                dict(job.llm_config)
            )

        try:
            inspection = await asyncio.to_thread(
                self.transcript_service.inspect,
                job.video_id,
                [job.source_language],
            )
            if not inspection.available:
                await self._fail(
                    job_id,
                    inspection.failure_code or "transcript_unavailable",
                    inspection.failure_detail,
                )
                return
            if (
                inspection.selected is None
                or inspection.selected.language_code != job.source_language
            ):
                await self._fail(job_id, "source_language_unavailable", None)
                return

            version = transcript_version(inspection.segments)
            if version != job.transcript_version:
                await self._fail(
                    job_id,
                    "transcript_changed",
                    "YouTube captions changed after the task was created",
                )
                return
            async with self.session_factory() as session:
                track = await self._persist_transcript(
                    session, job.video_id, inspection, version
                )
                stored_segments = list(track.segments)
                job_row = await session.get(AnalysisJob, job_id)
                job_row.status = "analyzing"
                await session.commit()

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
                    "highlights": [highlight.model_dump() for highlight in result.highlights],
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
                translated = await translation_service.translate(
                    track.id,
                    translation_inputs,
                    job.source_language,
                    job.target_language,
                    version,
                )
                await session.commit()
            async with self.session_factory() as session:
                job_row = await session.get(AnalysisJob, job_id)
                job_row.status = "completed"
                job_row.completed_at = datetime.now(timezone.utc)
                job_row.failure_code = None
                job_row.failure_detail = None
                await session.commit()
        except TranslationProviderError as error:
            await self._fail(job_id, "translation_failed", f"{error.code}: {error}")
        except AnalysisGenerationError as error:
            await self._fail(job_id, error.code, str(error))
        except Exception as error:
            await self._fail(job_id, "analysis_internal_error", str(error))
            raise

    async def _claim(self, job_id: str, *, resume: bool) -> AnalysisJob | None:
        async with self.session_factory() as session:
            job = await session.scalar(
                select(AnalysisJob)
                .options(selectinload(AnalysisJob.video))
                .where(AnalysisJob.id == job_id)
                .with_for_update()
            )
            resumable = job is not None and job.status in {
                "fetching_transcript",
                "translating",
                "analyzing",
            }
            if job is None or (job.status != "queued" and not (resume and resumable)):
                return None
            job.status = "fetching_transcript"
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
        self, job_id: str, failure_code: str, failure_detail: str | None
    ) -> None:
        async with self.session_factory() as session:
            job = await session.get(AnalysisJob, job_id)
            if job is None:
                return
            job.status = "failed"
            job.failure_code = failure_code
            job.failure_detail = failure_detail
            job.completed_at = datetime.now(timezone.utc)
            await session.commit()


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
        TranscriptService(proxy_url=current.youtube_transcript_proxy_url),
        translation_provider,
        StructuredAnalysisService(analysis_provider),
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


@celery_app.task(bind=True, name="analysis.analyze_video")
def analyze_video(task, job_id: str) -> None:
    delivery_info = task.request.delivery_info or {}
    asyncio.run(
        run_analysis_task(
            job_id,
            resume=bool(delivery_info.get("redelivered")),
        )
    )
