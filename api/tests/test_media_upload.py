from __future__ import annotations

import asyncio
import hashlib
import os
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import AsyncIterator, Iterator
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import BigInteger, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import app.workers.tasks as worker_tasks
from app.core.settings import Settings
from app.db.models import (
    AnalysisJob,
    Base,
    Installation,
    MediaUploadPart,
    MediaUploadSession,
    Video,
)
from app.db.session import get_session
from app.main import create_app
from app.security.installations import hash_installation_token
from app.security.quotas import get_quota_limiter
from app.services import media_upload
from app.services.job_lease import claim_job_lease, update_owned_job
from app.services.media_upload import (
    MediaUploadError,
    cleanup_expired_uploads,
    complete_upload,
    create_upload_session,
    delete_upload,
    get_owned_upload,
    store_part,
)


INSTALLATION_ID = "11111111-1111-4111-8111-111111111111"
INSTALLATION_TOKEN = "installation-token-with-at-least-forty-three-characters"
OTHER_INSTALLATION_ID = "22222222-2222-4222-8222-222222222222"
OTHER_INSTALLATION_TOKEN = "other-installation-token-with-at-least-forty-three-characters"
CONTENT_ID = "33333333-3333-4333-8333-333333333333"
API_DIRECTORY = Path(__file__).resolve().parents[1]
POSTGRES_IMAGE = "postgres:16.9-alpine"
AUTH_HEADERS = {
    "Authorization": f"Bearer {INSTALLATION_TOKEN}",
    "X-Veeky-Installation-Id": INSTALLATION_ID,
}
OTHER_AUTH_HEADERS = {
    "Authorization": f"Bearer {OTHER_INSTALLATION_TOKEN}",
    "X-Veeky-Installation-Id": OTHER_INSTALLATION_ID,
}


class PermissiveQuotaLimiter:
    async def enforce(self, subject, request_class, limit):
        return None


class TrackingQuotaLimiter(PermissiveQuotaLimiter):
    def __init__(self):
        self.calls: list[tuple[str, str, int]] = []

    async def enforce(self, subject, request_class, limit):
        self.calls.append((subject, request_class, limit))


def media_settings(media_root: Path) -> Settings:
    return Settings(
        media_temp_root=str(media_root),
        media_chunk_bytes=16,
        max_media_bytes=64,
        media_upload_session_ttl_seconds=3600,
        max_active_media_upload_sessions_per_installation=2,
    )


@pytest.fixture(scope="module")
def media_postgres_url() -> Iterator[str]:
    if subprocess.run(
        ["docker", "info"], capture_output=True, check=False
    ).returncode:
        pytest.skip("Docker is required for PostgreSQL media concurrency tests")
    container_name = f"veeky-media-concurrency-{uuid.uuid4().hex}"
    container_id = subprocess.check_output(
        [
            "docker",
            "run",
            "--detach",
            "--rm",
            "--name",
            container_name,
            "--env",
            "POSTGRES_DB=veeky_media_test",
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
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            ready = subprocess.run(
                ["docker", "exec", container_id, "pg_isready", "-U", "veeky"],
                capture_output=True,
                check=False,
            )
            if ready.returncode == 0:
                break
            time.sleep(0.25)
        else:
            pytest.fail("temporary PostgreSQL container did not become ready")
        port = subprocess.check_output(
            ["docker", "port", container_id, "5432/tcp"], text=True
        ).strip().rsplit(":", 1)[1]
        database_url = (
            f"postgresql+asyncpg://veeky:veeky@127.0.0.1:{port}/veeky_media_test"
        )
        environment = {**os.environ, "DATABASE_URL": database_url}
        migration_deadline = time.monotonic() + 10
        while True:
            migrated = subprocess.run(
                [sys.executable, "-m", "alembic", "upgrade", "head"],
                cwd=API_DIRECTORY,
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
            if migrated.returncode == 0:
                break
            if time.monotonic() >= migration_deadline:
                pytest.fail(migrated.stderr)
            time.sleep(0.25)
        yield database_url
    finally:
        subprocess.run(["docker", "rm", "--force", container_id], check=False)


@pytest.fixture
async def postgres_media_context(media_postgres_url: str, tmp_path: Path):
    engine = create_async_engine(media_postgres_url)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.drop_all)
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    settings = media_settings(tmp_path / "postgres-media")
    async with factory() as session:
        session.add_all(
            [
                Installation(
                    id=INSTALLATION_ID,
                    token_hash=hash_installation_token(INSTALLATION_TOKEN),
                ),
                Video(
                    video_id="x:2075545587093807111:1",
                    content_id=CONTENT_ID,
                    platform="x",
                    source_content_id="2075545587093807111",
                    media_index=1,
                    title="PostgreSQL upload fixture",
                    duration_ms=1000,
                    source_url=(
                        "https://x.com/example/status/2075545587093807111/video/1"
                    ),
                ),
            ]
        )
        await session.commit()
    yield factory, settings
    await engine.dispose()


@pytest.fixture
async def media_context(tmp_path: Path):
    database_url = os.environ.get(
        "MEDIA_UPLOAD_TEST_DATABASE_URL",
        f"sqlite+aiosqlite:///{tmp_path / 'media-upload.sqlite'}",
    )
    engine = create_async_engine(database_url)
    async with engine.begin() as connection:
        if "MEDIA_UPLOAD_TEST_DATABASE_URL" in os.environ:
            await connection.run_sync(Base.metadata.drop_all)
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    media_root = tmp_path / "media"
    settings = media_settings(media_root)
    app = create_app(settings)

    async def session_dependency() -> AsyncIterator[AsyncSession]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_session] = session_dependency
    app.dependency_overrides[get_quota_limiter] = lambda: PermissiveQuotaLimiter()

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers=AUTH_HEADERS,
    ) as client:
        for installation_id, token in (
            (INSTALLATION_ID, INSTALLATION_TOKEN),
            (OTHER_INSTALLATION_ID, OTHER_INSTALLATION_TOKEN),
        ):
            registered = await client.post(
                "/v1/installations/register",
                json={
                    "installationId": installation_id,
                    "installationToken": token,
                },
                headers={
                    "Authorization": f"Bearer {token}",
                    "X-Veeky-Installation-Id": installation_id,
                },
            )
            assert registered.status_code == 201

        async with factory() as session:
            session.add(
                Video(
                    video_id="x:2075545587093807111:1",
                    content_id=CONTENT_ID,
                    platform="x",
                    source_content_id="2075545587093807111",
                    media_index=1,
                    title="X upload fixture",
                    duration_ms=1000,
                    source_url=(
                        "https://x.com/example/status/2075545587093807111/video/1"
                    ),
                )
            )
            await session.commit()

        yield client, app, factory, media_root

    if "MEDIA_UPLOAD_TEST_DATABASE_URL" in os.environ:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.drop_all)
    await engine.dispose()


async def create_session(
    client: AsyncClient,
    *,
    kind: str = "mp4",
    expected_bytes: int = 20,
    part_count: int = 2,
):
    return await client.post(
        "/v1/media-sessions",
        json={
            "contentId": CONTENT_ID,
            "kind": kind,
            "expectedBytes": expected_bytes,
            "partCount": part_count,
        },
    )


async def upload_part(
    client: AsyncClient,
    session_id: str,
    part_number: int,
    body: bytes,
    *,
    checksum: str | None = None,
):
    return await client.put(
        f"/v1/media-sessions/{session_id}/parts/{part_number}",
        content=body,
        headers={
            "X-Content-SHA256": checksum or hashlib.sha256(body).hexdigest(),
            "Content-Type": "application/octet-stream",
        },
    )


@pytest.mark.asyncio
async def test_mp4_upload_lifecycle_is_resumable_and_completes_in_order(media_context):
    client, _, factory, media_root = media_context
    created = await create_session(client)

    assert created.status_code == 201
    payload = created.json()
    session_id = payload["sessionId"]
    assert payload["status"] == "created"
    assert payload["partSizeBytes"] == 16
    assert payload["partCount"] == 2

    first = b"0123456789abcdef"
    second = b"tail"
    assert (await upload_part(client, session_id, 0, first)).status_code == 204

    status = await client.get(f"/v1/media-sessions/{session_id}")
    assert status.status_code == 200
    assert status.json()["status"] == "uploading"
    assert status.json()["receivedBytes"] == len(first)
    assert status.json()["uploadedParts"] == [0]

    retry = await upload_part(client, session_id, 0, first)
    assert retry.status_code == 204
    assert (await client.get(f"/v1/media-sessions/{session_id}")).json()[
        "receivedBytes"
    ] == len(first)

    assert (await upload_part(client, session_id, 1, second)).status_code == 204
    completed = await client.post(
        f"/v1/media-sessions/{session_id}/complete",
        json={"partCount": 2, "totalBytes": 20},
    )

    assert completed.status_code == 200
    assert completed.json() == {
        "sessionId": session_id,
        "contentId": CONTENT_ID,
        "kind": "mp4",
        "status": "complete",
        "totalBytes": 20,
        "partCount": 2,
    }
    async with factory() as session:
        upload = await session.get(MediaUploadSession, session_id)
        artifact = media_root / upload.directory_key / "media.mp4"
        assert artifact.read_bytes() == first + second
        assert list(artifact.parent.glob("part-*.bin")) == []


@pytest.mark.asyncio
async def test_complete_upload_retries_dispatch_after_the_first_attempt_fails(
    media_context, monkeypatch
):
    client, _, factory, _ = media_context
    created = await create_session(client, expected_bytes=5, part_count=1)
    session_id = created.json()["sessionId"]
    await upload_part(client, session_id, 0, b"media")
    async with factory() as session:
        video = await session.scalar(select(Video).where(Video.content_id == CONTENT_ID))
        job = AnalysisJob(
            id="waiting-job",
            installation_id=INSTALLATION_ID,
            video_id=video.video_id,
            content_id=video.content_id,
            source_language="auto",
            target_language="zh-Hans",
            transcript_version="pending:waiting-job",
            cache_key=f"pending:{INSTALLATION_ID}:waiting-job",
            status="waiting_for_media",
        )
        session.add(job)
        await session.commit()

    attempts = []
    successful_dispatches = []

    def dispatch(job_id, *, resume):
        attempts.append((job_id, resume))
        if len(attempts) == 1:
            raise ConnectionError("redis unavailable")
        successful_dispatches.append(job_id)

    monkeypatch.setattr(worker_tasks.analyze_video, "delay", dispatch)
    payload = {"partCount": 1, "totalBytes": 5}

    first = await client.post(f"/v1/media-sessions/{session_id}/complete", json=payload)
    assert first.status_code == 200
    async with factory() as session:
        job = await session.get(AnalysisJob, "waiting-job")
        upload = await session.get(MediaUploadSession, session_id)
        assert job.status == "waiting_for_media"
        assert job.media_session_id is None
        assert upload.status == "complete"

    second = await client.post(f"/v1/media-sessions/{session_id}/complete", json=payload)

    assert second.status_code == 200
    assert attempts == [("waiting-job", True), ("waiting-job", True)]
    assert successful_dispatches == ["waiting-job"]
    async with factory() as session:
        job = await session.get(AnalysisJob, "waiting-job")
        upload = await session.get(MediaUploadSession, session_id)
        assert job.status == "queued"
        assert job.media_session_id == session_id
        assert upload.status == "complete"


@pytest.mark.asyncio
async def test_every_media_mutation_consumes_the_installation_write_quota(media_context):
    client, app, _, _ = media_context
    limiter = TrackingQuotaLimiter()
    app.dependency_overrides[get_quota_limiter] = lambda: limiter
    created = await create_session(client, expected_bytes=4, part_count=1)
    session_id = created.json()["sessionId"]

    await client.get(f"/v1/media-sessions/{session_id}")
    await upload_part(client, session_id, 0, b"part")
    await client.post(
        f"/v1/media-sessions/{session_id}/complete",
        json={"partCount": 1, "totalBytes": 4},
    )
    await client.delete(f"/v1/media-sessions/{session_id}")

    assert limiter.calls == [
        (INSTALLATION_ID, "write", 20),
        (INSTALLATION_ID, "read", 120),
        (INSTALLATION_ID, "write", 20),
        (INSTALLATION_ID, "write", 20),
        (INSTALLATION_ID, "write", 20),
    ]


@pytest.mark.asyncio
async def test_create_bounds_and_strictly_validates_body_after_auth_and_quota(
    media_context,
):
    client, app, _, _ = media_context
    limiter = TrackingQuotaLimiter()
    app.dependency_overrides[get_quota_limiter] = lambda: limiter

    unknown = await client.post(
        "/v1/media-sessions",
        json={
            "contentId": CONTENT_ID,
            "kind": "mp4",
            "expectedBytes": 4,
            "partCount": 1,
            "clientPath": "/private/client/video.mp4",
        },
    )
    oversized = await client.post(
        "/v1/media-sessions",
        json={
            "contentId": CONTENT_ID,
            "kind": "mp4",
            "expectedBytes": 4,
            "partCount": 1,
            "padding": "x" * (64 * 1024),
        },
    )
    unauthorized = await client.post(
        "/v1/media-sessions",
        content=b"x" * (64 * 1024 + 1),
        headers={
            "Authorization": "Bearer invalid",
            "Content-Type": "application/json",
        },
    )

    assert unknown.status_code == 422
    assert unknown.json()["detail"]["code"] == "invalid_create_body"
    assert "/private/client/video.mp4" not in unknown.text
    assert oversized.status_code == 413
    assert oversized.json()["detail"]["code"] == "create_body_too_large"
    assert unauthorized.status_code == 401
    assert limiter.calls == [
        (INSTALLATION_ID, "write", 20),
        (INSTALLATION_ID, "write", 20),
    ]


@pytest.mark.asyncio
async def test_unauthenticated_create_is_rejected_without_reading_body(media_context):
    _, app, _, _ = media_context
    response_status = None

    async def receive():
        raise AssertionError("request body must not be read before authentication")

    async def send(message):
        nonlocal response_status
        if message["type"] == "http.response.start":
            response_status = message["status"]

    await app(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/v1/media-sessions",
            "raw_path": b"/v1/media-sessions",
            "query_string": b"",
            "root_path": "",
            "server": ("test", 80),
            "client": ("127.0.0.1", 1234),
            "headers": [
                (b"authorization", b"Bearer invalid"),
                (b"x-veeky-installation-id", INSTALLATION_ID.encode()),
                (b"content-type", b"application/json"),
                (b"content-length", str(64 * 1024 + 1).encode()),
            ],
        },
        receive,
        send,
    )

    assert response_status == 401


def test_media_uploads_default_to_one_active_session_per_installation():
    settings = Settings(_env_file=None)

    assert settings.max_active_media_upload_sessions_per_installation == 1


@pytest.mark.asyncio
async def test_create_enforces_active_session_and_reserved_byte_caps(media_context):
    client, _, _, _ = media_context
    first = await create_session(client, expected_bytes=20, part_count=2)
    second = await create_session(client, expected_bytes=20, part_count=2)

    assert first.status_code == 201
    assert second.status_code == 201
    active_blocked = await create_session(client, expected_bytes=20, part_count=2)
    assert active_blocked.status_code == 429
    assert active_blocked.json()["detail"]["code"] == "media_session_limit"

    await client.delete(f"/v1/media-sessions/{second.json()['sessionId']}")
    reserved_blocked = await create_session(client, expected_bytes=48, part_count=3)
    assert reserved_blocked.status_code == 429
    assert reserved_blocked.json()["detail"]["code"] == "media_reservation_limit"


@pytest.mark.asyncio
async def test_upload_rejects_bad_checksum_and_conflicting_duplicate(media_context):
    client, _, _, media_root = media_context
    session_id = (await create_session(client)).json()["sessionId"]
    part = b"0123456789abcdef"

    mismatch = await upload_part(client, session_id, 0, part, checksum="0" * 64)
    assert mismatch.status_code == 422
    assert mismatch.json()["detail"]["code"] == "checksum_mismatch"

    assert (await upload_part(client, session_id, 0, part)).status_code == 204
    conflict = await upload_part(client, session_id, 0, b"fedcba9876543210")
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "part_conflict"
    assert list(media_root.glob(".staging/*.tmp")) == []


@pytest.mark.asyncio
async def test_completed_and_consumed_part_retries_use_database_metadata(media_context):
    client, _, factory, media_root = media_context
    session_id = (
        await create_session(client, expected_bytes=4, part_count=1)
    ).json()["sessionId"]
    await upload_part(client, session_id, 0, b"part")
    completed = await client.post(
        f"/v1/media-sessions/{session_id}/complete",
        json={"partCount": 1, "totalBytes": 4},
    )
    assert completed.status_code == 200

    assert (await upload_part(client, session_id, 0, b"part")).status_code == 204
    async with factory() as session:
        upload = await session.get(MediaUploadSession, session_id)
        upload.status = "consumed"
        await session.commit()
    assert (await upload_part(client, session_id, 0, b"part")).status_code == 204

    conflict = await upload_part(client, session_id, 0, b"nope")
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "invalid_upload_state"
    assert list(media_root.glob(".staging/*.tmp")) == []


@pytest.mark.asyncio
async def test_uploading_a_new_part_does_not_rehash_prior_parts(
    media_context, monkeypatch
):
    client, _, _, _ = media_context
    session_id = (
        await create_session(client, expected_bytes=40, part_count=3)
    ).json()["sessionId"]
    await upload_part(client, session_id, 0, b"0123456789abcdef")

    def reject_rehash(path):
        raise AssertionError(f"unexpected rehash: {path.name}")

    monkeypatch.setattr(media_upload, "_file_identity", reject_rehash)

    response = await upload_part(client, session_id, 1, b"fedcba9876543210")

    assert response.status_code == 204


@pytest.mark.asyncio
async def test_part_metadata_is_recorded_only_after_directory_fsync(
    media_context, monkeypatch
):
    client, _, factory, media_root = media_context
    session_id = (
        await create_session(client, expected_bytes=4, part_count=1)
    ).json()["sessionId"]

    def fail_directory_fsync(directory):
        raise OSError("injected directory fsync failure")

    monkeypatch.setattr(media_upload, "_fsync_directory_sync", fail_directory_fsync)
    response = await upload_part(client, session_id, 0, b"part")

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "storage_unavailable"
    async with factory() as session:
        upload = await session.get(MediaUploadSession, session_id)
        parts = list(
            await session.scalars(
                select(MediaUploadPart).where(MediaUploadPart.session_id == session_id)
            )
        )
        assert upload.status == "created"
        assert upload.received_bytes == 0
        assert parts == []
        directory = media_root / upload.directory_key
        assert list(directory.glob("part-*.bin")) == []


@pytest.mark.asyncio
async def test_slow_media_filesystem_work_does_not_block_the_event_loop(
    media_context, monkeypatch
):
    client, _, _, _ = media_context
    session_id = (await create_session(client)).json()["sessionId"]
    await upload_part(client, session_id, 0, b"0123456789abcdef")
    await upload_part(client, session_id, 1, b"tail")
    original_assemble = media_upload._assemble_mp4_sync

    def slow_assemble(*args):
        time.sleep(0.1)
        return original_assemble(*args)

    monkeypatch.setattr(media_upload, "_assemble_mp4_sync", slow_assemble)
    started = time.monotonic()
    marker_at = None

    async def marker():
        nonlocal marker_at
        await asyncio.sleep(0.01)
        marker_at = time.monotonic()

    await asyncio.gather(
        marker(),
        client.post(
            f"/v1/media-sessions/{session_id}/complete",
            json={"partCount": 2, "totalBytes": 20},
        ),
    )

    assert marker_at is not None
    assert marker_at - started < 0.08


@pytest.mark.asyncio
async def test_upload_validates_size_cap_part_shape_and_content(media_context):
    client, _, _, _ = media_context

    too_large = await create_session(client, expected_bytes=65, part_count=5)
    assert too_large.status_code == 422
    assert too_large.json()["detail"]["code"] == "media_too_large"

    missing = await client.post(
        "/v1/media-sessions",
        json={
            "contentId": "44444444-4444-4444-8444-444444444444",
            "kind": "mp4",
            "expectedBytes": 1,
            "partCount": 1,
        },
    )
    assert missing.status_code == 404

    session_id = (await create_session(client)).json()["sessionId"]
    wrong_size = await upload_part(client, session_id, 0, b"short")
    assert wrong_size.status_code == 422
    assert wrong_size.json()["detail"]["code"] == "invalid_part_size"
    assert (await upload_part(client, session_id, 2, b"x")).status_code == 422


@pytest.mark.asyncio
async def test_incomplete_upload_cannot_complete(media_context):
    client, _, _, _ = media_context
    session_id = (await create_session(client)).json()["sessionId"]
    await upload_part(client, session_id, 0, b"0123456789abcdef")

    response = await client.post(
        f"/v1/media-sessions/{session_id}/complete",
        json={"partCount": 2, "totalBytes": 20},
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "upload_incomplete"


@pytest.mark.asyncio
async def test_complete_rejects_a_part_changed_after_it_was_verified(media_context):
    client, _, factory, media_root = media_context
    session_id = (await create_session(client)).json()["sessionId"]
    await upload_part(client, session_id, 0, b"0123456789abcdef")
    await upload_part(client, session_id, 1, b"tail")

    async with factory() as session:
        upload = await session.get(MediaUploadSession, session_id)
        changed_part = media_root / upload.directory_key / "part-00000000.bin"
        changed_part.write_bytes(b"fedcba9876543210")

    response = await client.post(
        f"/v1/media-sessions/{session_id}/complete",
        json={"partCount": 2, "totalBytes": 20},
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "part_integrity_failed"
    status = await client.get(f"/v1/media-sessions/{session_id}")
    assert status.json()["status"] == "failed"


@pytest.mark.asyncio
async def test_mp4_assembly_releases_parts_as_the_output_grows(
    media_context, monkeypatch
):
    client, _, factory, media_root = media_context
    session_id = (await create_session(client)).json()["sessionId"]
    await upload_part(client, session_id, 0, b"0123456789abcdef")
    await upload_part(client, session_id, 1, b"tail")
    async with factory() as session:
        upload = await session.get(MediaUploadSession, session_id)
        directory = media_root / upload.directory_key

    observed_sizes: list[int] = []
    original_fsync = media_upload._fsync_directory_sync

    def observe_directory_size(path):
        observed_sizes.append(
            sum(item.stat().st_size for item in path.iterdir() if item.is_file())
        )
        original_fsync(path)

    monkeypatch.setattr(media_upload, "_fsync_directory_sync", observe_directory_size)

    response = await client.post(
        f"/v1/media-sessions/{session_id}/complete",
        json={"partCount": 2, "totalBytes": 20},
    )

    assert response.status_code == 200
    assert observed_sizes
    assert max(observed_sizes) <= 20
    assert (directory / "media.mp4").read_bytes() == b"0123456789abcdef" + b"tail"


@pytest.mark.asyncio
async def test_mp4_assembly_resumes_after_failure_past_a_durable_part_boundary(
    media_context, monkeypatch
):
    client, _, factory, media_root = media_context
    session_id = (await create_session(client)).json()["sessionId"]
    await upload_part(client, session_id, 0, b"0123456789abcdef")
    await upload_part(client, session_id, 1, b"tail")
    async with factory() as session:
        upload = await session.get(MediaUploadSession, session_id)
        directory = media_root / upload.directory_key

    original_fsync = media_upload._fsync_directory_sync

    def fail_after_first_part_is_released(path):
        if not (path / "part-00000000.bin").exists():
            raise OSError("injected assembly fsync failure")
        original_fsync(path)

    monkeypatch.setattr(
        media_upload,
        "_fsync_directory_sync",
        fail_after_first_part_is_released,
    )

    response = await client.post(
        f"/v1/media-sessions/{session_id}/complete",
        json={"partCount": 2, "totalBytes": 20},
    )

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "storage_unavailable"
    async with factory() as session:
        upload = await session.get(MediaUploadSession, session_id)
        assert upload.status == "uploading"
    assert not (directory / "media.mp4").exists()
    assembly = directory / ".media.mp4.assembling"
    assert assembly.read_bytes() == b"0123456789abcdef"
    assert not (directory / "part-00000000.bin").exists()
    assert (directory / "part-00000001.bin").exists()

    monkeypatch.setattr(media_upload, "_fsync_directory_sync", original_fsync)
    retried = await client.post(
        f"/v1/media-sessions/{session_id}/complete",
        json={"partCount": 2, "totalBytes": 20},
    )

    assert retried.status_code == 200
    assert (directory / "media.mp4").read_bytes() == b"0123456789abcdeftail"
    assert not assembly.exists()


@pytest.mark.asyncio
async def test_mp4_assembly_fsync_failure_after_publish_is_retryable(
    media_context, monkeypatch
):
    client, _, factory, media_root = media_context
    session_id = (
        await create_session(client, expected_bytes=4, part_count=1)
    ).json()["sessionId"]
    await upload_part(client, session_id, 0, b"part")
    async with factory() as session:
        upload = await session.get(MediaUploadSession, session_id)
        directory = media_root / upload.directory_key

    original_fsync = media_upload._fsync_directory_sync

    def fail_after_artifact_publish(path):
        if (path / "media.mp4").exists():
            raise OSError("injected artifact fsync failure")
        original_fsync(path)

    monkeypatch.setattr(
        media_upload, "_fsync_directory_sync", fail_after_artifact_publish
    )

    response = await client.post(
        f"/v1/media-sessions/{session_id}/complete",
        json={"partCount": 1, "totalBytes": 4},
    )

    assert response.status_code == 503
    async with factory() as session:
        upload = await session.get(MediaUploadSession, session_id)
        assert upload.status == "uploading"
    assert (directory / "media.mp4").read_bytes() == b"part"

    monkeypatch.setattr(media_upload, "_fsync_directory_sync", original_fsync)
    retried = await client.post(
        f"/v1/media-sessions/{session_id}/complete",
        json={"partCount": 1, "totalBytes": 4},
    )

    assert retried.status_code == 200
    async with factory() as session:
        upload = await session.get(MediaUploadSession, session_id)
        assert upload.status == "complete"


@pytest.mark.asyncio
async def test_mp4_complete_recovers_published_artifact_after_commit_interruption(
    media_context, monkeypatch
):
    client, _, factory, media_root = media_context
    session_id = (
        await create_session(client, expected_bytes=4, part_count=1)
    ).json()["sessionId"]
    await upload_part(client, session_id, 0, b"part")

    async with factory() as session:
        upload = await get_owned_upload(
            session, media_settings(media_root), session_id, INSTALLATION_ID
        )
        directory = media_root / upload.directory_key

        async def interrupt_commit():
            raise RuntimeError("injected commit interruption")

        monkeypatch.setattr(session, "commit", interrupt_commit)
        with pytest.raises(RuntimeError, match="commit interruption"):
            await complete_upload(
                session, media_settings(media_root), upload, 1, 4, None
            )

    async with factory() as session:
        upload = await session.get(MediaUploadSession, session_id)
        assert upload.status == "uploading"
    assert (directory / "media.mp4").read_bytes() == b"part"
    assert not (directory / "part-00000000.bin").exists()

    retried = await client.post(
        f"/v1/media-sessions/{session_id}/complete",
        json={"partCount": 1, "totalBytes": 4},
    )

    assert retried.status_code == 200
    async with factory() as session:
        upload = await session.get(MediaUploadSession, session_id)
        assert upload.status == "complete"


@pytest.mark.asyncio
async def test_mp4_assembly_truncates_a_partial_tail_before_resuming(media_context):
    client, _, factory, media_root = media_context
    session_id = (await create_session(client)).json()["sessionId"]
    await upload_part(client, session_id, 0, b"0123456789abcdef")
    await upload_part(client, session_id, 1, b"tail")
    async with factory() as session:
        upload = await session.get(MediaUploadSession, session_id)
        directory = media_root / upload.directory_key

    assembly = directory / ".media.mp4.assembling"
    assembly.write_bytes(b"0123456789abcdefta")
    (directory / "part-00000000.bin").unlink()

    response = await client.post(
        f"/v1/media-sessions/{session_id}/complete",
        json={"partCount": 2, "totalBytes": 20},
    )

    assert response.status_code == 200
    assert (directory / "media.mp4").read_bytes() == b"0123456789abcdeftail"
    assert not assembly.exists()


@pytest.mark.asyncio
async def test_mp4_complete_rejects_a_tampered_published_artifact(
    media_context, monkeypatch
):
    client, _, factory, media_root = media_context
    session_id = (
        await create_session(client, expected_bytes=4, part_count=1)
    ).json()["sessionId"]
    await upload_part(client, session_id, 0, b"part")
    async with factory() as session:
        upload = await session.get(MediaUploadSession, session_id)
        directory = media_root / upload.directory_key

    (directory / "media.mp4").write_bytes(b"evil")
    (directory / "part-00000000.bin").unlink()

    def assembly_must_not_run(*args):
        raise AssertionError("published artifacts must be verified directly")

    monkeypatch.setattr(media_upload, "_assemble_mp4_sync", assembly_must_not_run)
    response = await client.post(
        f"/v1/media-sessions/{session_id}/complete",
        json={"partCount": 1, "totalBytes": 4},
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "part_integrity_failed"
    async with factory() as session:
        upload = await session.get(MediaUploadSession, session_id)
        assert upload.status == "failed"


@pytest.mark.asyncio
async def test_mp4_complete_cancellation_holds_lock_until_assembly_finishes(
    media_context, monkeypatch
):
    client, _, factory, media_root = media_context
    settings = media_settings(media_root)
    session_id = (
        await create_session(client, expected_bytes=4, part_count=1)
    ).json()["sessionId"]
    await upload_part(client, session_id, 0, b"part")
    entered = threading.Event()
    release = threading.Event()
    original_assemble = media_upload._assemble_mp4_sync

    def blocked_assemble(*args):
        entered.set()
        assert release.wait(5)
        return original_assemble(*args)

    monkeypatch.setattr(media_upload, "_assemble_mp4_sync", blocked_assemble)

    async def complete_one():
        async with factory() as session:
            upload = await get_owned_upload(
                session, settings, session_id, INSTALLATION_ID
            )
            return await complete_upload(session, settings, upload, 1, 4, None)

    async def acquire_write_lock():
        async with factory() as session:
            await media_upload._serialize_sqlite_write(session)
            await session.rollback()

    complete_task = asyncio.create_task(complete_one())
    assert await asyncio.to_thread(entered.wait, 5)
    complete_task.cancel()
    lock_task = asyncio.create_task(acquire_write_lock())
    await asyncio.sleep(0.05)
    assert not complete_task.done()
    assert not lock_task.done()

    release.set()
    with pytest.raises(asyncio.CancelledError):
        await complete_task
    await asyncio.wait_for(lock_task, timeout=5)

    monkeypatch.setattr(media_upload, "_assemble_mp4_sync", original_assemble)
    retried = await client.post(
        f"/v1/media-sessions/{session_id}/complete",
        json={"partCount": 1, "totalBytes": 4},
    )
    assert retried.status_code == 200


@pytest.mark.asyncio
async def test_hls_manifest_can_only_reference_uploaded_numeric_parts(media_context):
    client, _, factory, media_root = media_context
    session_id = (
        await create_session(client, kind="hls", expected_bytes=20, part_count=2)
    ).json()["sessionId"]
    await upload_part(client, session_id, 0, b"0123456789abcdef")
    await upload_part(client, session_id, 1, b"tail")

    invalid = await client.post(
        f"/v1/media-sessions/{session_id}/complete",
        json={
            "partCount": 2,
            "totalBytes": 20,
            "manifest": {"parts": [0, "https://video.twimg.com/segment.ts"]},
        },
    )
    assert invalid.status_code == 422
    assert invalid.json()["detail"]["code"] == "invalid_hls_manifest"

    completed = await client.post(
        f"/v1/media-sessions/{session_id}/complete",
        json={
            "partCount": 2,
            "totalBytes": 20,
            "manifest": {"parts": [0, 1]},
        },
    )
    assert completed.status_code == 200
    async with factory() as session:
        upload = await session.get(MediaUploadSession, session_id)
        manifest_path = media_root / upload.directory_key / "manifest.json"
        assert manifest_path.read_text() == '{"parts":[0,1]}'


@pytest.mark.asyncio
async def test_complete_rejects_malformed_deep_and_oversized_bodies(media_context):
    client, _, _, _ = media_context
    session_id = (await create_session(client)).json()["sessionId"]

    malformed = await client.post(
        f"/v1/media-sessions/{session_id}/complete",
        content=b"{",
        headers={"Content-Type": "application/json"},
    )
    deep = await client.post(
        f"/v1/media-sessions/{session_id}/complete",
        content=(b'{' + b'"x":{' * 300 + b"}" * 300 + b"}"),
        headers={"Content-Type": "application/json"},
    )
    oversized = await client.post(
        f"/v1/media-sessions/{session_id}/complete",
        content=b"x" * (1024 * 1024 + 1),
        headers={"Content-Type": "application/json"},
    )
    too_many_parts = await client.post(
        f"/v1/media-sessions/{session_id}/complete",
        json={
            "partCount": 2,
            "totalBytes": 20,
            "manifest": {"parts": [0] * 100_001},
        },
    )

    assert malformed.status_code == 422
    assert malformed.json()["detail"]["code"] == "invalid_completion_body"
    assert deep.status_code == 422
    assert deep.json()["detail"]["code"] == "invalid_completion_body"
    assert oversized.status_code == 413
    assert oversized.json()["detail"]["code"] == "completion_body_too_large"
    assert too_many_parts.status_code == 422
    assert too_many_parts.json()["detail"]["code"] == "invalid_hls_manifest"


@pytest.mark.asyncio
async def test_expired_upload_is_cleaned_and_rejects_more_parts(media_context):
    client, _, factory, media_root = media_context
    session_id = (await create_session(client)).json()["sessionId"]
    await upload_part(client, session_id, 0, b"0123456789abcdef")

    async with factory() as session:
        upload = await session.get(MediaUploadSession, session_id)
        directory = media_root / upload.directory_key
        upload.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        await session.commit()
        assert directory.exists()

    status = await client.get(f"/v1/media-sessions/{session_id}")
    assert status.status_code == 200
    assert status.json()["status"] == "expired"
    assert not directory.exists()

    rejected = await upload_part(client, session_id, 1, b"tail")
    assert rejected.status_code == 409
    assert rejected.json()["detail"]["code"] == "upload_expired"


@pytest.mark.asyncio
async def test_create_releases_expired_installation_reservations(media_context):
    client, _, factory, media_root = media_context
    first_id = (await create_session(client)).json()["sessionId"]
    second_id = (await create_session(client)).json()["sessionId"]
    await upload_part(client, first_id, 0, b"0123456789abcdef")
    await upload_part(client, first_id, 1, b"tail")
    completed = await client.post(
        f"/v1/media-sessions/{first_id}/complete",
        json={"partCount": 2, "totalBytes": 20},
    )
    assert completed.status_code == 200

    async with factory() as session:
        first = await session.get(MediaUploadSession, first_id)
        second = await session.get(MediaUploadSession, second_id)
        first_directory = media_root / first.directory_key
        expired_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        first.expires_at = expired_at
        second.expires_at = expired_at
        await session.commit()
        assert first_directory.exists()

    created = await create_session(client, expected_bytes=40, part_count=3)

    assert created.status_code == 201
    async with factory() as session:
        first = await session.get(MediaUploadSession, first_id)
        second = await session.get(MediaUploadSession, second_id)
        assert first.status == "expired"
        assert first.received_bytes == 0
        assert second.status == "expired"
    assert not first_directory.exists()


@pytest.mark.asyncio
async def test_cleanup_primitive_expires_only_due_sessions(media_context):
    client, _, factory, media_root = media_context
    due_id = (await create_session(client)).json()["sessionId"]
    future_id = (await create_session(client)).json()["sessionId"]
    await upload_part(client, due_id, 0, b"0123456789abcdef")
    await upload_part(client, future_id, 0, b"0123456789abcdef")

    async with factory() as session:
        due = await session.get(MediaUploadSession, due_id)
        future = await session.get(MediaUploadSession, future_id)
        due.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        await session.commit()
        due_directory = media_root / due.directory_key
        future_directory = media_root / future.directory_key

    async with factory() as session:
        cleaned = await cleanup_expired_uploads(session, media_settings(media_root))

    assert cleaned == 1
    async with factory() as session:
        due = await session.get(MediaUploadSession, due_id)
        future = await session.get(MediaUploadSession, future_id)
        assert due.status == "expired"
        assert future.status == "uploading"
    assert not due_directory.exists()
    assert future_directory.exists()


@pytest.mark.asyncio
async def test_cleanup_removes_only_old_uuid_staging_files(media_context):
    _, _, factory, media_root = media_context
    settings = media_settings(media_root)
    staging = media_root / ".staging"
    staging.mkdir(parents=True)
    old_file = staging / f"{uuid.uuid4()}.tmp"
    fresh_file = staging / f"{uuid.uuid4()}.tmp"
    malformed_file = staging / "client-upload.tmp"
    symlink_target = media_root / "outside-staging.bin"
    symlink = staging / f"{uuid.uuid4()}.tmp"
    old_file.write_bytes(b"old")
    fresh_file.write_bytes(b"fresh")
    malformed_file.write_bytes(b"malformed")
    symlink_target.write_bytes(b"target")
    symlink.symlink_to(symlink_target)
    old_timestamp = time.time() - settings.media_upload_session_ttl_seconds - 1
    os.utime(old_file, (old_timestamp, old_timestamp))
    os.utime(malformed_file, (old_timestamp, old_timestamp))
    os.utime(symlink_target, (old_timestamp, old_timestamp))
    os.utime(
        symlink, (old_timestamp, old_timestamp), follow_symlinks=False
    )

    async with factory() as session:
        cleaned = await cleanup_expired_uploads(session, settings)

    assert cleaned == 0
    assert not old_file.exists()
    assert fresh_file.read_bytes() == b"fresh"
    assert malformed_file.read_bytes() == b"malformed"
    assert symlink.is_symlink()
    assert symlink_target.read_bytes() == b"target"


@pytest.mark.asyncio
@pytest.mark.parametrize("disappears_at", ["stat", "unlink"])
async def test_cleanup_continues_when_a_staging_entry_disappears(
    media_context, monkeypatch, disappears_at
):
    _, _, factory, media_root = media_context
    settings = media_settings(media_root)
    staging = media_root / ".staging"
    staging.mkdir(parents=True)
    disappearing = staging / f"{uuid.uuid4()}.tmp"
    remaining = staging / f"{uuid.uuid4()}.tmp"
    disappearing.write_bytes(b"gone")
    remaining.write_bytes(b"remove me too")
    old_timestamp = time.time() - settings.media_upload_session_ttl_seconds - 1
    os.utime(disappearing, (old_timestamp, old_timestamp))
    os.utime(remaining, (old_timestamp, old_timestamp))

    original_scandir = os.scandir
    original_unlink = os.unlink

    class EntryProxy:
        def __init__(self, entry):
            self.entry = entry
            self.name = entry.name

        def is_file(self, *, follow_symlinks=True):
            return self.entry.is_file(follow_symlinks=follow_symlinks)

        def stat(self, *, follow_symlinks=True):
            if disappears_at == "stat" and self.name == disappearing.name:
                original_unlink(disappearing)
                raise FileNotFoundError(self.name)
            return self.entry.stat(follow_symlinks=follow_symlinks)

    class ScandirEntries:
        def __init__(self, entries):
            self.entries = entries

        def __enter__(self):
            return iter(self.entries)

        def __exit__(self, exc_type, exc_value, traceback):
            return False

    def ordered_scandir(descriptor):
        with original_scandir(descriptor) as entries:
            proxies = [EntryProxy(entry) for entry in entries]
        proxies.sort(key=lambda entry: entry.name != disappearing.name)
        return ScandirEntries(proxies)

    monkeypatch.setattr(media_upload.os, "scandir", ordered_scandir)

    if disappears_at == "unlink":
        def disappearing_unlink(path, *args, **kwargs):
            original_unlink(path, *args, **kwargs)
            if path == disappearing.name:
                raise FileNotFoundError(path)

        monkeypatch.setattr(media_upload.os, "unlink", disappearing_unlink)

    async with factory() as session:
        cleaned = await cleanup_expired_uploads(session, settings)

    assert cleaned == 0
    assert not disappearing.exists()
    assert not remaining.exists()


@pytest.mark.asyncio
async def test_delete_is_idempotent_and_does_not_touch_other_session(media_context):
    client, _, factory, media_root = media_context
    first_id = (await create_session(client)).json()["sessionId"]
    second_id = (await create_session(client)).json()["sessionId"]
    await upload_part(client, first_id, 0, b"0123456789abcdef")
    await upload_part(client, second_id, 0, b"0123456789abcdef")

    async with factory() as session:
        rows = (
            await session.scalars(
                select(MediaUploadSession).where(
                    MediaUploadSession.id.in_([first_id, second_id])
                )
            )
        ).all()
        directories = {
            row.id: media_root / row.directory_key
            for row in rows
        }

    assert (await client.delete(f"/v1/media-sessions/{first_id}")).status_code == 204
    directories[first_id].mkdir(parents=True)
    (directories[first_id] / "orphan.tmp").write_bytes(b"orphan")
    assert (await client.delete(f"/v1/media-sessions/{first_id}")).status_code == 204
    assert not directories[first_id].exists()
    assert directories[second_id].exists()


@pytest.mark.asyncio
async def test_all_existing_session_routes_hide_cross_installation_access(media_context):
    client, _, _, _ = media_context
    session_id = (await create_session(client)).json()["sessionId"]

    requests = (
        await client.get(
            f"/v1/media-sessions/{session_id}", headers=OTHER_AUTH_HEADERS
        ),
        await client.put(
            f"/v1/media-sessions/{session_id}/parts/0",
            content=b"malformed",
            headers=OTHER_AUTH_HEADERS,
        ),
        await client.post(
            f"/v1/media-sessions/{session_id}/complete",
            content=b"{",
            headers={**OTHER_AUTH_HEADERS, "Content-Type": "application/json"},
        ),
        await client.delete(
            f"/v1/media-sessions/{session_id}", headers=OTHER_AUTH_HEADERS
        ),
    )

    assert [response.status_code for response in requests] == [404, 404, 404, 404]


async def one_chunk(body: bytes):
    yield body


async def seed_postgres_upload(factory, settings) -> tuple[str, Path]:
    async with factory() as session:
        upload = await create_upload_session(
            session,
            settings,
            INSTALLATION_ID,
            CONTENT_ID,
            "mp4",
            4,
            1,
        )
        session_id = upload.id
        directory = Path(settings.media_temp_root) / upload.directory_key
    async with factory() as session:
        upload = await get_owned_upload(
            session, settings, session_id, INSTALLATION_ID
        )
        await store_part(
            session,
            settings,
            upload,
            0,
            hashlib.sha256(b"part").hexdigest(),
            one_chunk(b"part"),
        )
    return session_id, directory


@pytest.mark.asyncio
async def test_sqlite_concurrent_creates_obey_limit_for_fifty_rounds(media_context):
    _, _, factory, media_root = media_context
    settings = media_settings(media_root).model_copy(
        update={"max_active_media_upload_sessions_per_installation": 1}
    )

    async def create_one():
        async with factory() as session:
            return await create_upload_session(
                session,
                settings,
                INSTALLATION_ID,
                CONTENT_ID,
                "mp4",
                4,
                1,
            )

    for _ in range(50):
        results = await asyncio.gather(
            create_one(), create_one(), return_exceptions=True
        )
        created = [
            result for result in results if isinstance(result, MediaUploadSession)
        ]
        errors = [result for result in results if isinstance(result, MediaUploadError)]
        assert len(created) == 1
        assert len(errors) == 1
        assert errors[0].code == "media_session_limit"
        async with factory() as session:
            upload = await get_owned_upload(
                session, settings, created[0].id, INSTALLATION_ID, expire=False
            )
            await delete_upload(session, settings, upload)


@pytest.mark.asyncio
async def test_sqlite_serializes_complete_delete_and_expire_for_fifty_rounds(
    media_context, monkeypatch
):
    _, _, factory, media_root = media_context
    settings = media_settings(media_root)
    original_assemble = media_upload._assemble_mp4_sync
    original_now = media_upload.utc_now

    for round_number in range(50):
        monkeypatch.setattr(media_upload, "utc_now", original_now)
        session_id, directory = await seed_postgres_upload(factory, settings)
        entered = threading.Event()
        release = threading.Event()

        def blocked_assemble(*args):
            entered.set()
            assert release.wait(5)
            return original_assemble(*args)

        monkeypatch.setattr(media_upload, "_assemble_mp4_sync", blocked_assemble)

        async def complete_one():
            async with factory() as session:
                upload = await get_owned_upload(
                    session, settings, session_id, INSTALLATION_ID
                )
                return await complete_upload(session, settings, upload, 1, 4, None)

        complete_task = asyncio.create_task(complete_one())
        assert await asyncio.to_thread(entered.wait, 5)

        if round_number % 2 == 0:

            async def expire_one():
                async with factory() as session:
                    upload = await get_owned_upload(
                        session,
                        settings,
                        session_id,
                        INSTALLATION_ID,
                        expire=False,
                    )
                    await delete_upload(session, settings, upload)

        else:
            future = original_now() + timedelta(hours=2)
            monkeypatch.setattr(media_upload, "utc_now", lambda: future)

            async def expire_one():
                async with factory() as session:
                    return await cleanup_expired_uploads(session, settings)

        expire_task = asyncio.create_task(expire_one())
        await asyncio.sleep(0)
        assert not expire_task.done()
        release.set()
        await complete_task
        await expire_task

        async with factory() as session:
            upload = await session.get(MediaUploadSession, session_id)
            assert upload.status == "expired"
        assert not directory.exists()


@pytest.mark.asyncio
async def test_postgres_concurrent_creates_cannot_exceed_installation_limit(
    postgres_media_context,
):
    factory, base_settings = postgres_media_context
    expired_id, expired_directory = await seed_postgres_upload(factory, base_settings)
    async with factory() as session:
        expired = await session.get(MediaUploadSession, expired_id)
        expired.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        await session.commit()

    settings = base_settings.model_copy(
        update={"max_active_media_upload_sessions_per_installation": 1}
    )

    async def create_one():
        async with factory() as session:
            return await create_upload_session(
                session,
                settings,
                INSTALLATION_ID,
                CONTENT_ID,
                "mp4",
                4,
                1,
            )

    results = await asyncio.gather(create_one(), create_one(), return_exceptions=True)

    assert sum(isinstance(result, MediaUploadSession) for result in results) == 1
    errors = [result for result in results if isinstance(result, MediaUploadError)]
    assert len(errors) == 1
    assert errors[0].code == "media_session_limit"

    async with factory() as session:
        expired = await session.get(MediaUploadSession, expired_id)
        assert expired.status == "expired"
        assert expired.received_bytes == 0
    assert not expired_directory.exists()

    created = next(
        result for result in results if isinstance(result, MediaUploadSession)
    )
    async with factory() as session:
        upload = await get_owned_upload(
            session, settings, created.id, INSTALLATION_ID, expire=False
        )
        await delete_upload(session, settings, upload)

    reservation_settings = base_settings.model_copy(
        update={"max_active_media_upload_sessions_per_installation": 2}
    )

    async def reserve_forty_bytes():
        async with factory() as session:
            return await create_upload_session(
                session,
                reservation_settings,
                INSTALLATION_ID,
                CONTENT_ID,
                "mp4",
                40,
                3,
            )

    reservations = await asyncio.gather(
        reserve_forty_bytes(), reserve_forty_bytes(), return_exceptions=True
    )
    assert sum(
        isinstance(result, MediaUploadSession) for result in reservations
    ) == 1
    reservation_errors = [
        result for result in reservations if isinstance(result, MediaUploadError)
    ]
    assert len(reservation_errors) == 1
    assert reservation_errors[0].code == "media_reservation_limit"


@pytest.mark.asyncio
async def test_postgres_complete_blocks_put_without_reverting_complete_state(
    postgres_media_context, monkeypatch
):
    factory, settings = postgres_media_context
    session_id, directory = await seed_postgres_upload(factory, settings)
    entered = threading.Event()
    release = threading.Event()
    put_staged = asyncio.Event()
    staged_path = None
    original_assemble = media_upload._assemble_mp4_sync
    original_write_temporary_part = media_upload._write_temporary_part

    def blocked_assemble(*args):
        entered.set()
        assert release.wait(5)
        return original_assemble(*args)

    async def track_staged_part(*args):
        nonlocal staged_path
        result = await original_write_temporary_part(*args)
        staged_path = args[1]
        put_staged.set()
        return result

    monkeypatch.setattr(media_upload, "_assemble_mp4_sync", blocked_assemble)
    monkeypatch.setattr(
        media_upload,
        "_write_temporary_part",
        track_staged_part,
    )

    async def complete_one():
        async with factory() as session:
            upload = await get_owned_upload(
                session, settings, session_id, INSTALLATION_ID
            )
            return await complete_upload(session, settings, upload, 1, 4, None)

    async def retry_part():
        async with factory() as session:
            upload = await get_owned_upload(
                session, settings, session_id, INSTALLATION_ID
            )
            return await store_part(
                session,
                settings,
                upload,
                0,
                hashlib.sha256(b"part").hexdigest(),
                one_chunk(b"part"),
            )

    complete_task = asyncio.create_task(complete_one())
    assert await asyncio.to_thread(entered.wait, 5)
    put_task = asyncio.create_task(retry_part())
    await asyncio.wait_for(put_staged.wait(), timeout=5)
    assert staged_path is not None
    assert staged_path.parent == Path(settings.media_temp_root).resolve() / ".staging"
    uuid.UUID(staged_path.stem)
    assert not put_task.done()
    release.set()
    artifact = await complete_task
    await put_task

    async with factory() as session:
        upload = await session.get(MediaUploadSession, session_id)
        assert upload.status == "complete"
    assert artifact.path == directory / "media.mp4"
    assert artifact.path.read_bytes() == b"part"
    assert list(Path(settings.media_temp_root).glob(".staging/*.tmp")) == []


@pytest.mark.asyncio
async def test_postgres_complete_serializes_delete_and_expiration(
    postgres_media_context, monkeypatch
):
    factory, settings = postgres_media_context
    session_id, directory = await seed_postgres_upload(factory, settings)
    entered = threading.Event()
    release = threading.Event()
    original_assemble = media_upload._assemble_mp4_sync

    def blocked_assemble(*args):
        entered.set()
        assert release.wait(5)
        return original_assemble(*args)

    monkeypatch.setattr(media_upload, "_assemble_mp4_sync", blocked_assemble)

    async def complete_one():
        async with factory() as session:
            upload = await get_owned_upload(
                session, settings, session_id, INSTALLATION_ID
            )
            return await complete_upload(session, settings, upload, 1, 4, None)

    async def delete_one():
        async with factory() as session:
            upload = await get_owned_upload(
                session, settings, session_id, INSTALLATION_ID, expire=False
            )
            await delete_upload(session, settings, upload)

    complete_task = asyncio.create_task(complete_one())
    assert await asyncio.to_thread(entered.wait, 5)
    delete_task = asyncio.create_task(delete_one())
    await asyncio.sleep(0.05)
    assert not delete_task.done()
    release.set()
    await complete_task
    await delete_task

    async with factory() as session:
        upload = await session.get(MediaUploadSession, session_id)
        assert upload.status == "expired"
    assert not directory.exists()

    expiring_id, expiring_directory = await seed_postgres_upload(factory, settings)
    entered.clear()
    release.clear()
    complete_task = asyncio.create_task(
        _complete_postgres_upload(factory, settings, expiring_id)
    )
    assert await asyncio.to_thread(entered.wait, 5)
    real_now = datetime.now(timezone.utc)
    monkeypatch.setattr(
        media_upload,
        "utc_now",
        lambda: real_now + timedelta(hours=2),
    )

    async def expire_due():
        async with factory() as session:
            return await cleanup_expired_uploads(session, settings)

    expire_task = asyncio.create_task(expire_due())
    await asyncio.sleep(0.05)
    assert not expire_task.done()
    release.set()
    await complete_task
    assert await expire_task == 1
    async with factory() as session:
        upload = await session.get(MediaUploadSession, expiring_id)
        assert upload.status == "expired"
    assert not expiring_directory.exists()


@pytest.mark.asyncio
async def test_postgres_job_lease_claim_and_expiry_takeover_are_atomic(
    postgres_media_context,
):
    factory, _ = postgres_media_context
    async with factory() as session:
        session.add(
            AnalysisJob(
                id="postgres-lease-job",
                installation_id=INSTALLATION_ID,
                video_id="x:2075545587093807111:1",
                content_id=CONTENT_ID,
                source_language="auto",
                target_language="zh-Hans",
                transcript_version="pending:postgres-lease-job",
                cache_key="pending:postgres-lease-job",
                status="queued",
            )
        )
        await session.commit()

    async def claim():
        async with factory() as session:
            return await claim_job_lease(
                session,
                "postgres-lease-job",
                resume=True,
                lease_seconds=60,
            )

    first, second = await asyncio.gather(claim(), claim())
    owner = first if first.token is not None else second
    duplicate = second if first.token is not None else first
    assert owner.token is not None
    assert duplicate.token is None
    assert duplicate.retry_at is not None

    lock_wait_job_id = "postgres-lease-job"
    async with factory() as session:
        job = await session.get(AnalysisJob, lock_wait_job_id)
        job.status = "downloading_media"
        job.lease_token = "owner-before-lock-wait"
        job.lease_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        await session.commit()

    async with factory() as locking_session:
        locked_job = await locking_session.scalar(
            select(AnalysisJob)
            .where(AnalysisJob.id == lock_wait_job_id)
            .with_for_update()
        )
        locked_job.lease_expires_at = datetime.now(timezone.utc) + timedelta(seconds=0.5)
        await locking_session.flush()

        async def claim_after_lock_wait():
            async with factory() as session:
                return await claim_job_lease(
                    session,
                    lock_wait_job_id,
                    resume=True,
                    lease_seconds=60,
                )

        waiting_claim = asyncio.create_task(claim_after_lock_wait())
        await asyncio.sleep(0.1)
        assert not waiting_claim.done()
        await asyncio.sleep(0.5)
        await locking_session.commit()

    lock_wait_replacement = await waiting_claim
    assert lock_wait_replacement.token is not None
    assert lock_wait_replacement.token != "owner-before-lock-wait"

    async with factory() as session:
        job = await session.get(AnalysisJob, "postgres-lease-job")
        job.lease_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        await session.commit()

    replacement = await claim()
    assert replacement.token is not None
    assert replacement.token != owner.token
    async with factory() as session:
        assert not await update_owned_job(
            session,
            "postgres-lease-job",
            owner.token,
            lease_seconds=60,
            values={"status": "analyzing"},
        )


async def _complete_postgres_upload(factory, settings, session_id):
    async with factory() as session:
        upload = await get_owned_upload(session, settings, session_id, INSTALLATION_ID)
        return await complete_upload(session, settings, upload, 1, 4, None)


def test_media_byte_counters_support_the_configured_four_gibibyte_default():
    table = MediaUploadSession.__table__

    assert isinstance(table.c.expected_bytes.type, BigInteger)
    assert isinstance(table.c.received_bytes.type, BigInteger)
    assert isinstance(table.c.part_size_bytes.type, BigInteger)
    assert "ix_media_upload_sessions_content_id" in {
        index.name for index in table.indexes
    }
    part_table = MediaUploadPart.__table__
    assert isinstance(part_table.c.byte_size.type, BigInteger)
    assert {column.name for column in part_table.primary_key.columns} == {
        "session_id",
        "part_number",
    }
