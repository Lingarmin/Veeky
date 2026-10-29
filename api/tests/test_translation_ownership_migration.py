from __future__ import annotations

import json

import asyncpg
import pytest

from app.services.translation import provider_translation_version
from tests.test_platform_content_migration import (
    migration_database_url, _alembic, _insert_youtube_history, _insert_x_history,
    JOB_ID, X_JOB_ID, TRANSLATION_ID, X_TRANSLATION_ID, LEGACY_INSTALLATION_ID,
)


@pytest.mark.asyncio
async def test_translation_migration_preserves_only_exact_existing_history(migration_database_url):
    _alembic(migration_database_url, "upgrade", "0005_one_active_job")
    url = migration_database_url.replace("postgresql+asyncpg://", "postgresql://")
    connection = await asyncpg.connect(url)
    try:
        await _insert_youtube_history(connection)
    finally:
        await connection.close()
    _alembic(migration_database_url, "upgrade", "0008_x_analysis_pipeline")
    connection = await asyncpg.connect(url)
    other_owner = "12121212-1212-4212-8212-121212121212"
    other_job = "13131313-1313-4313-8313-131313131313"
    try:
        await _insert_x_history(connection)
        config = {"provider": "kimi", "model": "kimi-k2.5", "api_url": "https://api.moonshot.cn/v1"}
        version = provider_translation_version(config["api_url"] + "/chat/completions")
        await connection.execute("UPDATE translations SET provider='kimi', provider_version=$1", version)
        await connection.execute("UPDATE analysis_jobs SET llm_config=$1::json, source_language='en'", json.dumps(config))
        await connection.execute("INSERT INTO installations (id, token_hash, created_at, last_seen_at) VALUES ($1, $2, NOW(), NOW())", other_owner, "c" * 64)
        # This other installation already saw the shared translation before migration.
        await connection.execute("""INSERT INTO analysis_jobs
            (id, installation_id, video_id, content_id, source_language, target_language,
             transcript_version, cache_key, status, created_at, completed_at, llm_config)
            SELECT $1, $2, video_id, content_id, source_language, target_language,
                   transcript_version, 'other-history', status, created_at, completed_at, llm_config
            FROM analysis_jobs WHERE id=$3""", other_job, other_owner, JOB_ID)
        await connection.execute("""INSERT INTO analysis_results
            (id, job_id, one_line_summary, summary_points, chapters, highlights, model_name, model_version, generated_at)
            SELECT '14141414-1414-4414-8414-141414141414', $1, one_line_summary, summary_points,
                   chapters, highlights, model_name, model_version, generated_at
            FROM analysis_results WHERE job_id=$2""", other_job, JOB_ID)
        # A terminal job with an incomplete identity must never be guessed.
        await connection.execute("""INSERT INTO analysis_jobs
            (id, installation_id, video_id, content_id, source_language, target_language,
             transcript_version, cache_key, status, created_at, completed_at, llm_config)
            SELECT '15151515-1515-4515-8515-151515151515', installation_id, video_id, content_id,
                   source_language, target_language, transcript_version, 'unknown-history',
                   'failed', created_at, completed_at, NULL FROM analysis_jobs WHERE id=$1""", JOB_ID)
        await connection.execute("UPDATE analysis_jobs SET failure_code='translation_failed' WHERE cache_key='unknown-history'")
        before = await connection.fetchval("SELECT count(*) FROM analysis_jobs")
    finally:
        await connection.close()

    _alembic(migration_database_url, "upgrade", "head")
    connection = await asyncpg.connect(url)
    try:
        rows = await connection.fetch("SELECT id, legacy_translation_id FROM analysis_jobs")
        bindings = {row['id']: row['legacy_translation_id'] for row in rows}
        assert len(rows) == before
        assert bindings[JOB_ID] == TRANSLATION_ID
        assert bindings[other_job] == TRANSLATION_ID
        assert bindings[X_JOB_ID] == X_TRANSLATION_ID
        assert bindings['15151515-1515-4515-8515-151515151515'] is None
        assert await connection.fetchval("SELECT count(*) FROM translations WHERE installation_id IS NULL") == 2
        assert await connection.fetchval("SELECT count(*) FROM analysis_results") == 3
        # Same cache identity can now coexist across installations, never within one.
        for suffix, owner in [("a", LEGACY_INSTALLATION_ID), ("b", other_owner)]:
            await connection.execute("""INSERT INTO translations
                (id, installation_id, track_id, target_language, provider, provider_version,
                 transcript_version, segments, created_at)
                SELECT $1, $2, track_id, target_language, provider, provider_version,
                       transcript_version, segments, NOW() FROM translations WHERE id=$3""",
                'scoped-' + suffix, owner, TRANSLATION_ID)
        with pytest.raises(asyncpg.UniqueViolationError):
            await connection.execute("""INSERT INTO translations
                (id, installation_id, track_id, target_language, provider, provider_version,
                 transcript_version, segments, created_at)
                SELECT 'duplicate', installation_id, track_id, target_language, provider,
                       provider_version, transcript_version, segments, NOW()
                FROM translations WHERE id='scoped-a'""")
    finally:
        await connection.close()
