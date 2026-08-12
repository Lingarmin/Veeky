import asyncio
from collections.abc import Awaitable, Callable

import redis.asyncio as redis
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.settings import Settings, get_settings
from app.api.analyses import router as analyses_router
from app.security.installations import router as installations_router


HealthCheck = Callable[[], Awaitable[None]]


async def _check_postgresql(database_url: str) -> None:
    engine = create_async_engine(database_url)
    try:
        async with engine.connect() as connection:
            await connection.execute(text("SELECT 1"))
    finally:
        await engine.dispose()


async def _check_redis(redis_url: str) -> None:
    client = redis.from_url(redis_url)
    try:
        await client.ping()
    finally:
        await client.aclose()


def get_postgresql_health_check(
    settings: Settings = Depends(get_settings),
) -> HealthCheck:
    async def check() -> None:
        await _check_postgresql(settings.database_url)

    return check


def get_redis_health_check(
    settings: Settings = Depends(get_settings),
) -> HealthCheck:
    async def check() -> None:
        await _check_redis(settings.redis_url)

    return check


async def _run_health_check(check: HealthCheck) -> str:
    try:
        await check()
    except Exception:
        return "error"
    return "ok"


async def health(
    postgresql_check: HealthCheck = Depends(get_postgresql_health_check),
    redis_check: HealthCheck = Depends(get_redis_health_check),
):
    postgresql_status, redis_status = await asyncio.gather(
        _run_health_check(postgresql_check),
        _run_health_check(redis_check),
    )
    if postgresql_status == redis_status == "ok":
        return {"status": "ok"}

    checks = {
        "api": "ok",
        "postgresql": postgresql_status,
        "redis": redis_status,
    }
    failed_dependencies = [
        name for name in ("postgresql", "redis") if checks[name] != "ok"
    ]
    return JSONResponse(
        status_code=503,
        content={
            "status": "unhealthy",
            "checks": checks,
            "failed_dependencies": failed_dependencies,
        },
    )


def create_app(settings: Settings | None = None) -> FastAPI:
    application_settings = settings or get_settings()
    application = FastAPI(title="YouTube Preview API")
    local_extension_origin_pattern = (
        r"chrome-extension://[a-p]{32}"
        if (
            application_settings.environment == "development"
            and not application_settings.allowed_chrome_extension_origins
        )
        else None
    )
    application.add_middleware(
        CORSMiddleware,
        allow_origins=application_settings.allowed_chrome_extension_origins,
        allow_origin_regex=local_extension_origin_pattern,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    application.include_router(installations_router)
    application.include_router(analyses_router)
    application.get("/health")(health)
    return application


app = create_app()
