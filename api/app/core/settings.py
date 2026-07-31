from functools import lru_cache

from pydantic import Field, SecretStr
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
    analysis_provider_api_key: SecretStr | None = None
    analysis_provider_model: str = "gpt-4.1-mini"
    allowed_chrome_extension_origins: list[str] = Field(default_factory=list)


@lru_cache
def get_settings() -> Settings:
    return Settings()
