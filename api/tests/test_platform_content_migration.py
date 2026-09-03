from __future__ import annotations

import os
import subprocess
import sys
import time
import uuid
from collections.abc import Iterator
from pathlib import Path

import asyncpg
import pytest


API_DIRECTORY = Path(__file__).resolve().parents[1]
POSTGRES_IMAGE = "postgres:16.9-alpine"
LEGACY_INSTALLATION_ID = "00000000-0000-4000-8000-000000000000"
VIDEO_ID = "aircAruvnKk"
TRACK_ID = "22222222-2222-4222-8222-222222222222"
SEGMENT_ID = "33333333-3333-4333-8333-333333333333"
JOB_ID = "44444444-4444-4444-8444-444444444444"
RESULT_ID = "55555555-5555-4555-8555-555555555555"


@pytest.fixture
def migration_database_url() -> Iterator[str]:
    if subprocess.run(
        ["docker", "info"], capture_output=True, check=False
    ).returncode:
        pytest.skip("Docker is required for the PostgreSQL migration test")

    container_name = f"veeky-platform-content-test-{uuid.uuid4().hex}"
    container_id = subprocess.check_output(
        [
            "docker",
            "run",
            "--detach",
            "--rm",
            "--name",
            container_name,
            "--env",
            "POSTGRES_DB=veeky_migration_test",
            "--env",
            "POSTGRES_USER=veeky",
            "--env",
            "POSTGRES_PASSWORD=veeky",
            "--publish",
            "127.0.0.1::5432",
            POSTGRES_IMAGE,
        ],
        text=True,
    ).strip()
    try:
        _wait_for_postgres(container_id)
        port = subprocess.check_output(
            ["docker", "port", container_id, "5432/tcp"], text=True
        ).strip().rsplit(":", 1)[1]
        yield (
            "postgresql+asyncpg://veeky:veeky@127.0.0.1:"
            f"{port}/veeky_migration_test"
        )
    finally:
        subprocess.run(["docker", "rm", "--force", container_id], check=False)


def _wait_for_postgres(container_id: str) -> None:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        ready = subprocess.run(
            ["docker", "exec", container_id, "pg_isready", "-U", "veeky"],
            capture_output=True,
            check=False,
        )
        if ready.returncode == 0:
            return
        time.sleep(0.25)
    pytest.fail("temporary PostgreSQL container did not become ready")


def _alembic(database_url: str, command: str, revision: str) -> None:
    environment = {**os.environ, "DATABASE_URL": database_url}
    completed = subprocess.run(
        [sys.executable, "-m", "alembic", command, revision],
        cwd=API_DIRECTORY,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr


async def _insert_youtube_history(connection: asyncpg.Connection) -> None:
    await connection.execute(
        """
        INSERT INTO videos (video_id, title, duration_ms, source_url, created_at)
        VALUES (
            'aircAruvnKk', 'Migration fixture', 1000,
            'https://www.youtube.com/watch?v=aircAruvnKk', NOW()
        )
        """
    )
    await connection.execute(
        """
        INSERT INTO transcript_tracks (
            id, video_id, language_code, language_name, is_generated,
            is_translatable, transcript_version, created_at
        ) VALUES (
            $1, $2, 'en', 'English', FALSE, TRUE, 'sha256:migration', NOW()
        )
        """,
        TRACK_ID,
        VIDEO_ID,
    )
    await connection.execute(
        """
        INSERT INTO transcript_segments (
            id, track_id, sequence, start_ms, duration_ms, text
        ) VALUES ($1, $2, 0, 0, 1000, 'Migration transcript text')
        """,
        SEGMENT_ID,
        TRACK_ID,
    )
    await connection.execute(
        """
        INSERT INTO analysis_jobs (
            id, installation_id, video_id, source_language, target_language,
            transcript_version, cache_key, status, created_at, completed_at
        ) VALUES (
            $1, $2, $3, 'en', 'zh-Hans', 'sha256:migration',
            'migration-cache-key', 'completed', NOW(), NOW()
        )
        """,
        JOB_ID,
        LEGACY_INSTALLATION_ID,
        VIDEO_ID,
    )
    await connection.execute(
        """
        INSERT INTO analysis_results (
            id, job_id, one_line_summary, summary_points, chapters, highlights,
            model_name, model_version, generated_at
        ) VALUES (
            $1, $2, 'Migration summary', '[]'::json, '[]'::json, '[]'::json,
            'fixture', 'v1', NOW()
        )
        """,
        RESULT_ID,
        JOB_ID,
    )


async def _fetch_history(connection: asyncpg.Connection) -> asyncpg.Record:
    return await connection.fetchrow(
        """
        SELECT v.video_id, v.title, v.source_url,
               t.language_name, t.transcript_version, s.text AS transcript_text,
               j.status, j.cache_key, j.source_language,
               r.one_line_summary
        FROM videos v
        JOIN transcript_tracks t ON t.video_id = v.video_id
        JOIN transcript_segments s ON s.track_id = t.id
        JOIN analysis_jobs j ON j.video_id = v.video_id
        JOIN analysis_results r ON r.job_id = j.id
        WHERE v.video_id = $1
        """,
        VIDEO_ID,
    )


@pytest.mark.asyncio
async def test_platform_content_migration_preserves_youtube_history_on_round_trip(
    migration_database_url: str,
):
    _alembic(migration_database_url, "upgrade", "0005_one_active_job")
    database_url = migration_database_url.replace(
        "postgresql+asyncpg://", "postgresql://"
    )
    connection = await asyncpg.connect(database_url)
    try:
        await _insert_youtube_history(connection)
        expected_history = tuple(await _fetch_history(connection))
    finally:
        await connection.close()

    _alembic(migration_database_url, "upgrade", "head")

    connection = await asyncpg.connect(database_url)
    try:
        video = await connection.fetchrow(
            """
            SELECT content_id, platform, source_content_id, media_index
            FROM videos WHERE video_id = $1
            """,
            VIDEO_ID,
        )
        track_content_id = await connection.fetchval(
            "SELECT content_id FROM transcript_tracks WHERE id = $1", TRACK_ID
        )
        job_content_id = await connection.fetchval(
            "SELECT content_id FROM analysis_jobs WHERE id = $1", JOB_ID
        )
        upgraded_history = tuple(await _fetch_history(connection))
    finally:
        await connection.close()

    assert video["platform"] == "youtube"
    assert video["source_content_id"] == VIDEO_ID
    assert video["media_index"] == 1
    assert uuid.UUID(video["content_id"])
    assert uuid.UUID(track_content_id)
    assert uuid.UUID(job_content_id)
    assert video["content_id"] == track_content_id == job_content_id
    assert upgraded_history == expected_history

    _alembic(migration_database_url, "downgrade", "0005_one_active_job")

    connection = await asyncpg.connect(database_url)
    try:
        downgraded_history = tuple(await _fetch_history(connection))
    finally:
        await connection.close()

    assert downgraded_history == expected_history
