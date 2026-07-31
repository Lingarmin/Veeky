from collections.abc import Awaitable, Callable

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app, get_postgresql_health_check, get_redis_health_check


HealthCheck = Callable[[], Awaitable[None]]


@pytest.fixture(autouse=True)
def clear_dependency_overrides():
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


async def _healthy_check() -> None:
    return None


async def _get_health():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        return await client.get("/health")


async def test_health_returns_ok_when_postgresql_and_redis_are_available():
    app.dependency_overrides[get_postgresql_health_check] = lambda: _healthy_check
    app.dependency_overrides[get_redis_health_check] = lambda: _healthy_check

    response = await _get_health()

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def _postgresql_down() -> None:
    raise ConnectionError("postgresql is unavailable")


async def test_health_returns_machine_readable_503_when_postgresql_is_down():
    app.dependency_overrides[get_postgresql_health_check] = lambda: _postgresql_down
    app.dependency_overrides[get_redis_health_check] = lambda: _healthy_check

    response = await _get_health()

    assert response.status_code == 503
    assert response.json() == {
        "status": "unhealthy",
        "checks": {"api": "ok", "postgresql": "error", "redis": "ok"},
        "failed_dependencies": ["postgresql"],
    }


async def _redis_down() -> None:
    raise TimeoutError("redis timed out")


async def test_health_reports_all_failed_dependencies():
    app.dependency_overrides[get_postgresql_health_check] = lambda: _postgresql_down
    app.dependency_overrides[get_redis_health_check] = lambda: _redis_down

    response = await _get_health()

    assert response.status_code == 503
    assert response.json()["failed_dependencies"] == ["postgresql", "redis"]
    assert response.json()["checks"] == {
        "api": "ok",
        "postgresql": "error",
        "redis": "error",
    }
