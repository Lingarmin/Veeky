from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from collections import namedtuple

import pytest
from fastapi import HTTPException, Request
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError
from sqlalchemy import select

from app.core.settings import Settings, get_settings
from app.db.models import AnalysisJob, Installation, MediaUploadSession, QuotaUsage
from app.security.admission import acquire_admission_lock, admit_analysis
from app.security.client_ip import client_quota_subject
from app.security.quotas import get_quota_limiter
from app.services.media_upload import create_upload_session
from tests.test_analyses_api import (
    AUTH_HEADERS,
    LLM_CONFIG,
    BoundaryQuotaLimiter,
    FakeXAdapter,
    SourceRegistry,
    api_context,
    get_source_registry,
)
from tests.test_media_upload import (
    CONTENT_ID,
    INSTALLATION_ID,
    media_context,
    media_postgres_url,
    postgres_media_context,
)


def configure(app, **values):
    settings = app.dependency_overrides[get_settings]().model_copy(update=values)
    app.dependency_overrides[get_settings] = lambda: settings
    return settings


async def register(client):
    identifier = str(uuid.uuid4())
    token = uuid.uuid4().hex + uuid.uuid4().hex
    result = await client.post(
        "/v1/installations/register",
        json={
            "installationId": identifier,
            "installationToken": token,
        },
    )
    return result, {
        "X-Veeky-Installation-Id": identifier,
        "Authorization": f"Bearer {token}",
    }


async def analyze(client, headers=None, **extra):
    return await client.post(
        "/v1/analyses",
        headers=headers,
        json={
            "videoId": "aircAruvnKk",
            "sourceLanguage": "en",
            "targetLanguage": "zh-Hans",
            "llmConfig": LLM_CONFIG,
            **extra,
        },
    )


async def upload(client, headers=None):
    return await client.post(
        "/v1/media-sessions",
        headers=headers,
        json={
            "contentId": CONTENT_ID,
            "kind": "mp4",
            "expectedBytes": 20,
            "partCount": 2,
        },
    )


@pytest.mark.asyncio
async def test_registration_daily_cap_cannot_be_reset_by_new_id(api_context):
    client, app, _, _ = api_context
    configure(app, registration_limit_per_ip_per_day=2)
    first, _ = await register(client)
    second, _ = await register(client)
    assert first.status_code == 201
    assert second.status_code == 429
    assert second.json()["detail"]["code"] == "registration_daily_limit"
    assert int(second.headers["Retry-After"]) > 0
    # Authenticating an existing installation never consumes a new identity slot.
    assert (await client.get("/v1/analyses/history")).status_code == 200


@pytest.mark.asyncio
async def test_ip_write_quota_spans_installations_and_ignores_spoofed_headers(
    api_context,
):
    client, app, _, _ = api_context
    _, other = await register(client)
    configure(app, write_rate_limit_per_ip_per_minute=1)
    app.dependency_overrides[get_quota_limiter] = lambda: limiter
    limiter = BoundaryQuotaLimiter()
    first = await client.post(
        "/v1/videos/inspect", json={"url": "https://youtu.be/aircAruvnKk"}
    )
    second = await client.post(
        "/v1/videos/inspect",
        headers={**other, "X-Forwarded-For": "8.8.8.8"},
        json={"url": "https://youtu.be/aircAruvnKk"},
    )
    assert first.status_code == 200
    assert second.status_code == 429


@pytest.mark.asyncio
async def test_global_active_job_limit_is_atomic_across_installations(api_context):
    client, app, factory, dispatched = api_context
    _, other = await register(client)
    configure(app, max_active_jobs_global=1)
    results = await asyncio.gather(analyze(client), analyze(client, other))
    assert sorted(result.status_code for result in results) == [202, 503]
    assert len(dispatched) == 1
    async with factory() as session:
        assert len(list(await session.scalars(select(AnalysisJob)))) == 1


@pytest.mark.asyncio
async def test_same_ip_cannot_expand_active_jobs_by_registering(api_context):
    client, app, factory, _ = api_context
    _, other = await register(client)
    configure(app, max_active_jobs_per_ip=1)
    first = await analyze(client)
    assert first.status_code == 202
    second = await analyze(client, other)
    assert second.status_code == 429
    assert second.json()["detail"]["code"] == "ip_analysis_concurrency_limit"
    async with factory() as session:
        job = await session.get(AnalysisJob, first.json()["jobId"])
        job.status = "failed"
        await session.commit()
    assert (await analyze(client, other)).status_code == 202


@pytest.mark.asyncio
async def test_retry_consumes_daily_budget_but_history_does_not(api_context):
    client, app, factory, _ = api_context
    configure(app, analysis_limit_per_ip_per_day=1)
    first = await analyze(client)
    assert first.status_code == 202
    async with factory() as session:
        job = await session.get(AnalysisJob, first.json()["jobId"])
        job.status = "failed"
        await session.commit()
    retry = await analyze(client)
    assert retry.status_code == 429
    assert retry.json()["detail"]["code"] == "analysis_daily_limit"
    assert (await client.get("/v1/analyses/history")).status_code == 200


@pytest.mark.asyncio
async def test_x_asr_budget_reserves_full_allowed_duration(api_context):
    client, app, _, dispatched = api_context
    configure(app, asr_seconds_per_ip_per_day=14399)
    app.dependency_overrides[get_source_registry] = lambda: SourceRegistry(
        [FakeXAdapter()]
    )
    result = await client.post(
        "/v1/analyses",
        json={
            "contentRef": {
                "platform": "x",
                "sourceContentId": "2075545587093807111",
                "mediaIndex": 1,
            },
            "targetLanguage": "zh-Hans",
            "llmConfig": LLM_CONFIG,
        },
    )
    assert result.status_code == 429
    assert result.json()["detail"]["code"] == "asr_daily_limit"
    assert not dispatched


@pytest.mark.asyncio
async def test_upload_global_reservations_span_installations(media_context):
    client, app, _, _ = media_context
    _, other = await register(client)
    configure(app, max_temp_bytes_global=39)
    first = await upload(client)
    assert first.status_code == 201
    second = await upload(client, other)
    assert second.status_code == 503
    assert second.json()["detail"]["code"] == "media_global_capacity"
    deleted = await client.delete(f"/v1/media-sessions/{first.json()['sessionId']}")
    assert deleted.status_code in (200, 204)
    assert (await upload(client, other)).status_code == 201


@pytest.mark.asyncio
async def test_upload_daily_budget_survives_deletion_and_identity_change(media_context):
    client, app, _, _ = media_context
    _, other = await register(client)
    configure(app, media_bytes_per_ip_per_day=39)
    first = await upload(client)
    assert first.status_code == 201
    await client.delete(f"/v1/media-sessions/{first.json()['sessionId']}")
    second = await upload(client, other)
    assert second.status_code == 429
    assert second.json()["detail"]["code"] == "media_daily_limit"


@pytest.mark.asyncio
async def test_low_disk_rejects_upload_before_creation(media_context, monkeypatch):
    client, app, _, _ = media_context
    configure(app, min_media_free_disk_bytes=100)
    disk = namedtuple("usage", "total used free")
    monkeypatch.setattr("shutil.disk_usage", lambda _: disk(1000, 900, 100))
    result = await upload(client)
    assert result.status_code == 503
    assert result.json()["detail"]["code"] == "media_disk_low"


@pytest.mark.asyncio
async def test_untrusted_peer_cannot_spoof_ip_and_trusted_proxy_uses_rightmost_untrusted(
    api_context,
):
    _, app, _, _ = api_context
    configure(
        app, trusted_proxy_cidrs=["10.0.0.0/8"], registration_limit_per_ip_per_day=1
    )
    async with AsyncClient(
        transport=ASGITransport(app=app, client=("10.0.0.1", 1000)),
        base_url="http://test",
    ) as client:
        client.headers["X-Forwarded-For"] = "1.1.1.1, 203.0.113.10"
        assert (await register(client))[0].status_code == 201
        client.headers["X-Forwarded-For"] = "2.2.2.2, 203.0.113.10"
        assert (await register(client))[0].status_code == 429
        client.headers["X-Forwarded-For"] = "203.0.113.11"
        assert (await register(client))[0].status_code == 201


@pytest.mark.asyncio
async def test_cleanup_retains_active_reservations_and_does_not_touch_history(
    api_context,
):
    from app.db.models import QuotaUsage
    from app.workers.tasks import cleanup_expired_media_sessions_async

    client, app, factory, _ = api_context
    first = await analyze(client)
    assert first.status_code == 202
    async with factory() as session:
        rows = list(await session.scalars(select(QuotaUsage)))
        for row in rows:
            row.created_at = datetime.now(timezone.utc) - timedelta(days=3)
        await session.commit()
    await cleanup_expired_media_sessions_async(
        factory, settings=app.dependency_overrides[get_settings]()
    )
    async with factory() as session:
        rows = list(await session.scalars(select(QuotaUsage)))
        assert len(rows) == 1
        assert rows[0].kind == "analysis"
        job = await session.get(AnalysisJob, first.json()["jobId"])
        job.status = "failed"
        await session.commit()
    await cleanup_expired_media_sessions_async(
        factory, settings=app.dependency_overrides[get_settings]()
    )
    async with factory() as session:
        assert not list(await session.scalars(select(QuotaUsage)))
        assert await session.get(AnalysisJob, first.json()["jobId"]) is not None


@pytest.mark.asyncio
async def test_rejected_upload_commits_completed_expiration_cleanup(media_context):
    client, app, factory, _ = media_context
    first = await upload(client)
    assert first.status_code == 201
    identifier = first.json()["sessionId"]
    async with factory() as session:
        record = await session.get(MediaUploadSession, identifier)
        record.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        await session.commit()
    configure(app, media_bytes_per_ip_per_day=20)
    rejected = await upload(client)
    assert rejected.status_code == 429
    async with factory() as session:
        record = await session.get(MediaUploadSession, identifier)
        assert record.status == "expired"


@pytest.mark.asyncio
async def test_global_daily_budget_spans_networks_and_installations(api_context):
    client, app, factory, _ = api_context
    configure(app, analysis_limit_global_per_day=1)
    first = await analyze(client)
    assert first.status_code == 202
    async with factory() as session:
        job = await session.get(AnalysisJob, first.json()["jobId"])
        job.status = "failed"
        await session.commit()
    async with AsyncClient(
        transport=ASGITransport(app=app, client=("203.0.113.99", 1000)),
        base_url="http://test",
    ) as other:
        response, headers = await register(other)
        assert response.status_code == 201
        rejected = await analyze(other, headers)
        assert rejected.status_code == 429
        assert rejected.json()["detail"]["code"] == "analysis_daily_limit"


@pytest.mark.asyncio
async def test_cache_hit_does_not_charge_again_and_force_run_does(api_context):
    client, app, factory, _ = api_context
    configure(app, analysis_limit_per_ip_per_day=1)
    first = await analyze(client)
    async with factory() as session:
        job = await session.get(AnalysisJob, first.json()["jobId"])
        job.status = "completed"
        job.completed_at = datetime.now(timezone.utc)
        await session.commit()
    cached = await analyze(client)
    assert cached.status_code == 200
    assert cached.json()["cacheHit"] is True
    assert (await analyze(client, force=True)).status_code == 429
    async with factory() as session:
        assert (
            len(
                list(
                    await session.scalars(
                        select(QuotaUsage).where(QuotaUsage.kind == "analysis")
                    )
                )
            )
            == 1
        )


@pytest.mark.parametrize(
    "left,right",
    [
        ("2001:db8:1234:abcd::1", "2001:db8:1234:abcd:ffff::2"),
        ("::ffff:192.0.2.1", "192.0.2.1"),
    ],
)
def test_address_aliases_share_network_budget(left, right):
    settings = Settings(_env_file=None)

    def subject(peer):
        return client_quota_subject(
            Request({"type": "http", "client": (peer, 80), "headers": []}), settings
        )

    assert subject(left) == subject(right)


@pytest.mark.parametrize("forwarded", ["", "not-an-ip", "1.1.1.1,", "1" * 2049])
def test_trusted_proxy_requires_valid_forwarded_chain(forwarded):
    settings = Settings(_env_file=None, trusted_proxy_cidrs=["10.0.0.1/32"])
    request = Request(
        {
            "type": "http",
            "client": ("10.0.0.1", 80),
            "headers": [(b"x-forwarded-for", forwarded.encode())],
        }
    )
    with pytest.raises(HTTPException) as error:
        client_quota_subject(request, settings)
    assert error.value.status_code == 400


@pytest.mark.parametrize("cidr", ["0.0.0.0/0", "::/0"])
def test_cannot_trust_every_client_as_proxy(cidr):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, trusted_proxy_cidrs=[cidr])


@pytest.mark.asyncio
@pytest.mark.parametrize("resource", ["upload", "analysis"])
async def test_postgres_global_admission_is_atomic_across_installations(
    postgres_media_context, resource
):
    factory, base_settings = postgres_media_context
    other_id = str(uuid.uuid4())
    async with factory() as session:
        session.add(Installation(id=other_id, token_hash="f" * 64))
        await session.commit()
    settings = base_settings.model_copy(
        update={
            "max_active_jobs_global": 1,
            "max_active_media_upload_sessions_global": 1,
        }
    )

    async def create_one(installation_id):
        async with factory() as session:
            if resource == "upload":
                return await create_upload_session(
                    session,
                    settings,
                    installation_id,
                    CONTENT_ID,
                    "mp4",
                    4,
                    1,
                    quota_subject=installation_id,
                )
            identifier = str(uuid.uuid4())
            await acquire_admission_lock(session)
            await admit_analysis(
                session, settings, installation_id, installation_id, identifier, "x"
            )
            job = AnalysisJob(
                id=identifier,
                installation_id=installation_id,
                video_id="x:2075545587093807111:1",
                content_id=CONTENT_ID,
                source_language="auto",
                target_language="zh-Hans",
                transcript_version=f"pending:{identifier}",
                cache_key=f"pending:{identifier}",
                status="queued",
            )
            session.add(job)
            await session.commit()
            return job

    results = await asyncio.gather(
        create_one(INSTALLATION_ID), create_one(other_id), return_exceptions=True
    )
    errors = [result for result in results if isinstance(result, HTTPException)]
    assert len(errors) == 1, results
    assert errors[0].status_code == 503
    assert errors[0].detail["code"] == (
        "global_media_session_limit"
        if resource == "upload"
        else "global_analysis_concurrency_limit"
    )
    model = MediaUploadSession if resource == "upload" else AnalysisJob
    async with factory() as session:
        assert len(list(await session.scalars(select(model)))) == 1
        assert len(list(await session.scalars(select(QuotaUsage)))) == 1
