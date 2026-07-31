from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db.models import (
    AnalysisJob,
    Base,
    TranscriptTrack,
    Translation,
    Video,
)


@pytest.fixture
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as database_session:
        yield database_session

    await engine.dispose()


@pytest.mark.asyncio
async def test_translation_cache_key_is_unique(session):
    video = Video(
        video_id="aircAruvnKk",
        title="But what is a neural network?",
        duration_ms=1_159_000,
        source_url="https://www.youtube.com/watch?v=aircAruvnKk",
    )
    track = TranscriptTrack(
        video=video,
        language_code="en",
        language_name="English",
        is_generated=False,
        is_translatable=True,
        transcript_version="sha256:abc",
    )
    session.add_all(
        [
            Translation(
                track=track,
                target_language="zh-Hans",
                provider="libretranslate",
                provider_version="1.6.5",
                transcript_version="sha256:abc",
                segments=[{"segment_id": "one", "text": "译文"}],
            ),
            Translation(
                track=track,
                target_language="zh-Hans",
                provider="libretranslate",
                provider_version="1.6.5",
                transcript_version="sha256:abc",
                segments=[{"segment_id": "one", "text": "另一份译文"}],
            ),
        ]
    )

    with pytest.raises(IntegrityError):
        await session.commit()


@pytest.mark.asyncio
async def test_analysis_job_starts_queued_and_uses_utc_timestamp(session):
    job = AnalysisJob(
        video_id="aircAruvnKk",
        source_language="en",
        target_language="zh-Hans",
        cache_key="aircAruvnKk:en:zh-Hans",
    )
    session.add(job)
    await session.flush()

    assert job.status == "queued"
    assert isinstance(job.created_at, datetime)
    assert job.created_at.tzinfo == timezone.utc
