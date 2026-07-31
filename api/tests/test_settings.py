import pytest
from httpx import ASGITransport, AsyncClient

from app import main
from app.core.settings import Settings


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
