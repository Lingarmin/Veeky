import base64
import binascii
import os
from functools import lru_cache
from typing import Literal, Self
from urllib.parse import urlsplit, urlunsplit

from pydantic import Field, PositiveInt, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = (
        "postgresql+asyncpg://youtube_preview:youtube_preview@localhost:5432/"
        "youtube_preview"
    )
    redis_url: str = "redis://localhost:6379/0"
    libretranslate_url: str = "http://localhost:5000"
    libretranslate_api_key: SecretStr | None = None
    libretranslate_version: str = "1.6.5"
    youtube_transcript_proxy_url: str | None = None
    analysis_provider_api_key: SecretStr | None = None
    analysis_provider_url: str = ""
    analysis_provider_model: str = "kimi-k2.5"
    analysis_provider_version: str = "v1"
    analysis_prompt_version: str = "v1"
    environment: Literal["development", "production"] = "development"
    allowed_chrome_extension_origins: list[str] = Field(default_factory=list)
    llm_credential_ttl_seconds: PositiveInt = 3600
    write_rate_limit_per_minute: PositiveInt = 20
    read_rate_limit_per_minute: PositiveInt = 120
    max_active_jobs_per_installation: PositiveInt = 1
    max_video_duration_seconds: PositiveInt = 14400
    llm_credential_encryption_key: SecretStr | None = None

    @model_validator(mode="after")
    def require_valid_encryption_key_in_production(self) -> Self:
        if self.environment != "production":
            return self
        if self.llm_credential_encryption_key is None:
            raise ValueError(
                "LLM_CREDENTIAL_ENCRYPTION_KEY is required in production"
            )
        try:
            decoded_key = base64.b64decode(
                self.llm_credential_encryption_key.get_secret_value(),
                validate=True,
            )
        except (binascii.Error, ValueError) as error:
            raise ValueError(
                "LLM_CREDENTIAL_ENCRYPTION_KEY must be valid base64"
            ) from error
        if len(decoded_key) != 32:
            raise ValueError(
                "LLM_CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes"
            )
        return self

    @model_validator(mode="after")
    def replace_loopback_proxy_inside_docker(self) -> Self:
        if (
            os.getenv("RUNNING_IN_DOCKER") != "true"
            or not self.youtube_transcript_proxy_url
        ):
            return self
        parsed = urlsplit(self.youtube_transcript_proxy_url)
        if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            return self
        try:
            port = f":{parsed.port}" if parsed.port else ""
        except ValueError:
            return self
        credentials = ""
        if parsed.username:
            credentials = parsed.username
            if parsed.password:
                credentials = f"{credentials}:{parsed.password}"
            credentials = f"{credentials}@"
        self.youtube_transcript_proxy_url = urlunsplit(
            (
                parsed.scheme,
                f"{credentials}host.docker.internal{port}",
                parsed.path,
                parsed.query,
                parsed.fragment,
            )
        )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
