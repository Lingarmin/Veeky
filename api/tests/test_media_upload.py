from __future__ import annotations

import hashlib
import os
from collections.abc import AsyncIterator
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import BigInteger, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.settings import Settings
from app.db.models import Base, MediaUploadSession, Video
from app.db.session import get_session
from app.main import create_app
from app.security.quotas import get_quota_limiter


INSTALLATION_ID = "11111111-1111-4111-8111-111111111111"
INSTALLATION_TOKEN = "installation-token-with-at-least-forty-three-characters"
OTHER_INSTALLATION_ID = "22222222-2222-4222-8222-222222222222"
OTHER_INSTALLATION_TOKEN = "other-installation-token-with-at-least-forty-three-characters"
CONTENT_ID = "33333333-3333-4333-8333-333333333333"
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
    settings = Settings(
        media_temp_root=str(media_root),
        media_chunk_bytes=16,
        max_media_bytes=64,
        media_upload_session_ttl_seconds=3600,
    )
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

        yield client, factory, media_root

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
    client, factory, media_root = media_context
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


@pytest.mark.asyncio
async def test_upload_rejects_bad_checksum_and_conflicting_duplicate(media_context):
    client, _, _ = media_context
    session_id = (await create_session(client)).json()["sessionId"]
    part = b"0123456789abcdef"

    mismatch = await upload_part(client, session_id, 0, part, checksum="0" * 64)
    assert mismatch.status_code == 422
    assert mismatch.json()["detail"]["code"] == "checksum_mismatch"

    assert (await upload_part(client, session_id, 0, part)).status_code == 204
    conflict = await upload_part(client, session_id, 0, b"fedcba9876543210")
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "part_conflict"


@pytest.mark.asyncio
async def test_upload_validates_size_cap_part_shape_and_content(media_context):
    client, _, _ = media_context

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
    client, _, _ = media_context
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
    client, factory, media_root = media_context
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
async def test_hls_manifest_can_only_reference_uploaded_numeric_parts(media_context):
    client, factory, media_root = media_context
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
async def test_expired_upload_is_cleaned_and_rejects_more_parts(media_context):
    client, factory, media_root = media_context
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
async def test_delete_is_idempotent_and_does_not_touch_other_session(media_context):
    client, factory, media_root = media_context
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
    assert (await client.delete(f"/v1/media-sessions/{first_id}")).status_code == 204
    assert not directories[first_id].exists()
    assert directories[second_id].exists()


@pytest.mark.asyncio
async def test_all_existing_session_routes_hide_cross_installation_access(media_context):
    client, _, _ = media_context
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
            json={"partCount": 2, "totalBytes": 20},
            headers=OTHER_AUTH_HEADERS,
        ),
        await client.delete(
            f"/v1/media-sessions/{session_id}", headers=OTHER_AUTH_HEADERS
        ),
    )

    assert [response.status_code for response in requests] == [404, 404, 404, 404]


def test_media_byte_counters_support_the_configured_four_gibibyte_default():
    table = MediaUploadSession.__table__

    assert isinstance(table.c.expected_bytes.type, BigInteger)
    assert isinstance(table.c.received_bytes.type, BigInteger)
