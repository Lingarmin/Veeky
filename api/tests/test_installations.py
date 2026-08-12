from __future__ import annotations

import hashlib
from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.settings import Settings
from app.db.models import Base, Installation
from app.db.session import get_session
from app.main import create_app


INSTALLATION_ID = "11111111-1111-4111-8111-111111111111"
INSTALLATION_ID_WITH_LETTERS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
INSTALLATION_TOKEN = "installation-token-with-at-least-forty-three-characters"
AUTH_HEADERS = {
    "Authorization": f"Bearer {INSTALLATION_TOKEN}",
    "X-Veeky-Installation-Id": INSTALLATION_ID,
}


@pytest.fixture
async def installation_context(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'installations.sqlite'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    app = create_app(Settings())

    async def session_dependency() -> AsyncIterator[AsyncSession]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_session] = session_dependency
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield client, factory
    await engine.dispose()


@pytest.mark.asyncio
async def test_registration_persists_only_the_token_hash(installation_context):
    client, factory = installation_context

    response = await client.post(
        "/v1/installations/register",
        json={
            "installationId": INSTALLATION_ID,
            "installationToken": INSTALLATION_TOKEN,
        },
    )

    assert response.status_code == 201
    assert response.json() == {"installationId": INSTALLATION_ID}
    async with factory() as session:
        row = await session.get(Installation, INSTALLATION_ID)
        assert row is not None
        assert row.token_hash == hashlib.sha256(INSTALLATION_TOKEN.encode()).hexdigest()
        assert INSTALLATION_TOKEN not in str(row.__dict__)


@pytest.mark.asyncio
async def test_registration_is_idempotent_for_matching_credentials(installation_context):
    client, _ = installation_context
    payload = {
        "installationId": INSTALLATION_ID,
        "installationToken": INSTALLATION_TOKEN,
    }

    first = await client.post("/v1/installations/register", json=payload)
    second = await client.post("/v1/installations/register", json=payload)

    assert first.status_code == 201
    assert second.status_code == 200


@pytest.mark.asyncio
async def test_registration_rejects_noncanonical_uppercase_installation_id(
    installation_context,
):
    client, _ = installation_context
    response = await client.post(
        "/v1/installations/register",
        json={
            "installationId": INSTALLATION_ID_WITH_LETTERS.upper(),
            "installationToken": INSTALLATION_TOKEN,
        },
    )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_registration_rejects_a_different_token_for_an_existing_id(
    installation_context,
):
    client, _ = installation_context
    await client.post(
        "/v1/installations/register",
        json={
            "installationId": INSTALLATION_ID,
            "installationToken": INSTALLATION_TOKEN,
        },
    )

    response = await client.post(
        "/v1/installations/register",
        json={
            "installationId": INSTALLATION_ID,
            "installationToken": "a-different-installation-token-with-forty-three-chars",
        },
    )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "installation_auth_required"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "path", "json"),
    [
        ("POST", "/v1/llm/test", {"apiUrl": "https://api.example.com", "apiKey": "x"}),
        ("POST", "/v1/videos/inspect", {"url": "https://youtu.be/aircAruvnKk"}),
        (
            "POST",
            "/v1/analyses",
            {"videoId": "aircAruvnKk", "sourceLanguage": "en"},
        ),
        ("GET", "/v1/analyses/history", None),
        ("GET", "/v1/analyses/11111111-1111-4111-8111-111111111111", None),
        (
            "GET",
            "/v1/analyses/11111111-1111-4111-8111-111111111111/result",
            None,
        ),
    ],
)
async def test_protected_endpoints_require_installation_authentication(
    installation_context, method, path, json
):
    client, _ = installation_context

    response = await client.request(method, path, json=json)

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "installation_auth_required"


@pytest.mark.asyncio
async def test_protected_endpoint_rejects_mismatched_token(installation_context):
    client, _ = installation_context
    await client.post(
        "/v1/installations/register",
        json={
            "installationId": INSTALLATION_ID,
            "installationToken": INSTALLATION_TOKEN,
        },
    )

    response = await client.get(
        "/v1/analyses/history",
        headers={
            **AUTH_HEADERS,
            "Authorization": "Bearer wrong-installation-token",
        },
    )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "installation_auth_required"


@pytest.mark.asyncio
async def test_protected_endpoint_rejects_noncanonical_uppercase_installation_id(
    installation_context,
):
    client, _ = installation_context
    await client.post(
        "/v1/installations/register",
        json={
            "installationId": INSTALLATION_ID_WITH_LETTERS,
            "installationToken": INSTALLATION_TOKEN,
        },
    )

    response = await client.get(
        "/v1/analyses/history",
        headers={
            "Authorization": f"Bearer {INSTALLATION_TOKEN}",
            "X-Veeky-Installation-Id": INSTALLATION_ID_WITH_LETTERS.upper(),
        },
    )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "installation_auth_required"


@pytest.mark.asyncio
async def test_valid_authentication_allows_a_protected_endpoint(installation_context):
    client, _ = installation_context
    await client.post(
        "/v1/installations/register",
        json={
            "installationId": INSTALLATION_ID,
            "installationToken": INSTALLATION_TOKEN,
        },
    )

    response = await client.get("/v1/analyses/history", headers=AUTH_HEADERS)

    assert response.status_code == 200


@pytest.mark.asyncio
async def test_health_remains_public(installation_context):
    client, _ = installation_context
    app = client._transport.app

    async def healthy_check():
        return None

    from app.main import get_postgresql_health_check, get_redis_health_check

    app.dependency_overrides[get_postgresql_health_check] = lambda: healthy_check
    app.dependency_overrides[get_redis_health_check] = lambda: healthy_check

    response = await client.get("/health")

    assert response.status_code == 200
