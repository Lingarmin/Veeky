from __future__ import annotations

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import selectinload

from app.db.models import AnalysisJob, Base, TranscriptSegment as StoredSegment, Video
from app.services.analysis import AnalysisSegment
from app.services.transcripts import (
    TranscriptInspection,
    TranscriptSegment,
    TranscriptTrackInfo,
)
from app.services.translation import TranslatedSegment, TranslationProviderError
from app.workers.tasks import AnalysisPipeline


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
            TranslatedSegment(item.segment_id, item.start_ms, item.duration_ms, f"ZH:{item.text}")
            for item in segments
        ]


class FakeAnalysisService:
    async def analyze(self, segments, target_language, *, duration_ms):
        from app.services.analysis import AnalysisResult, Highlight, TimedSummary
        from datetime import datetime, timezone

        assert all(isinstance(item, AnalysisSegment) for item in segments)
        return AnalysisResult(
            one_line_summary="神经网络从像素中学习。",
            summary_points=["像素进入输入层"],
            chapters=[TimedSummary(start_ms=0, end_ms=2000, title="输入", summary="像素")],
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
    async with factory() as session:
        video = Video(
            video_id="aircAruvnKk",
            title="Neural networks",
            duration_ms=2000,
            source_url="https://www.youtube.com/watch?v=aircAruvnKk",
        )
        job = AnalysisJob(
            video=video,
            source_language="en",
            target_language="zh-Hans",
            cache_key="aircAruvnKk:en:zh-Hans:version",
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
            select(AnalysisJob).options(selectinload(AnalysisJob.result)).where(AnalysisJob.id == job_id)
        )
        segment_count = await session.scalar(select(func.count()).select_from(StoredSegment))
        assert job.status == "completed"
        assert job.result.one_line_summary == "神经网络从像素中学习。"
        assert segment_count == 2
    assert transcript_service.calls == 1
    assert translation_provider.calls == 1


@pytest.mark.asyncio
async def test_translation_failure_preserves_original_transcript(pipeline_context):
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
        segment_count = await session.scalar(select(func.count()).select_from(StoredSegment))
        assert job.status == "failed"
        assert job.failure_code == "translation_failed"
        assert segment_count == 2


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
            select(AnalysisJob).options(selectinload(AnalysisJob.result)).where(AnalysisJob.id == job_id)
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
