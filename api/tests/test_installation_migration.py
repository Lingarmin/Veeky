from __future__ import annotations

import asyncio
import json
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
LEGACY_TOKEN_HASH = "0" * 64


@pytest.fixture
def migration_database_url() -> Iterator[str]:
    if subprocess.run(
        ["docker", "info"], capture_output=True, check=False
    ).returncode:
        pytest.skip("Docker is required for the PostgreSQL migration test")

    container_name = f"veeky-migration-test-{uuid.uuid4().hex}"
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


def _alembic_upgrade(database_url: str, revision: str) -> None:
    environment = {**os.environ, "DATABASE_URL": database_url}
    completed = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", revision],
        cwd=API_DIRECTORY,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr


@pytest.mark.asyncio
async def test_installation_security_migration_assigns_legacy_owner_and_removes_api_key(
    migration_database_url: str,
):
    _alembic_upgrade(migration_database_url, "0003_llm_config")
    database_url = migration_database_url.replace("postgresql+asyncpg://", "postgresql://")
    connection = await asyncpg.connect(database_url)
    try:
        await connection.execute(
            """
            INSERT INTO videos (video_id, title, duration_ms, source_url, created_at)
            VALUES ('aircAruvnKk', 'Migration fixture', 1000, 'https://example.test', NOW())
            """
        )
        await connection.execute(
            """
            INSERT INTO analysis_jobs (
                id, video_id, source_language, target_language, transcript_version,
                cache_key, status, created_at, llm_config
            ) VALUES (
                '11111111-1111-4111-8111-111111111111', 'aircAruvnKk', 'en',
                'zh-Hans', 'sha256:migration', 'migration-cache-key', 'queued', NOW(),
                $1::json
            )
            """,
            json.dumps(
                {
                    "provider": "kimi",
                    "api_url": "https://api.moonshot.cn/v1",
                    "model": "kimi-k2.5",
                    "api_key": "must-not-survive-migration",
                }
            ),
        )
    finally:
        await connection.close()

    _alembic_upgrade(migration_database_url, "head")

    connection = await asyncpg.connect(database_url)
    try:
        job = await connection.fetchrow(
            """
            SELECT installation_id, llm_config, llm_credential_ciphertext,
                   llm_credential_expires_at
            FROM analysis_jobs
            WHERE id = '11111111-1111-4111-8111-111111111111'
            """
        )
        installation = await connection.fetchrow(
            "SELECT id, token_hash FROM installations WHERE id = $1",
            LEGACY_INSTALLATION_ID,
        )
        nullable = await connection.fetchval(
            """
            SELECT is_nullable
            FROM information_schema.columns
            WHERE table_name = 'analysis_jobs' AND column_name = 'installation_id'
            """
        )
    finally:
        await connection.close()

    assert job["installation_id"] == LEGACY_INSTALLATION_ID
    assert json.loads(job["llm_config"]) == {
        "provider": "kimi",
        "api_url": "https://api.moonshot.cn/v1",
        "model": "kimi-k2.5",
    }
    assert job["llm_credential_ciphertext"] is None
    assert job["llm_credential_expires_at"] is None
    assert installation == (LEGACY_INSTALLATION_ID, LEGACY_TOKEN_HASH)
    assert nullable == "NO"
