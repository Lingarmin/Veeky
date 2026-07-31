from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import datetime, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api.analyses import get_job_dispatcher, get_session, get_transcript_service
from app.core.settings import Settings
from app.db.models import Base
from app.main import create_app
from app.services.analysis import AnalysisResult, Highlight, TimedSummary
from app.services.transcripts import (
    TranscriptInspection,
    TranscriptSegment,
    TranscriptTrackInfo,
)
from app.services.translation import TranslatedSegment
from app.workers.tasks import AnalysisPipeline


class FixedTranscriptService:
    def inspect(self, video_id, preferred_languages=()):
        track = TranscriptTrackInfo("en", "English", False, True)
        return TranscriptInspection(
            video_id=video_id,
            tracks=[track],
            selected=track,
            segments=[
                TranscriptSegment(0, 0, 1000, "Pixels enter the input layer."),
                TranscriptSegment(1, 1000, 1000, "Weights control each connection."),
            ],
            available=True,
        )


class FixedTranslationProvider:
    name = "fixed-translation"
    version = "test-1"

    def __init__(self):
        self.calls = 0

    async def translate(self, segments, source_language, target_language):
        self.calls += 1
        return [
            TranslatedSegment(
                segment.segment_id,
                segment.start_ms,
                segment.duration_ms,
                f"译文：{segment.text}",
            )
            for segment in segments
        ]


class FixedAnalysisService:
    async def analyze(self, segments, target_language, *, duration_ms):
        return AnalysisResult(
            one_line_summary="视频用像素和连接权重解释神经网络。",
            summary_points=["输入层接收像素", "权重控制连接强度", "激活值向后传播"],
            chapters=[
                TimedSummary(
                    start_ms=0,
                    end_ms=2000,
                    title="输入与权重",
                    summary="介绍神经网络的基础组成。",
                )
            ],
            highlights=[
                Highlight(
                    start_ms=1000,
                    end_ms=2000,
                    title="连接权重",
                    summary="权重决定信号影响程度。",
                    original_excerpt="Weights control each connection.",
                    translated_excerpt="权重控制每个连接。",
                )
            ],
            model_name="fixed-analysis",
            model_version="test-1",
            generated_at=datetime.now(timezone.utc),
        )


@pytest.mark.asyncio
async def test_api_pipeline_returns_timestamped_transcript_and_reuses_result():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    transcript_service = FixedTranscriptService()
    translation_provider = FixedTranslationProvider()
    app = create_app(Settings())

    async def session_dependency() -> AsyncIterator[AsyncSession]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_session] = session_dependency
    app.dependency_overrides[get_transcript_service] = lambda: transcript_service
    app.dependency_overrides[get_job_dispatcher] = lambda: lambda _job_id: None

    payload = {
        "videoId": "aircAruvnKk",
        "sourceLanguage": "en",
        "targetLanguage": "zh-Hans",
        "title": "But what is a neural network?",
    }
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        created = await client.post("/v1/analyses", json=payload)
        assert created.status_code == 202
        job_id = created.json()["jobId"]

        pipeline = AnalysisPipeline(
            factory,
            transcript_service,
            translation_provider,
            FixedAnalysisService(),
        )
        await pipeline.run(job_id)

        status = await client.get(f"/v1/analyses/{job_id}")
        result = await client.get(f"/v1/analyses/{job_id}/result")
        cached = await client.post("/v1/analyses", json=payload)

    assert status.json()["status"] == "completed"
    assert result.status_code == 200
    assert result.json()["videoTitle"] == payload["title"]
    assert result.json()["chapters"][0]["start_ms"] == 0
    assert result.json()["transcript"][0] == {
        "id": result.json()["transcript"][0]["id"],
        "startMs": 0,
        "durationMs": 1000,
        "original": "Pixels enter the input layer.",
        "translated": "译文：Pixels enter the input layer.",
    }
    assert cached.status_code == 200
    assert cached.json() == {
        "jobId": job_id,
        "cacheHit": True,
        "status": "completed",
    }
    assert translation_provider.calls == 1
    await engine.dispose()
