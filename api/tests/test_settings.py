import base64

import pytest
from httpx import ASGITransport, AsyncClient

from app import main
from app.core.settings import Settings


def test_security_and_quota_settings_have_safe_defaults():
    settings = Settings(_env_file=None)

    assert settings.llm_credential_ttl_seconds == 3600
    assert settings.write_rate_limit_per_minute == 20
    assert settings.read_rate_limit_per_minute == 120
    assert settings.max_active_jobs_per_installation == 1
    assert settings.max_video_duration_seconds == 14400
    assert settings.llm_credential_encryption_key is None


def test_production_settings_require_a_32_byte_base64_encryption_key():
    key = base64.b64encode(b"a" * 32).decode("ascii")

    settings = Settings(
        _env_file=None,
        environment="production",
        llm_credential_encryption_key=key,
    )

    assert settings.llm_credential_encryption_key is not None
    assert settings.llm_credential_encryption_key.get_secret_value() == key


@pytest.mark.parametrize("key", [None, "not-base64", base64.b64encode(b"a" * 31).decode("ascii")])
def test_production_settings_reject_missing_or_invalid_encryption_keys(key):
    with pytest.raises(ValueError):
        Settings(
            _env_file=None,
            environment="production",
            llm_credential_encryption_key=key,
        )


def test_settings_include_service_urls_analysis_model_and_extension_origins():
    settings = Settings(
        database_url="postgresql+asyncpg://db.example/youtube",
        redis_url="redis://redis.example/2",
        libretranslate_url="http://translate.example",
        libretranslate_api_key="translate-secret",
        libretranslate_version="1.6.6",
        analysis_provider_api_key="analysis-secret",
        analysis_provider_model="analysis-model",
        analysis_provider_version="v2",
        analysis_prompt_version="v3",
        youtube_transcript_proxy_url="http://127.0.0.1:7890",
        allowed_chrome_extension_origins=["chrome-extension://abc"],
    )

    assert str(settings.database_url) == "postgresql+asyncpg://db.example/youtube"
    assert str(settings.redis_url) == "redis://redis.example/2"
    assert settings.libretranslate_url == "http://translate.example"
    assert settings.libretranslate_api_key.get_secret_value() == "translate-secret"
    assert settings.libretranslate_version == "1.6.6"
    assert settings.analysis_provider_api_key.get_secret_value() == "analysis-secret"
    assert settings.analysis_provider_model == "analysis-model"
    assert settings.analysis_provider_version == "v2"
    assert settings.analysis_prompt_version == "v3"
    assert settings.youtube_transcript_proxy_url == "http://127.0.0.1:7890"
    assert settings.allowed_chrome_extension_origins == ["chrome-extension://abc"]


@pytest.mark.asyncio
async def test_app_allows_configured_chrome_extension_origin():
    assert hasattr(main, "create_app")
    origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
    test_app = main.create_app(
        Settings(allowed_chrome_extension_origins=[origin])
    )

    async with AsyncClient(
        transport=ASGITransport(app=test_app), base_url="http://testserver"
    ) as client:
        response = await client.options(
            "/health",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "GET",
            },
        )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin


def test_settings_use_the_host_proxy_from_inside_docker(monkeypatch):
    monkeypatch.setenv("RUNNING_IN_DOCKER", "true")

    settings = Settings(
        youtube_transcript_proxy_url="http://127.0.0.1:7890",
    )

    assert settings.youtube_transcript_proxy_url == "http://host.docker.internal:7890"


@pytest.mark.asyncio
async def test_development_app_allows_a_local_chrome_extension_origin_without_known_id():
    origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
    test_app = main.create_app(Settings(_env_file=None))

    async with AsyncClient(
        transport=ASGITransport(app=test_app), base_url="http://testserver"
    ) as client:
        response = await client.options(
            "/v1/videos/inspect",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
