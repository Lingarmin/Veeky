from __future__ import annotations

import base64
import shutil
import wave
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api.analyses import (
    get_job_dispatcher,
    get_session,
    get_transcript_service,
    get_video_metadata_service,
)
from app.core.settings import Settings
from app.db.models import Base
from app.main import create_app
from app.security.credentials import JobCredentialCipher
from app.services.analysis import AnalysisResult, Highlight, TimedSummary
from app.services.transcripts import (
    TranscriptInspection,
    TranscriptSegment,
    TranscriptTrackInfo,
)
from app.security.quotas import get_quota_limiter
from app.services.translation import TranslatedSegment, provider_translation_version
from app.workers.tasks import AnalysisPipeline


class FixedTranscriptService:
    def inspect(self, video_id, preferred_languages=()):
        track = TranscriptTrackInfo("en", "English", False, True)
        return TranscriptInspection(
            video_id=video_id,
            tracks=[track],
            selected=track,
            segments=[
                TranscriptSegment(0, 0, 1000, "Pixels enter the input layer."),
                TranscriptSegment(1, 1000, 1000, "Weights control each connection."),
            ],
            available=True,
        )


class PermissiveQuotaLimiter:
    async def enforce(self, subject, request_class, limit):
        return None

    @asynccontextmanager
    async def installation_create_lock(self, installation_id):
        yield


class FixedVideoMetadataService:
    def duration_ms(self, video_id):
        return 2000


class FixedTranslationProvider:
    name = "kimi"
    version = provider_translation_version(
        "https://api.moonshot.cn/v1/chat/completions",
        provider="kimi",
        version="kimi-k2.5",
    )

    def __init__(self):
        self.calls = 0

    async def translate(self, segments, source_language, target_language):
        self.calls += 1
        return [
            TranslatedSegment(
                segment.segment_id,
                segment.start_ms,
                segment.duration_ms,
                f"译文：{segment.text}",
            )
            for segment in segments
        ]


class FixedAnalysisService:
    async def analyze(self, segments, target_language, *, duration_ms):
        return AnalysisResult(
            one_line_summary="视频用像素和连接权重解释神经网络。",
            summary_points=["输入层接收像素", "权重控制连接强度", "激活值向后传播"],
            chapters=[
                TimedSummary(
                    start_ms=0,
                    end_ms=2000,
                    title="输入与权重",
                    summary="介绍神经网络的基础组成。",
                )
            ],
            highlights=[
                Highlight(
                    start_ms=1000,
                    end_ms=2000,
                    title="连接权重",
                    summary="权重决定信号影响程度。",
                    original_excerpt="Weights control each connection.",
                    translated_excerpt="权重控制每个连接。",
                )
            ],
            model_name="fixed-analysis",
            model_version="test-1",
            generated_at=datetime.now(timezone.utc),
        )


class WavFixtureDownloader:
    def __init__(self, fixture: Path):
        self.fixture = fixture

    async def download(self, _url: str, destination: Path) -> Path:
        shutil.copyfile(self.fixture, destination)
        return destination


class WavFixtureExtractor:
    @staticmethod
    def _duration_ms(path: Path) -> float:
        with wave.open(str(path), "rb") as audio:
            return audio.getnframes() * 1000 / audio.getframerate()

    async def probe_duration_ms(self, media_path: Path) -> float:
        return self._duration_ms(media_path)

    async def probe_audio_duration_ms(self, media_path: Path) -> float:
        return self._duration_ms(media_path)

    async def extract(
        self,
        media_path: Path,
        audio_path: Path,
        *,
        expected_duration_ms: float | None = None,
    ) -> Path:
        assert self._duration_ms(media_path) == expected_duration_ms
        shutil.copyfile(media_path, audio_path)
        return audio_path


class FakeWavTranscriber:
    model_size = "small"
    version = "fake-wav-asr-v1"

    def __init__(self):
        self.paths: list[Path] = []

    def transcribe(self, audio_path: Path):
        with wave.open(str(audio_path), "rb") as audio:
            assert audio.getnchannels() == 1
            assert audio.getsampwidth() == 2
            assert audio.getframerate() == 16_000
            assert audio.getnframes() == 1_600
        self.paths.append(audio_path)
        return [TranscriptSegment(0, 0, 100, "Hello from X.")], "en"


@pytest.mark.asyncio
async def test_api_pipeline_returns_timestamped_transcript_and_reuses_result():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    transcript_service = FixedTranscriptService()
    translation_provider = FixedTranslationProvider()
    app = create_app(
        Settings(
            llm_credential_encryption_key=base64.b64encode(b"v" * 32).decode(
                "ascii"
            )
        )
    )

    async def session_dependency() -> AsyncIterator[AsyncSession]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_session] = session_dependency
    app.dependency_overrides[get_transcript_service] = lambda: transcript_service
    app.dependency_overrides[get_video_metadata_service] = (
        lambda: FixedVideoMetadataService()
    )
    app.dependency_overrides[get_job_dispatcher] = lambda: lambda _job_id: None
    app.dependency_overrides[get_quota_limiter] = lambda: PermissiveQuotaLimiter()

    payload = {
        "videoId": "aircAruvnKk",
        "sourceLanguage": "en",
        "targetLanguage": "zh-Hans",
        "title": "But what is a neural network?",
        "llmConfig": {"apiUrl": "https://api.moonshot.cn/v1", "apiKey": "test-key"},
    }
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={
            "Authorization": "Bearer integration-test-installation-token-with-256-bits",
            "X-Veeky-Installation-Id": "11111111-1111-4111-8111-111111111111",
        },
    ) as client:
        registered = await client.post(
            "/v1/installations/register",
            json={
                "installationId": "11111111-1111-4111-8111-111111111111",
                "installationToken": "integration-test-installation-token-with-256-bits",
            },
        )
        assert registered.status_code == 201
        created = await client.post("/v1/analyses", json=payload)
        assert created.status_code == 202
        job_id = created.json()["jobId"]

        pipeline = AnalysisPipeline(
            factory,
            transcript_service,
            translation_provider,
            FixedAnalysisService(),
        )
        await pipeline.run(job_id)

        status = await client.get(f"/v1/analyses/{job_id}")
        result = await client.get(f"/v1/analyses/{job_id}/result")
        cached = await client.post("/v1/analyses", json=payload)

    assert status.json()["status"] == "completed"
    assert result.status_code == 200
    assert result.json()["videoTitle"] == payload["title"]
    assert result.json()["chapters"][0]["start_ms"] == 0
    assert result.json()["transcript"][0] == {
        "id": result.json()["transcript"][0]["id"],
        "startMs": 0,
        "durationMs": 1000,
        "original": "Pixels enter the input layer.",
        "translated": "译文：Pixels enter the input layer.",
    }
    assert cached.status_code == 200
    assert cached.json() == {
        "jobId": job_id,
        "cacheHit": True,
        "status": "completed",
        "contentId": result.json()["contentId"],
        "contentRef": {
            "platform": "youtube",
            "sourceContentId": "aircAruvnKk",
            "mediaIndex": 1,
        },
        "videoId": "aircAruvnKk",
    }
    assert translation_provider.calls == 1
    await engine.dispose()


@pytest.mark.asyncio
async def test_x_api_pipeline_transcribes_a_generated_wav_with_fake_asr(tmp_path):
    media_root = tmp_path / "media"
    media_root.mkdir()
    wav_fixture = tmp_path / "fixture.wav"
    with wave.open(str(wav_fixture), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16_000)
        audio.writeframes(b"\x00\x00" * 1_600)

    database_url = f"sqlite+aiosqlite:///{tmp_path / 'pipeline.sqlite'}"
    engine = create_async_engine(database_url)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    encryption_key = base64.b64encode(b"x" * 32).decode("ascii")
    settings = Settings(
        database_url=database_url,
        media_temp_root=str(media_root),
        max_media_bytes=1024 * 1024,
        max_temp_bytes_per_job=2 * 1024 * 1024,
        llm_credential_encryption_key=encryption_key,
    )
    app = create_app(settings)

    async def session_dependency() -> AsyncIterator[AsyncSession]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_session] = session_dependency
    app.dependency_overrides[get_job_dispatcher] = lambda: lambda _job_id: None
    app.dependency_overrides[get_quota_limiter] = lambda: PermissiveQuotaLimiter()
    transcriber = FakeWavTranscriber()
    translation_provider = FixedTranslationProvider()
    headers = {
        "Authorization": "Bearer integration-test-installation-token-with-256-bits",
        "X-Veeky-Installation-Id": "11111111-1111-4111-8111-111111111111",
    }

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers=headers,
    ) as client:
        registered = await client.post(
            "/v1/installations/register",
            json={
                "installationId": "11111111-1111-4111-8111-111111111111",
                "installationToken": "integration-test-installation-token-with-256-bits",
            },
        )
        assert registered.status_code == 201
        created = await client.post(
            "/v1/analyses",
            json={
                "contentRef": {
                    "platform": "x",
                    "sourceContentId": "2075545587093807111",
                    "mediaIndex": 1,
                },
                "targetLanguage": "zh-Hans",
                "mediaUrl": "https://video.twimg.com/ext_tw_video/fixture.mp4",
                "llmConfig": {
                    "apiUrl": "https://api.moonshot.cn/v1",
                    "apiKey": "test-key",
                },
            },
        )
        assert created.status_code == 202
        job_id = created.json()["jobId"]

        pipeline = AnalysisPipeline(
            factory,
            None,
            translation_provider,
            FixedAnalysisService(),
            credential_cipher=JobCredentialCipher(encryption_key),
            media_downloader=WavFixtureDownloader(wav_fixture),
            audio_extractor=WavFixtureExtractor(),
            transcriber=transcriber,
            settings=settings,
        )
        await pipeline.run(job_id)

        status = await client.get(f"/v1/analyses/{job_id}")
        result = await client.get(f"/v1/analyses/{job_id}/result")

    assert status.json()["status"] == "completed"
    assert result.status_code == 200
    assert result.json()["contentRef"] == {
        "platform": "x",
        "sourceContentId": "2075545587093807111",
        "mediaIndex": 1,
    }
    assert result.json()["transcript"][0]["original"] == "Hello from X."
    assert result.json()["transcript"][0]["translated"] == "译文：Hello from X."
    assert len(transcriber.paths) == 1
    assert not any(media_root.iterdir())
    await engine.dispose()
