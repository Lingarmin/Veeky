# Veeky X Video Subtitle Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add X public-post video ingestion, CPU `faster-whisper small` transcription, Chinese translation, summaries, history reuse, and synchronized Chinese subtitles without regressing YouTube behavior.

**Architecture:** Introduce a platform-neutral `ContentRef` and UUID `content_id`, then route YouTube and X through separate source adapters that produce the same timed transcript format. X acquisition first tries an allowlisted `video.twimg.com` URL; if the server cannot fetch it, an extension offscreen document uploads authenticated browser-fetched media chunks without exposing cookies. The X content script owns player detection and subtitle rendering, while the existing side panel owns inspection, task status, history, and LLM configuration.

**Tech Stack:** Chrome Extension Manifest V3, TypeScript, React, Vitest, Playwright, FastAPI, SQLAlchemy, Alembic, PostgreSQL, Celery, Redis, `ffmpeg`, `faster-whisper`, CTranslate2 CPU `int8`, pytest

---

## Execution rules

- Create `codex/x-video-subtitle-support` from the current committed state before Task 1.
- Follow TDD in every task. Do not combine red and green steps.
- Do not add X Cookie, bearer tokens, media authorization headers, or LLM keys to logs, database JSON, fixtures, commits, or API payloads.
- Run the focused test after each change and the full regression suite in Task 13.
- Reload the unpacked extension after Tasks 9 through 12 because Chrome caches manifest and service worker changes.

## File map

Backend files to create:

- `api/app/sources/base.py`: platform-neutral content and source inspection types
- `api/app/sources/youtube.py`: existing YouTube URL, metadata, and caption behavior
- `api/app/sources/x.py`: X URL parsing and X source inspection
- `api/app/services/media_security.py`: media URL allowlist, redirect, and IP validation
- `api/app/services/media_download.py`: bounded server-side media download
- `api/app/services/media_upload.py`: upload session lifecycle and chunk verification
- `api/app/services/asr.py`: `faster-whisper` adapter and transcript normalization
- `api/alembic/versions/0006_platform_content.py`: compatible content UUID migration
- `api/alembic/versions/0007_media_upload_sessions.py`: upload session schema
- `api/tests/test_sources.py`: platform URL and adapter tests
- `api/tests/test_media_security.py`: SSRF and redirect tests
- `api/tests/test_media_upload.py`: ownership, chunking, retry, and cleanup tests
- `api/tests/test_asr.py`: ASR configuration and timestamp normalization tests
- `api/tests/test_x_pipeline.py`: X worker pipeline tests
- `api/tests/test_platform_content_migration.py`: PostgreSQL migration preservation test

Backend files to modify:

- `api/app/db/models.py`: content identity, upload session, transcript source, job states
- `api/app/api/analyses.py`: platform-neutral inspect/create/history/result contracts
- `api/app/workers/tasks.py`: source routing, media wait/resume, ASR stages, cleanup
- `api/app/core/settings.py`: media and ASR limits
- `api/app/main.py`: upload session router registration if split from analyses
- `api/pyproject.toml`: `faster-whisper` dependency
- `api/Dockerfile`: `ffmpeg` and writable model/temp directories
- `docker-compose.yml`: model and temporary-media volumes

Extension files to create:

- `extension/src/shared/content.ts`: `ContentRef` parsing and stable keys
- `extension/src/content/x-player.ts`: X SPA player selection and player events
- `extension/src/content/subtitle-overlay.ts`: Chinese subtitle overlay and timeline lookup
- `extension/src/content/index.ts`: content script entrypoint and message handling
- `extension/src/offscreen/index.ts`: browser media fetch and resumable upload
- `extension/offscreen.html`: offscreen document entrypoint
- `extension/tests/content.test.ts`: X route, player, and overlay tests
- `extension/tests/offscreen.test.ts`: chunk upload tests

Extension files to modify:

- `extension/manifest.json`: X hosts, `webRequest`, `offscreen`, content script
- `extension/vite.config.ts`: content and offscreen build entries
- `extension/src/shared/types.ts`: platform-neutral context, status, result, and messages
- `extension/src/background.ts`: X enablement, media candidate capture, offscreen orchestration
- `extension/src/sidepanel/browser.ts`: platform-neutral seek and media operations
- `extension/src/sidepanel/api.ts`: new inspect, analysis, and upload contracts
- `extension/src/sidepanel/App.tsx`: X readiness, upload progress, new task phases
- `extension/src/sidepanel/store.ts`: X and ASR error messages
- existing extension tests: preserve YouTube behavior and update shared fixtures

## Phase 1: Platform-neutral foundation

### Task 1: Define platform-neutral source types and URL parsing

**Files:**

- Create: `api/app/sources/__init__.py`
- Create: `api/app/sources/base.py`
- Create: `api/app/sources/youtube.py`
- Create: `api/app/sources/x.py`
- Create: `api/tests/test_sources.py`

- [ ] **Step 1: Write failing URL and stable-key tests**

```python
from app.sources.base import ContentRef
from app.sources.youtube import parse_youtube_url
from app.sources.x import parse_x_url


def test_parses_youtube_content_ref():
    assert parse_youtube_url("https://www.youtube.com/watch?v=aircAruvnKk") == ContentRef(
        platform="youtube", source_content_id="aircAruvnKk", media_index=1
    )


def test_parses_x_video_route():
    assert parse_x_url(
        "https://x.com/viktoroddy/status/2075545587093807111/video/1"
    ) == ContentRef(
        platform="x", source_content_id="2075545587093807111", media_index=1
    )


def test_bare_x_status_requires_active_media_index():
    assert parse_x_url(
        "https://x.com/viktoroddy/status/2075545587093807111",
        active_media_index=2,
    ).media_index == 2


def test_rejects_twitter_dot_com():
    assert parse_x_url("https://twitter.com/user/status/2075545587093807111") is None


def test_content_ref_has_unambiguous_key():
    ref = ContentRef(platform="x", source_content_id="2075545587093807111", media_index=1)
    assert ref.stable_key == "x:2075545587093807111:1"
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd api && pytest tests/test_sources.py -q`

Expected: collection fails because `app.sources` does not exist.

- [ ] **Step 3: Add source types and strict parsers**

```python
# api/app/sources/base.py
from dataclasses import dataclass
from typing import Literal

Platform = Literal["youtube", "x"]


@dataclass(frozen=True, slots=True)
class ContentRef:
    platform: Platform
    source_content_id: str
    media_index: int = 1

    @property
    def stable_key(self) -> str:
        return f"{self.platform}:{self.source_content_id}:{self.media_index}"
```

Implement `parse_youtube_url()` by moving the validated YouTube parsing logic from `analyses.py`. Implement `parse_x_url()` with `urlparse`, an exact `x.com` or `www.x.com` host check, decimal status IDs, and positive media indexes. A bare status URL returns `None` unless `active_media_index` is supplied.

- [ ] **Step 4: Run source tests**

Run: `cd api && pytest tests/test_sources.py -q`

Expected: `5 passed`.

- [ ] **Step 5: Commit**

```bash
git add api/app/sources api/tests/test_sources.py
git commit -m "feat(api): add platform content references"
```

### Task 2: Add compatible content UUID migration

**Files:**

- Create: `api/alembic/versions/0006_platform_content.py`
- Create: `api/tests/test_platform_content_migration.py`
- Modify: `api/app/db/models.py`
- Modify: `api/tests/test_models.py`

- [ ] **Step 1: Write failing model and PostgreSQL migration tests**

Add a model test that creates both sources and verifies uniqueness:

```python
youtube = Video(
    video_id="aircAruvnKk",
    platform="youtube",
    source_content_id="aircAruvnKk",
    media_index=1,
    title="YouTube",
    duration_ms=1000,
    source_url="https://www.youtube.com/watch?v=aircAruvnKk",
)
x_video = Video(
    video_id="x:2075545587093807111:1",
    platform="x",
    source_content_id="2075545587093807111",
    media_index=1,
    title="X video",
    duration_ms=1000,
    source_url="https://x.com/viktoroddy/status/2075545587093807111/video/1",
)
session.add_all([youtube, x_video])
await session.commit()
assert youtube.content_id != x_video.content_id
```

Create a migration test following `test_installation_migration.py`: upgrade to `0005_one_active_job`, insert a YouTube video, transcript, and completed job, upgrade to `head`, then assert `platform='youtube'`, `source_content_id=video_id`, `media_index=1`, non-null UUIDs on the video, track, and job, and unchanged history text.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `cd api && pytest tests/test_models.py tests/test_platform_content_migration.py -q`

Expected: model keyword and migration revision failures.

- [ ] **Step 3: Add columns, backfill, and dual-key relationships**

Migration `upgrade()` must keep the legacy primary key while adding the new logical key:

```python
import uuid

connection = op.get_bind()
op.alter_column("videos", "video_id", type_=sa.String(100), existing_type=sa.String(11))
op.add_column("videos", sa.Column("content_id", sa.String(36), nullable=True))
op.add_column("videos", sa.Column("platform", sa.String(20), nullable=True))
op.add_column("videos", sa.Column("source_content_id", sa.String(100), nullable=True))
op.add_column("videos", sa.Column("media_index", sa.Integer(), nullable=True))
for row in connection.execute(sa.text("SELECT video_id FROM videos")).mappings():
    connection.execute(
        sa.text("""
            UPDATE videos
            SET content_id=:content_id, platform='youtube',
                source_content_id=video_id, media_index=1
            WHERE video_id=:video_id
        """),
        {"content_id": str(uuid.uuid4()), "video_id": row["video_id"]},
    )
op.alter_column("videos", "content_id", nullable=False)
op.alter_column("videos", "platform", nullable=False)
op.alter_column("videos", "source_content_id", nullable=False)
op.alter_column("videos", "media_index", nullable=False)
op.create_unique_constraint(
    "uq_videos_platform_source_media",
    "videos",
    ["platform", "source_content_id", "media_index"],
)
```

Create a unique constraint on `videos.content_id`. Add `content_id` to `transcript_tracks` and `analysis_jobs`, backfill through `videos.video_id`, then add foreign keys and non-null constraints. Keep all legacy `video_id` columns and foreign keys. X rows store the internal compatibility key `x:{status_id}:{media_index}` in those legacy columns, while public contracts return `videoId=null` for X. SQLAlchemy relationships must set `foreign_keys` explicitly because both legacy and new foreign keys point to `videos`.

The same migration expands `analysis_jobs.cache_key` to 500 characters. Do not make `source_language`, `transcript_version`, or `cache_key` nullable. A new X job starts with `source_language='auto'`, `transcript_version='pending:{job_id}'`, and `cache_key='pending:{installation_id}:{job_id}'`; Task 8 replaces them after ASR.

Update SQLAlchemy models so new code can relate `Video`, `TranscriptTrack`, and `AnalysisJob` through `content_id`. Keep legacy relationships readable during this release.

`downgrade()` must first delete X jobs, tracks, and videos, then drop the new child foreign keys and columns, drop the new video constraints and columns, and narrow `video_id` back to 11 characters. Add a downgrade assertion to the PostgreSQL migration test proving the original YouTube history remains intact.

- [ ] **Step 4: Run model and migration tests**

Run: `cd api && pytest tests/test_models.py tests/test_platform_content_migration.py -q`

Expected: all model tests pass; the migration test passes when Docker is available and skips otherwise.

- [ ] **Step 5: Commit**

```bash
git add api/app/db/models.py api/alembic/versions/0006_platform_content.py api/tests/test_models.py api/tests/test_platform_content_migration.py
git commit -m "feat(db): add platform-neutral content identity"
```

### Task 3: Route YouTube through a source adapter without behavior changes

**Files:**

- Modify: `api/app/sources/base.py`
- Modify: `api/app/sources/youtube.py`
- Modify: `api/app/api/analyses.py`
- Modify: `api/app/workers/tasks.py`
- Modify: `api/tests/test_sources.py`
- Modify: `api/tests/test_analyses_api.py`
- Modify: `api/tests/test_tasks.py`

- [ ] **Step 1: Write failing adapter routing tests**

```python
class FakeYouTubeAdapter:
    platform = "youtube"

    async def inspect(self, ref, preferred_languages):
        assert ref.source_content_id == "aircAruvnKk"
        return SourceInspection(
            ref=ref,
            duration_ms=1500,
            source_status="ready",
            transcript_source="youtube_caption",
            tracks=[TranscriptTrackInfo("en", "English", False, True)],
            selected_language="en",
        )


@pytest.mark.asyncio
async def test_inspect_routes_youtube_to_adapter(api_context):
    client, app, _, _ = api_context
    app.dependency_overrides[get_source_registry] = lambda: SourceRegistry([FakeYouTubeAdapter()])
    response = await client.post(
        "/v1/videos/inspect",
        json={"url": "https://www.youtube.com/watch?v=aircAruvnKk"},
    )
    assert response.status_code == 200
    assert response.json()["contentRef"] == {
        "platform": "youtube",
        "sourceContentId": "aircAruvnKk",
        "mediaIndex": 1,
    }
```

- [ ] **Step 2: Run focused API and worker tests**

Run: `cd api && pytest tests/test_sources.py tests/test_analyses_api.py tests/test_tasks.py -q`

Expected: new registry tests fail while existing YouTube tests remain green.

- [ ] **Step 3: Add `SourceInspection`, `SourceAdapter`, and registry**

```python
@dataclass(slots=True)
class SourceInspection:
    ref: ContentRef
    duration_ms: int
    source_status: Literal["ready", "play_required", "media_required", "unavailable"]
    transcript_source: Literal["youtube_caption", "faster_whisper"]
    tracks: list[TranscriptTrackInfo]
    selected_language: str | None


class SourceRegistry:
    def __init__(self, adapters: list[SourceAdapter]):
        self._adapters = {adapter.platform: adapter for adapter in adapters}

    def parse(self, url: str, active_media_index: int | None = None) -> ContentRef:
        for adapter in self._adapters.values():
            ref = adapter.parse_url(url, active_media_index=active_media_index)
            if ref is not None:
                return ref
        raise UnsupportedSourceUrl("仅支持 YouTube 和 x.com 视频链接")
```

Move YouTube metadata and transcript inspection behind `YouTubeAdapter`. Make API dependencies return a registry. Update the worker to resolve a source adapter before transcript acquisition. Keep old `videoId` response fields for YouTube clients.

- [ ] **Step 4: Run YouTube regression tests**

Run: `cd api && pytest tests/test_sources.py tests/test_analyses_api.py tests/test_tasks.py tests/test_transcripts.py tests/test_video_metadata.py -q`

Expected: all pass with unchanged YouTube error codes and 4-hour behavior.

- [ ] **Step 5: Commit**

```bash
git add api/app/sources api/app/api/analyses.py api/app/workers/tasks.py api/tests
git commit -m "refactor(api): route YouTube through source adapters"
```

### Task 4: Migrate API contracts and history lookup to `ContentRef`

**Files:**

- Modify: `api/app/api/analyses.py`
- Modify: `api/tests/test_analyses_api.py`
- Modify: `extension/src/shared/types.ts`
- Modify: `extension/src/sidepanel/api.ts`
- Modify: `extension/tests/App.test.tsx`

- [ ] **Step 1: Write failing API compatibility and ownership tests**

Add tests that create an X inspection response, create an analysis by `contentRef`, query history by `contentId`, and verify a different installation receives 404 for the result. Keep a YouTube test that sends legacy `videoId` and receives both `videoId` and `contentRef`.

```python
assert response.json()["contentRef"] == {
    "platform": "x",
    "sourceContentId": "2075545587093807111",
    "mediaIndex": 1,
}
assert response.json()["transcriptSource"] == "faster_whisper"
```

- [ ] **Step 2: Run API tests and confirm failure**

Run: `cd api && pytest tests/test_analyses_api.py -q`

Expected: X contract tests fail because request and response models only expose `videoId`.

- [ ] **Step 3: Add camel-case request and response models**

```python
class ContentRefRequest(ApiModel):
    platform: Literal["youtube", "x"]
    source_content_id: str
    media_index: int = Field(default=1, ge=1)


class AnalysisCreateRequest(ApiModel):
    content_id: str | None = None
    content_ref: ContentRefRequest | None = None
    video_id: str | None = None
    source_language: str | None = None
    target_language: str = "zh-Hans"
    title: str | None = None
    llm_config: LlmConfigRequest | None = None
    media_url: str | None = None
    media_session_id: str | None = None
    force: bool = False
```

Require exactly one of `content_id`, `content_ref`, or legacy `video_id`. Resolve it to a `Video` owned-independent content row, while every job/result query remains installation-owned. Add matching TypeScript `ContentRef`, `ContentContext`, `AnalysisResult`, and API input types.

Extend `InspectRequest` with `active_media_index`, `client_duration_ms`, and a bounded list of at most 50 `media_candidates`. For X, return `selectedLanguage='auto'`, `availableLanguages=[]`, and treat browser duration as provisional until `ffprobe` validates it in the worker.

- [ ] **Step 4: Run backend and extension contract tests**

Run: `cd api && pytest tests/test_analyses_api.py -q`

Run: `cd extension && pnpm test -- --run tests/App.test.tsx && pnpm typecheck`

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add api/app/api/analyses.py api/tests/test_analyses_api.py extension/src/shared/types.ts extension/src/sidepanel/api.ts extension/tests/App.test.tsx
git commit -m "feat: use content references in analysis contracts"
```

## Phase 2: X media acquisition and CPU ASR

### Task 5: Validate X media URLs and perform bounded downloads

**Files:**

- Create: `api/app/services/media_security.py`
- Create: `api/app/services/media_download.py`
- Create: `api/tests/test_media_security.py`
- Modify: `api/app/core/settings.py`
- Modify: `api/tests/test_settings.py`

- [ ] **Step 1: Write failing allowlist, redirect, size, and timeout tests**

```python
@pytest.mark.parametrize("url", [
    "http://video.twimg.com/file.mp4",
    "https://video.twimg.com:444/file.mp4",
    "https://user@video.twimg.com/file.mp4",
    "https://example.com/file.mp4",
])
def test_rejects_unsafe_media_url(url):
    with pytest.raises(UnsafeMediaUrl):
        validate_x_media_url(url)


def test_accepts_exact_x_cdn_host():
    assert validate_x_media_url("https://video.twimg.com/amplify_video/file.mp4")


@pytest.mark.asyncio
async def test_download_stops_above_limit(tmp_path):
    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, content=b"x" * 17, request=request)
    )
    async with httpx.AsyncClient(transport=transport) as client:
        downloader = MediaDownloader(client=client, max_bytes=16, timeout_seconds=30)
        with pytest.raises(MediaTooLarge):
            await downloader.download(
                "https://video.twimg.com/file.mp4", tmp_path / "source.mp4"
            )
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `cd api && pytest tests/test_media_security.py tests/test_settings.py -q`

Expected: import failures for the new media modules and missing settings.

- [ ] **Step 3: Implement strict validation and streaming download**

`validate_x_media_url()` must require HTTPS, exact `video.twimg.com`, port 443 or absent, no username/password, and no fragment. Resolve DNS and reject loopback, private, link-local, multicast, reserved, and unspecified IPs. Validate every redirect before following it. Stream to a newly created job directory and stop once `max_media_bytes` is exceeded.

Add settings with concrete defaults:

```python
max_media_bytes: PositiveInt = 4 * 1024 * 1024 * 1024
max_temp_bytes_per_job: PositiveInt = 6 * 1024 * 1024 * 1024
media_download_timeout_seconds: PositiveInt = 1800
media_upload_session_ttl_seconds: PositiveInt = 7200
media_chunk_bytes: PositiveInt = 8 * 1024 * 1024
asr_job_timeout_seconds: PositiveInt = 21600
media_temp_root: str = "/var/lib/veeky/media"
```

- [ ] **Step 4: Run media security tests**

Run: `cd api && pytest tests/test_media_security.py tests/test_settings.py -q`

Expected: all pass without making public network requests.

- [ ] **Step 5: Commit**

```bash
git add api/app/services/media_security.py api/app/services/media_download.py api/app/core/settings.py api/tests/test_media_security.py api/tests/test_settings.py
git commit -m "feat(api): add bounded X media download"
```

### Task 6: Add installation-owned resumable media uploads

**Files:**

- Create: `api/alembic/versions/0007_media_upload_sessions.py`
- Create: `api/app/services/media_upload.py`
- Create: `api/app/api/media.py`
- Create: `api/tests/test_media_upload.py`
- Modify: `api/app/db/models.py`
- Modify: `api/app/main.py`

- [ ] **Step 1: Write failing lifecycle and isolation tests**

Test create, upload, duplicate retry, checksum mismatch, status, complete, delete, expiration, size cap, and cross-installation 404. Use a 16-byte test chunk size and temporary directory.

```python
part = b"0123456789abcdef"
checksum = hashlib.sha256(part).hexdigest()
response = await client.put(
    f"/v1/media-sessions/{session_id}/parts/0",
    content=part,
    headers={"X-Content-SHA256": checksum, "Content-Type": "application/octet-stream"},
)
assert response.status_code == 204
```

- [ ] **Step 2: Run upload tests and confirm failure**

Run: `cd api && pytest tests/test_media_upload.py -q`

Expected: 404 or import failure because upload routes do not exist.

- [ ] **Step 3: Implement upload session model, service, and routes**

Use this state model:

```python
MEDIA_SESSION_STATES = {"created", "uploading", "complete", "consumed", "expired", "failed"}
```

Each session stores UUID, installation ID, content ID, status, expected bytes, received bytes, media kind (`mp4` or `hls`), created/updated/expiry timestamps, and a server-generated directory key. The path is derived from the server UUID, never from user input. `PUT` writes to a temporary filename, verifies SHA-256 and exact part size, then atomically renames it. A duplicate matching part returns 204 without incrementing bytes.

`complete` verifies all declared parts and returns a media artifact descriptor. HLS completion also validates a JSON manifest whose entries reference only uploaded numeric part IDs.

- [ ] **Step 4: Run upload and ownership tests**

Run: `cd api && pytest tests/test_media_upload.py tests/test_installations.py -q`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add api/alembic/versions/0007_media_upload_sessions.py api/app/db/models.py api/app/services/media_upload.py api/app/api/media.py api/app/main.py api/tests/test_media_upload.py
git commit -m "feat(api): add resumable media upload sessions"
```

### Task 7: Add CPU `faster-whisper small` transcription

**Files:**

- Create: `api/app/services/asr.py`
- Create: `api/tests/test_asr.py`
- Modify: `api/app/core/settings.py`
- Modify: `api/pyproject.toml`
- Modify: `api/Dockerfile`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Write failing ASR adapter tests with an injected fake model**

```python
def test_transcriber_uses_cpu_small_int8(tmp_path):
    factory = FakeWhisperFactory()
    transcriber = FasterWhisperTranscriber(factory=factory)
    segments, language = transcriber.transcribe(tmp_path / "audio.wav")
    assert factory.calls == [{
        "model_size_or_path": "small",
        "device": "cpu",
        "compute_type": "int8",
        "download_root": "/models/whisper",
    }]
    assert language == "en"
    assert segments[0].start_ms == 1250
    assert segments[0].duration_ms == 1750


def test_asr_version_contains_runtime_and_parameters():
    assert "small" in asr_version("small", "cpu", "int8", True)
```

- [ ] **Step 2: Run ASR tests and confirm failure**

Run: `cd api && pytest tests/test_asr.py -q`

Expected: import failure for `app.services.asr`.

- [ ] **Step 3: Implement injected model loading and segment normalization**

```python
class FasterWhisperTranscriber:
    def __init__(self, model_path="small", model_dir="/models/whisper", factory=WhisperModel):
        self.model_path = model_path
        self.model_dir = model_dir
        self.factory = factory

    def transcribe(self, audio_path: Path) -> tuple[list[TranscriptSegment], str]:
        model = self.factory(
            self.model_path,
            device="cpu",
            compute_type="int8",
            download_root=self.model_dir,
        )
        raw_segments, info = model.transcribe(str(audio_path), vad_filter=True)
        segments = normalize_whisper_segments(raw_segments)
        if not segments:
            raise AsrError("empty_transcript", "未识别到可用语音")
        return segments, info.language
```

Add `faster-whisper` to `pyproject.toml`. Install `ffmpeg` in the image as root before switching back to the LibreTranslate user. Mount `whisper_models:/models/whisper` and `media_temp:/var/lib/veeky/media` into the API and worker, with the worker owning writes.

- [ ] **Step 4: Run ASR tests and build the image**

Run: `cd api && pytest tests/test_asr.py -q`

Run: `docker compose build api worker`

Expected: unit tests pass and both images build with `ffmpeg -version` available.

- [ ] **Step 5: Commit**

```bash
git add api/app/services/asr.py api/tests/test_asr.py api/app/core/settings.py api/pyproject.toml api/Dockerfile docker-compose.yml
git commit -m "feat(worker): add CPU faster-whisper transcription"
```

### Task 8: Run the X analysis pipeline and resume after upload

**Files:**

- Create: `api/tests/test_x_pipeline.py`
- Modify: `api/app/sources/x.py`
- Modify: `api/app/workers/tasks.py`
- Modify: `api/app/api/analyses.py`
- Modify: `api/app/db/models.py`
- Modify: `api/tests/test_tasks.py`

- [ ] **Step 1: Write failing X pipeline state tests**

Cover these paths with fake downloader, fake ffmpeg runner, fake ASR, existing fake analysis, and fake translation:

```text
media URL download -> extracting_audio -> transcribing -> analyzing -> translating -> completed
403 download -> waiting_for_media
completed upload -> resumed task -> completed
missing audio -> failed/audio_track_missing
ASR error -> failed/asr_failed
translation error -> failed/translation_failed with original transcript retained
all terminal states -> encrypted LLM credential cleared and temp directory removed
```

Assert the persisted track has `transcript_source='faster_whisper'`, `asr_model='small'`, detected source language, normalized segments, and an audio fingerprint in the transcript version.

- [ ] **Step 2: Run X worker tests and confirm failure**

Run: `cd api && pytest tests/test_x_pipeline.py tests/test_tasks.py -q`

Expected: X jobs fail because the worker only calls YouTube transcript inspection.

- [ ] **Step 3: Implement staged acquisition and cleanup**

Refactor `AnalysisPipeline.run()` into focused private methods:

```python
async def _acquire_transcript(self, job: AnalysisJob) -> AcquiredTranscript:
    if job.video.platform == "youtube":
        return await self._acquire_youtube_transcript(job)
    return await self._acquire_x_transcript(job)


async def _acquire_x_transcript(self, job: AnalysisJob) -> AcquiredTranscript:
    artifact = await self.media_acquirer.acquire(job)
    await self._set_status(job.id, "extracting_audio")
    audio_path = await self.ffmpeg.extract_audio(artifact.path)
    await self._set_status(job.id, "transcribing")
    segments, language = await run_in_threadpool(self.transcriber.transcribe, audio_path)
    return AcquiredTranscript(
        language_code=language,
        language_name=language,
        is_generated=True,
        transcript_source="faster_whisper",
        asr_model="small",
        segments=segments,
        version=transcript_version_with_audio(segments, artifact.sha256, self.transcriber.version),
    )
```

When anonymous download needs browser media, set `waiting_for_media`, keep the encrypted LLM credential until its existing TTL, and return without marking the job failed. `POST /media-sessions/{id}/complete` attaches the artifact to the owned job and redispatches with `resume=True`. Use `finally` to delete job media and audio files for every terminal path.

Create X jobs with `source_language='auto'`, `transcript_version=f'pending:{job_id}'`, and `cache_key=f'pending:{installation_id}:{job_id}'`. After ASR, calculate the final transcript version and cache key. If a matching completed job already exists and `force` is false, reuse its result for the current job without rerunning LLM calls; if `force` is true, append `:run:{job_id}`. Persist the detected language before analysis and translation.

Expand active-status constraints and API status enums to include `waiting_for_media`, `downloading_media`, `extracting_audio`, and `transcribing`.

- [ ] **Step 4: Run pipeline and API tests**

Run: `cd api && pytest tests/test_x_pipeline.py tests/test_tasks.py tests/test_analyses_api.py tests/test_models.py -q`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add api/app/sources/x.py api/app/workers/tasks.py api/app/api/analyses.py api/app/db/models.py api/tests/test_x_pipeline.py api/tests/test_tasks.py
git commit -m "feat(worker): analyze X video media with ASR"
```

## Phase 3: Extension capture, upload, and subtitles

### Task 9: Add extension `ContentRef` parsing and X enablement

**Files:**

- Create: `extension/src/shared/content.ts`
- Create: `extension/tests/content.test.ts`
- Modify: `extension/src/shared/types.ts`
- Modify: `extension/src/background.ts`
- Modify: `extension/tests/background.test.ts`
- Modify: `extension/manifest.json`
- Modify: `extension/vite.config.ts`

- [ ] **Step 1: Write failing parsing and panel-enablement tests**

```typescript
expect(parseContentRef("https://x.com/viktoroddy/status/2075545587093807111/video/1")).toEqual({
  platform: "x",
  sourceContentId: "2075545587093807111",
  mediaIndex: 1,
});
expect(parseContentRef("https://twitter.com/u/status/2075545587093807111")).toBeNull();
expect(parseContentRef("https://x.com/u/status/2075545587093807111")).toBeNull();
```

Update background tests so X video routes enable and open the side panel, while non-video X pages remain disabled.

- [ ] **Step 2: Run extension tests and confirm failure**

Run: `cd extension && pnpm test -- --run tests/content.test.ts tests/background.test.ts`

Expected: parser module missing and X panel tests fail.

- [ ] **Step 3: Implement shared parser and manifest entries**

```typescript
export interface ContentRef {
  platform: "youtube" | "x";
  sourceContentId: string;
  mediaIndex: number;
}

export function contentKey(ref: ContentRef): string {
  return `${ref.platform}:${ref.sourceContentId}:${ref.mediaIndex}`;
}
```

`parseContentRef()` accepts existing YouTube links and X routes with an explicit `/video/{positive integer}`. A bare X status becomes usable only after the content script reports an active media index. Replace `parseVideoId()` use in the background with `parseContentRef()` while retaining a small compatibility export for existing tests during the task.

Add manifest permissions and build entries:

```json
"permissions": ["sidePanel", "storage", "tabs", "scripting", "webRequest", "offscreen"],
"host_permissions": ["https://x.com/*", "https://video.twimg.com/*"],
"content_scripts": [{
  "matches": ["https://x.com/*"],
  "js": ["content.js"],
  "run_at": "document_idle"
}]
```

- [ ] **Step 4: Run tests, typecheck, and build**

Run: `cd extension && pnpm test -- --run tests/content.test.ts tests/background.test.ts && pnpm typecheck && pnpm build`

Expected: all pass and `dist/content.js`, `dist/background.js`, and the updated manifest exist.

- [ ] **Step 5: Commit**

```bash
git add extension/manifest.json extension/vite.config.ts extension/src/shared extension/src/background.ts extension/tests/content.test.ts extension/tests/background.test.ts
git commit -m "feat(extension): recognize X video routes"
```

### Task 10: Detect the active X player and capture media candidates

**Files:**

- Create: `extension/src/content/x-player.ts`
- Create: `extension/src/content/index.ts`
- Modify: `extension/src/background.ts`
- Modify: `extension/src/shared/types.ts`
- Modify: `extension/tests/content.test.ts`
- Modify: `extension/tests/background.test.ts`

- [ ] **Step 1: Write failing SPA, player, and candidate tests**

Create jsdom fixtures with a main post video, a reply video, and route `/video/1`. Test that only the playing main video is selected, route changes clear the previous selection, and DOM replacement rebinds the player.

Background tests must simulate:

```typescript
chrome.webRequest.onBeforeRequest.emit({
  tabId: 7,
  url: "https://video.twimg.com/amplify_video/123/vid/avc1/file.mp4",
  type: "media",
  timeStamp: Date.now(),
});
```

Assert candidates are stored only while an active capture window exists and expire after 10 minutes.

- [ ] **Step 2: Run focused extension tests and confirm failure**

Run: `cd extension && pnpm test -- --run tests/content.test.ts tests/background.test.ts`

Expected: missing player entrypoint and capture messages.

- [ ] **Step 3: Implement player events and bounded candidate storage**

Use messages with exact payloads:

```typescript
type XPlayerMessage =
  | { type: "X_PLAYER_ACTIVE"; contentRef: ContentRef; durationMs: number }
  | { type: "X_PLAYER_INACTIVE"; contentRef: ContentRef }
  | { type: "GET_MEDIA_CANDIDATES"; tabId: number; contentRef: ContentRef };

interface MediaCandidate {
  url: string;
  kind: "mp4" | "hls" | "segment";
  capturedAt: number;
}
```

The content script uses a `MutationObserver`, `popstate`, and a wrapped history notification to rescan. On `play`, it finds the closest article or video modal that belongs to the current status, derives the media index, and notifies the background. The background opens a 15-second capture window and records only HTTPS `video.twimg.com` requests for that tab. Deduplicate URLs and cap storage at 50 candidates per content key.

- [ ] **Step 4: Run tests and build**

Run: `cd extension && pnpm test -- --run tests/content.test.ts tests/background.test.ts && pnpm typecheck && pnpm build`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add extension/src/content extension/src/background.ts extension/src/shared/types.ts extension/tests/content.test.ts extension/tests/background.test.ts
git commit -m "feat(extension): capture active X video media"
```

### Task 11: Upload browser-fetched media through an offscreen document

**Files:**

- Create: `extension/offscreen.html`
- Create: `extension/src/offscreen/index.ts`
- Create: `extension/tests/offscreen.test.ts`
- Modify: `extension/vite.config.ts`
- Modify: `extension/src/background.ts`
- Modify: `extension/src/shared/types.ts`
- Modify: `extension/src/sidepanel/api.ts`
- Modify: `extension/tests/background.test.ts`

- [ ] **Step 1: Write failing resumable upload tests**

Inject fake `fetch` and API clients. Test an 18 MiB MP4 becomes three ordered parts at the configured 8 MiB size, retries query server state before resending, SHA-256 is attached, and no Cookie or Authorization value from X is added to API metadata.

```typescript
expect(api.uploadPart.mock.calls.map((call) => call[1])).toEqual([0, 1, 2]);
expect(api.completeMediaSession).toHaveBeenCalledWith(sessionId, {
  kind: "mp4",
  partCount: 3,
  totalBytes: 18 * 1024 * 1024,
});
```

- [ ] **Step 2: Run offscreen tests and confirm failure**

Run: `cd extension && pnpm test -- --run tests/offscreen.test.ts tests/background.test.ts`

Expected: missing offscreen module and orchestration messages.

- [ ] **Step 3: Implement offscreen lifecycle and chunk upload**

Add messages:

```typescript
type MediaUploadMessage =
  | { type: "START_MEDIA_UPLOAD"; jobId: string; contentRef: ContentRef; candidate: MediaCandidate }
  | { type: "MEDIA_UPLOAD_PROGRESS"; jobId: string; uploadedBytes: number; totalBytes: number | null }
  | { type: "MEDIA_UPLOAD_COMPLETE"; jobId: string; mediaSessionId: string }
  | { type: "MEDIA_UPLOAD_FAILED"; jobId: string; code: string };
```

The background creates one offscreen document with reason `BLOBS` and justification “Fetch and upload the X video selected by the user for transcription”. The offscreen module fetches the chosen `video.twimg.com` URL with browser credentials, streams MP4 bytes into 8 MiB parts, hashes each part with `crypto.subtle.digest`, and uses the authenticated Veeky API client for upload.

For HLS, parse only HTTPS playlists whose referenced URLs resolve to `video.twimg.com`; upload the selected highest-bandwidth variant at or below 1080p, its init segment, and ordered media segments. Send relative order metadata, never X request headers.

- [ ] **Step 4: Run tests, typecheck, and build**

Run: `cd extension && pnpm test -- --run tests/offscreen.test.ts tests/background.test.ts && pnpm typecheck && pnpm build`

Expected: tests pass and `dist/offscreen.html` references a built offscreen script.

- [ ] **Step 5: Commit**

```bash
git add extension/offscreen.html extension/src/offscreen extension/src/background.ts extension/src/shared/types.ts extension/src/sidepanel/api.ts extension/vite.config.ts extension/tests/offscreen.test.ts extension/tests/background.test.ts
git commit -m "feat(extension): upload X media without sharing cookies"
```

### Task 12: Add X side-panel flow and synchronized Chinese overlay

**Files:**

- Create: `extension/src/content/subtitle-overlay.ts`
- Modify: `extension/src/content/index.ts`
- Modify: `extension/src/sidepanel/App.tsx`
- Modify: `extension/src/sidepanel/browser.ts`
- Modify: `extension/src/sidepanel/store.ts`
- Modify: `extension/src/shared/types.ts`
- Modify: `extension/tests/content.test.ts`
- Modify: `extension/tests/App.test.tsx`

- [ ] **Step 1: Write failing readiness, progress, seek, and overlay tests**

Add App tests for `play_required`, ready X inspection, `waiting_for_media`, upload progress, `transcribing`, completed history reuse, and reanalysis. Add overlay unit tests:

```typescript
expect(findActiveSubtitle(1500, [
  { startMs: 0, durationMs: 1000, translated: "第一句" },
  { startMs: 1000, durationMs: 1000, translated: "第二句" },
])).toBe("第二句");

video.currentTime = 1.5;
video.dispatchEvent(new Event("timeupdate"));
expect(overlay).toHaveTextContent("第二句");
```

Test that a route change removes the overlay and that `SEEK_CONTENT` sets the selected X video's `currentTime` without calling `tabs.update()`.

- [ ] **Step 2: Run focused UI tests and confirm failure**

Run: `cd extension && pnpm test -- --run tests/content.test.ts tests/App.test.tsx tests/background.test.ts`

Expected: missing X phases, overlay helpers, and platform-neutral seek.

- [ ] **Step 3: Implement X phases and subtitle delivery**

Extend `JobStatus` with:

```typescript
type JobStatus =
  | "queued"
  | "fetching_transcript"
  | "waiting_for_media"
  | "downloading_media"
  | "extracting_audio"
  | "transcribing"
  | "analyzing"
  | "translating"
  | "completed"
  | "failed";
```

When polling sees `waiting_for_media`, request the best candidate from the background and send `START_MEDIA_UPLOAD`. Render exact progress labels: “正在获取 X 视频”, “正在上传视频 42%”, “正在提取音频”, and “正在识别语音”. On completion, send translated segments and `ContentRef` to the content script.

`SubtitleOverlay` mounts one `.veeky-subtitle-overlay` per active video container, uses binary search by `startMs`, displays only `translated`, limits visual text to two lines, and reattaches after X replaces the video element. `browser.seek()` sends `SEEK_CONTENT`; the content script validates the current `ContentRef`, sets `video.currentTime`, and calls `video.play()` without navigation.

Add the approved user messages to `store.ts`, including `x_video_play_required`, `x_media_not_detected`, `x_media_url_expired`, `media_too_large`, `media_upload_interrupted`, `audio_track_missing`, `asr_resource_exhausted`, and `asr_failed`.

- [ ] **Step 4: Run all extension checks**

Run: `cd extension && pnpm test && pnpm typecheck && pnpm build`

Expected: all unit tests pass, typecheck exits 0, and build completes.

- [ ] **Step 5: Commit**

```bash
git add extension/src/content extension/src/sidepanel extension/src/shared/types.ts extension/tests
git commit -m "feat(extension): show synchronized Chinese subtitles on X"
```

## Phase 4: End-to-end validation and release documentation

### Task 13: Add cleanup scheduling, end-to-end coverage, and operator docs

**Files:**

- Modify: `api/app/workers/tasks.py`
- Modify: `api/tests/e2e/test_pipeline.py`
- Modify: `api/tests/test_media_upload.py`
- Modify: `extension/tests-e2e/sidepanel.spec.ts`
- Modify: `docs/internal-test-cases.md`
- Modify: `README.md`

- [ ] **Step 1: Write failing cleanup and end-to-end tests**

Add a Celery beat cleanup test that expires abandoned media sessions, deletes their directories, and leaves completed transcript/result rows intact. Add an API pipeline test using a small generated WAV fixture and a fake ASR model. Extend Playwright fixtures so an X page mock exposes a video, receives translated segments, advances `currentTime`, and renders the expected Chinese subtitle.

- [ ] **Step 2: Run the new tests and confirm failure**

Run: `cd api && pytest tests/test_media_upload.py tests/e2e/test_pipeline.py -q`

Run: `cd extension && pnpm test:e2e`

Expected: cleanup scheduling and X browser scenario fail before implementation.

- [ ] **Step 3: Add periodic cleanup and documentation**

Register a beat task every 15 minutes that selects expired non-consumed media sessions in batches of 100, marks them expired, and removes their server-generated directories. Document:

```text
ASR_MODEL_SIZE=small
ASR_DEVICE=cpu
ASR_COMPUTE_TYPE=int8
ASR_MODEL_DIR=/models/whisper
MEDIA_TEMP_ROOT=/var/lib/veeky/media
MAX_MEDIA_BYTES=4294967296
MAX_TEMP_BYTES_PER_JOB=6442450944
MEDIA_CHUNK_BYTES=8388608
```

Update extension installation steps to mention the new X and media permissions, playing the video for 1 to 2 seconds, first-run model download, CPU processing time, temporary-media deletion, and no Cookie upload.

- [ ] **Step 4: Run the complete regression suite**

Run: `cd api && pytest -q`

Expected: all API tests pass; Docker-only migration tests may skip only when Docker is unavailable.

Run: `cd extension && pnpm test && pnpm typecheck && pnpm build && pnpm test:e2e`

Expected: all extension commands pass.

Run: `docker compose config && docker compose build api worker && docker compose up -d && curl --fail http://127.0.0.1:8000/health`

Expected: configuration is valid, images build, services become healthy, and health returns HTTP 200.

- [ ] **Step 5: Perform the manual acceptance test**

Reload the unpacked extension, then use:

`https://x.com/viktoroddy/status/2075545587093807111/video/1`

Verify the twelve manual cases in the design document, including play-required guidance, server download, forced 403 browser upload fallback, stage labels, Chinese-only overlay, pause/seek/rate synchronization, history reuse, forced reanalysis, and complete YouTube regression. Record observed durations and any failed step in `docs/internal-test-cases.md`.

- [ ] **Step 6: Commit final validation artifacts**

```bash
git add api/app/workers/tasks.py api/tests extension/tests-e2e docs/internal-test-cases.md README.md
git commit -m "test: validate X video subtitle workflow"
```

## Completion gate

Do not open a pull request until all of the following are true:

- The PostgreSQL migration test proves old YouTube history remains readable.
- API, extension unit, typecheck, build, and Playwright suites pass.
- Docker API and worker images build with `ffmpeg` and cached `faster-whisper small`.
- The main X video completes either direct download or browser upload fallback.
- The X player shows only Chinese subtitles and never reloads on seek.
- Logs and database inspection contain no X Cookie, X authorization data, LLM API Key, or media URL query parameters.
- Temporary media disappears after success, failure, cancellation, and expiry.
