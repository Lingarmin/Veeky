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


def test_media_settings_have_bounded_defaults():
    settings = Settings(_env_file=None)

    assert settings.max_media_bytes == 4 * 1024 * 1024 * 1024
    assert settings.max_temp_bytes_per_job == 6 * 1024 * 1024 * 1024
    assert settings.media_download_timeout_seconds == 1800
    assert settings.media_upload_session_ttl_seconds == 7200
    assert settings.media_chunk_bytes == 8 * 1024 * 1024
    assert settings.max_active_media_upload_sessions_per_installation == 1
    assert settings.asr_job_timeout_seconds == 21600
    assert settings.analysis_job_lease_seconds == 60
    assert settings.media_temp_root == "/var/lib/veeky/media"


def test_media_settings_allow_environment_overrides(monkeypatch):
    monkeypatch.setenv("MAX_MEDIA_BYTES", "1024")
    monkeypatch.setenv("MAX_TEMP_BYTES_PER_JOB", "2048")
    monkeypatch.setenv("MEDIA_DOWNLOAD_TIMEOUT_SECONDS", "30")
    monkeypatch.setenv("MEDIA_UPLOAD_SESSION_TTL_SECONDS", "60")
    monkeypatch.setenv("MEDIA_CHUNK_BYTES", "256")
    monkeypatch.setenv("MAX_ACTIVE_MEDIA_UPLOAD_SESSIONS_PER_INSTALLATION", "2")
    monkeypatch.setenv("ASR_JOB_TIMEOUT_SECONDS", "120")
    monkeypatch.setenv("ANALYSIS_JOB_LEASE_SECONDS", "15")
    monkeypatch.setenv("MEDIA_TEMP_ROOT", "/tmp/veeky-test-media")

    settings = Settings(_env_file=None)

    assert settings.max_media_bytes == 1024
    assert settings.max_temp_bytes_per_job == 2048
    assert settings.media_download_timeout_seconds == 30
    assert settings.media_upload_session_ttl_seconds == 60
    assert settings.media_chunk_bytes == 256
    assert settings.max_active_media_upload_sessions_per_installation == 2
    assert settings.asr_job_timeout_seconds == 120
    assert settings.analysis_job_lease_seconds == 15
    assert settings.media_temp_root == "/tmp/veeky-test-media"


@pytest.mark.parametrize(
    "field",
    [
        "max_media_bytes",
        "max_temp_bytes_per_job",
        "media_download_timeout_seconds",
        "media_upload_session_ttl_seconds",
        "media_chunk_bytes",
        "max_active_media_upload_sessions_per_installation",
        "asr_job_timeout_seconds",
        "analysis_job_lease_seconds",
    ],
)
@pytest.mark.parametrize("invalid_value", [0, -1])
def test_media_settings_reject_non_positive_limits(field, invalid_value):
    with pytest.raises(ValueError):
        Settings(_env_file=None, **{field: invalid_value})


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
