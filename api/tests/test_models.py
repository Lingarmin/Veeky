from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db.models import (
    AnalysisJob,
    Base,
    Installation,
    TranscriptTrack,
    Translation,
    Video,
)


@pytest.fixture
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.execute(text("PRAGMA foreign_keys = ON"))
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
async def test_videos_from_different_platforms_have_unique_content_ids(session):
    youtube = Video(
        video_id="aircAruvnKk",
        platform="youtube",
        source_content_id="aircAruvnKk",
        media_index=1,
        title="YouTube",
        duration_ms=1000,
        source_url="https://www.youtube.com/watch?v=aircAruvnKk",
    )
    x_video = Video(
        video_id="x:2075545587093807111:1",
        platform="x",
        source_content_id="2075545587093807111",
        media_index=1,
        title="X video",
        duration_ms=1000,
        source_url="https://x.com/viktoroddy/status/2075545587093807111/video/1",
    )
    session.add_all([youtube, x_video])

    await session.commit()

    assert youtube.content_id != x_video.content_id


@pytest.mark.asyncio
async def test_transcript_track_rejects_mismatched_video_and_content_ids(session):
    youtube = Video(
        video_id="aircAruvnKk",
        platform="youtube",
        source_content_id="aircAruvnKk",
        media_index=1,
        title="YouTube",
        duration_ms=1000,
        source_url="https://www.youtube.com/watch?v=aircAruvnKk",
    )
    x_video = Video(
        video_id="x:2075545587093807111:1",
        platform="x",
        source_content_id="2075545587093807111",
        media_index=1,
        title="X video",
        duration_ms=1000,
        source_url="https://x.com/viktoroddy/status/2075545587093807111/video/1",
    )
    session.add_all([youtube, x_video])
    await session.commit()

    session.add(
        TranscriptTrack(
            video_id=youtube.video_id,
            content_id=x_video.content_id,
            language_code="en",
            language_name="English",
            is_generated=False,
            is_translatable=True,
            transcript_version="sha256:mismatch",
        )
    )

    with pytest.raises(IntegrityError):
        await session.commit()


@pytest.mark.asyncio
async def test_analysis_job_rejects_mismatched_video_and_content_ids(session):
    youtube = Video(
        video_id="aircAruvnKk",
        platform="youtube",
        source_content_id="aircAruvnKk",
        media_index=1,
        title="YouTube",
        duration_ms=1000,
        source_url="https://www.youtube.com/watch?v=aircAruvnKk",
    )
    x_video = Video(
        video_id="x:2075545587093807111:1",
        platform="x",
        source_content_id="2075545587093807111",
        media_index=1,
        title="X video",
        duration_ms=1000,
        source_url="https://x.com/viktoroddy/status/2075545587093807111/video/1",
    )
    installation = Installation(
        id="77777777-7777-4777-8777-777777777777", token_hash="e" * 64
    )
    session.add_all([youtube, x_video, installation])
    await session.commit()

    session.add(
        AnalysisJob(
            installation_id=installation.id,
            video_id=youtube.video_id,
            content_id=x_video.content_id,
            source_language="auto",
            target_language="zh-Hans",
            transcript_version="pending:mismatch",
            cache_key=f"pending:{installation.id}:mismatch",
        )
    )

    with pytest.raises(IntegrityError):
        await session.commit()


@pytest.mark.asyncio
async def test_x_worker_statuses_and_media_handoff_fields_are_persisted(session):
    installation = Installation(
        id="88888888-8888-4888-8888-888888888888", token_hash="f" * 64
    )
    video = Video(
        video_id="x:2075545587093807111:1",
        platform="x",
        source_content_id="2075545587093807111",
        media_index=1,
        title="X video",
        duration_ms=0,
        source_url="https://x.com/i/status/2075545587093807111/video/1",
    )
    job = AnalysisJob(
        installation=installation,
        video=video,
        source_language="auto",
        target_language="zh-Hans",
        transcript_version="pending:x-job",
        cache_key="pending:x-job",
        status="waiting_for_media",
        media_url_ciphertext="encrypted",
        force_run=True,
        lease_token="77777777-7777-4777-8777-777777777777",
        lease_expires_at=datetime.now(timezone.utc),
    )
    session.add(job)
    await session.commit()

    row = (
        await session.execute(
            text(
                "SELECT status, media_url_ciphertext, force_run, lease_token, "
                "lease_expires_at "
                "FROM analysis_jobs WHERE id = :id"
            ),
            {"id": job.id},
        )
    ).one()
    assert tuple(row[:4]) == (
        "waiting_for_media",
        "encrypted",
        1,
        "77777777-7777-4777-8777-777777777777",
    )
    assert row.lease_expires_at is not None


@pytest.mark.asyncio
async def test_translation_cache_allows_same_version_from_different_providers(session):
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
                provider_version="v1",
                transcript_version="sha256:abc",
                segments=[],
            ),
            Translation(
                track=track,
                target_language="zh-Hans",
                provider="llm-translation",
                provider_version="v1",
                transcript_version="sha256:abc",
                segments=[],
            ),
        ]
    )

    await session.commit()


@pytest.mark.asyncio
async def test_analysis_job_starts_queued_and_uses_utc_timestamp(session):
    installation = Installation(
        id="11111111-1111-4111-8111-111111111111", token_hash="a" * 64
    )
    video = Video(
        video_id="aircAruvnKk",
        title="But what is a neural network?",
        duration_ms=1_159_000,
        source_url="https://www.youtube.com/watch?v=aircAruvnKk",
    )
    job = AnalysisJob(
        installation=installation,
        video=video,
        source_language="en",
        target_language="zh-Hans",
        transcript_version="sha256:abc",
        cache_key="aircAruvnKk:en:zh-Hans",
    )
    session.add(job)
    await session.flush()

    assert job.status == "queued"
    assert isinstance(job.created_at, datetime)
    assert job.created_at.tzinfo == timezone.utc


@pytest.mark.asyncio
async def test_installation_cannot_have_two_active_analysis_jobs(session):
    installation = Installation(
        id="66666666-6666-4666-8666-666666666666", token_hash="d" * 64
    )
    video = Video(
        video_id="aircAruvnKk",
        title="But what is a neural network?",
        duration_ms=1_159_000,
        source_url="https://www.youtube.com/watch?v=aircAruvnKk",
    )
    session.add_all(
        [
            AnalysisJob(
                installation=installation,
                video=video,
                source_language="en",
                target_language="zh-Hans",
                transcript_version="sha256:abc",
                cache_key="active-job-one",
                status="queued",
            ),
            AnalysisJob(
                installation=installation,
                video=video,
                source_language="en",
                target_language="fr",
                transcript_version="sha256:abc",
                cache_key="active-job-two",
                status="analyzing",
            ),
        ]
    )

    with pytest.raises(IntegrityError):
        await session.commit()


@pytest.mark.asyncio
async def test_analysis_job_belongs_to_installation_and_stores_encrypted_credentials(
    session,
):
    installation = Installation(
        id="22222222-2222-4222-8222-222222222222", token_hash="b" * 64
    )
    video = Video(
        video_id="aircAruvnKk",
        title="But what is a neural network?",
        duration_ms=1_159_000,
        source_url="https://www.youtube.com/watch?v=aircAruvnKk",
    )
    job = AnalysisJob(
        installation=installation,
        video=video,
        source_language="en",
        target_language="zh-Hans",
        transcript_version="sha256:abc",
        cache_key="owner:cache",
        llm_config={
            "provider": "kimi",
            "api_url": "https://api.moonshot.cn/v1",
            "model": "kimi-k2.5",
        },
        llm_credential_ciphertext="encrypted",
        llm_credential_expires_at=datetime.now(timezone.utc),
    )
    session.add(job)
    await session.commit()

    assert job.installation_id == installation.id
    assert installation.jobs == [job]
    assert "api_key" not in job.llm_config
    assert job.llm_credential_ciphertext == "encrypted"


@pytest.mark.asyncio
async def test_installation_token_hash_is_unique(session):
    session.add_all(
        [
            Installation(
                id="33333333-3333-4333-8333-333333333333", token_hash="c" * 64
            ),
            Installation(
                id="44444444-4444-4444-8444-444444444444", token_hash="c" * 64
            ),
        ]
    )
    with pytest.raises(IntegrityError):
        await session.commit()


@pytest.mark.asyncio
async def test_installation_token_hash_must_be_64_characters(session):
    session.add(
        Installation(id="55555555-5555-4555-8555-555555555555", token_hash="too-short")
    )

    with pytest.raises(IntegrityError):
        await session.commit()
