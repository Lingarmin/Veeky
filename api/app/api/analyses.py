from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta, timezone
import hashlib
from typing import Any
from urllib.parse import parse_qs, urlparse
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.models import (
    AnalysisJob,
    AnalysisResult,
    Installation,
    TranscriptTrack,
    Translation,
    Video,
)
from app.db.session import get_session
from app.core.settings import Settings, get_settings
from app.services.transcripts import TranscriptInspection, TranscriptService, transcript_version
from app.services.video_metadata import VideoMetadataError, VideoMetadataService
from app.services.translation import provider_translation_version
from app.services.llm import (
    LLM_PROVIDER_DEFAULTS,
    LlmProviderError,
    build_llm_client,
    normalize_chat_completions_url,
    normalize_provider_config,
)
from app.security.installations import require_installation
from app.security.credentials import JobCredentialCipher
from app.security.quotas import (
    QuotaServiceUnavailable,
    RateLimitExceeded,
    InstallationLockUnavailable,
    RedisQuotaLimiter,
    get_quota_limiter,
)


router = APIRouter(prefix="/v1")
JobDispatcher = Callable[[str], object]
INTERRUPTIBLE_JOB_STATUSES = {"fetching_transcript", "translating", "analyzing"}


class WorkerUnavailableError(RuntimeError):
    pass


async def enforce_write_quota(
    installation: Installation = Depends(require_installation),
    limiter: RedisQuotaLimiter = Depends(get_quota_limiter),
    settings: Settings = Depends(get_settings),
) -> None:
    await _enforce_quota(
        limiter,
        installation.id,
        "write",
        settings.write_rate_limit_per_minute,
    )


async def enforce_read_quota(
    installation: Installation = Depends(require_installation),
    limiter: RedisQuotaLimiter = Depends(get_quota_limiter),
    settings: Settings = Depends(get_settings),
) -> None:
    await _enforce_quota(
        limiter,
        installation.id,
        "read",
        settings.read_rate_limit_per_minute,
    )


async def enforce_analysis_create_lock(
    installation: Installation = Depends(require_installation),
    limiter: RedisQuotaLimiter = Depends(get_quota_limiter),
):
    try:
        async with limiter.installation_create_lock(installation.id):
            yield
    except InstallationLockUnavailable as error:
        raise _analysis_concurrency_error() from error
    except QuotaServiceUnavailable as error:
        raise _api_error(
            503,
            "quota_service_unavailable",
            "服务暂时繁忙，请稍后再试。",
        ) from error


def to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class InspectRequest(ApiModel):
    url: str
    preferred_languages: list[str] = Field(default_factory=list)


class TrackResponse(ApiModel):
    language_code: str
    language_name: str
    is_generated: bool
    is_translatable: bool


class InspectResponse(ApiModel):
    video_id: str
    duration_ms: int
    tracks: list[TrackResponse]
    selected_language: str


class LlmConfigRequest(ApiModel):
    provider: str = "kimi"
    api_url: str = Field(min_length=1, max_length=1000)
    api_key: str = Field(min_length=1, max_length=500)
    model: str | None = Field(default=None, max_length=120)


class AnalysisCreateRequest(ApiModel):
    video_id: str
    source_language: str
    target_language: str = "zh-Hans"
    title: str | None = None
    llm_config: LlmConfigRequest | None = None
    force: bool = False


class LlmTestResponse(ApiModel):
    ok: bool
    message: str


class AnalysisCreateResponse(ApiModel):
    job_id: str
    cache_hit: bool
    status: str


class AnalysisStatusResponse(ApiModel):
    job_id: str
    status: str
    failure_code: str | None = None
    failure_detail: str | None = None


class AnalysisHistoryItemResponse(ApiModel):
    job_id: str
    video_id: str
    video_title: str
    duration_ms: int
    source_language: str
    target_language: str
    completed_at: datetime
    model_name: str
    model_version: str


class AnalysisHistoryResponse(ApiModel):
    items: list[AnalysisHistoryItemResponse]
    has_more: bool


class TranscriptSegmentResponse(ApiModel):
    id: str
    start_ms: int
    duration_ms: int
    original: str
    translated: str | None = None


class AnalysisResultResponse(ApiModel):
    job_id: str
    video_id: str
    video_title: str
    duration_ms: int
    source_language: str
    target_language: str
    is_generated: bool | None = None
    one_line_summary: str
    summary_points: list[str]
    chapters: list[dict]
    highlights: list[dict]
    transcript: list[TranscriptSegmentResponse] = Field(default_factory=list)
    partial: bool = False
    failure_code: str | None = None
    model_name: str
    model_version: str


@router.post("/llm/test", response_model=LlmTestResponse)
async def test_llm_connection(
    request: LlmConfigRequest,
    _: Installation = Depends(require_installation),
    __: None = Depends(enforce_write_quota),
) -> LlmTestResponse:
    try:
        config = normalize_provider_config(
            request.provider, request.api_url, request.api_key, request.model
        )
        client = build_llm_client(
            {
                "provider": config.provider,
                "api_url": config.api_url,
                "api_key": config.api_key,
                "model": config.model or "",
            }
        )
        await client.test_connection()
    except ValueError as error:
        raise _api_error(422, "llm_config_invalid", str(error)) from error
    except LlmProviderError as error:
        raise _api_error(502, error.code, str(error)) from error
    return LlmTestResponse(ok=True, message=f"{client.provider_label} 连接成功")


def get_transcript_service() -> TranscriptService:
    settings = get_settings()
    return TranscriptService(proxy_url=settings.youtube_transcript_proxy_url)


def get_video_metadata_service(
    settings: Settings = Depends(get_settings),
) -> VideoMetadataService:
    return VideoMetadataService(proxy_url=settings.youtube_transcript_proxy_url)


def dispatch_analysis_job(job_id: str) -> object:
    from app.workers.tasks import analyze_video, celery_app

    try:
        workers = celery_app.control.ping(timeout=2.0)
    except Exception as error:
        raise WorkerUnavailableError("Worker is unavailable") from error
    if not workers:
        raise WorkerUnavailableError("Worker is unavailable")
    return analyze_video.delay(job_id)


def get_job_dispatcher() -> JobDispatcher:
    return dispatch_analysis_job


def get_job_credential_cipher(
    settings: Settings = Depends(get_settings),
) -> JobCredentialCipher:
    try:
        return JobCredentialCipher(settings.llm_credential_encryption_key)
    except ValueError as error:
        raise _api_error(
            503,
            "credential_protection_unavailable",
            "服务端凭据保护尚未配置",
        ) from error


def get_pipeline_revision(settings: Settings = Depends(get_settings)) -> str:
    return "|".join(
        [
            f"libretranslate@{settings.libretranslate_version}",
            f"{settings.analysis_provider_model}@{settings.analysis_provider_version}",
            f"prompt@{settings.analysis_prompt_version}",
        ]
    )


@router.post("/videos/inspect", response_model=InspectResponse)
async def inspect_video(
    request: InspectRequest,
    transcript_service: TranscriptService = Depends(get_transcript_service),
    metadata_service: VideoMetadataService = Depends(get_video_metadata_service),
    settings: Settings = Depends(get_settings),
    _: Installation = Depends(require_installation),
    __: None = Depends(enforce_write_quota),
) -> InspectResponse:
    video_id = extract_youtube_video_id(request.url)
    duration_ms = await _video_duration_ms(metadata_service, video_id, settings)
    inspection = await run_in_threadpool(
        transcript_service.inspect, video_id, request.preferred_languages
    )
    _require_available_transcript(inspection)
    assert inspection.selected is not None
    return InspectResponse(
        video_id=video_id,
        duration_ms=duration_ms,
        tracks=[TrackResponse.model_validate(track, from_attributes=True) for track in inspection.tracks],
        selected_language=inspection.selected.language_code,
    )


@router.post("/analyses", response_model=AnalysisCreateResponse)
async def create_analysis(
    request: AnalysisCreateRequest,
    response: Response,
    session: AsyncSession = Depends(get_session),
    transcript_service: TranscriptService = Depends(get_transcript_service),
    metadata_service: VideoMetadataService = Depends(get_video_metadata_service),
    dispatcher: JobDispatcher = Depends(get_job_dispatcher),
    installation: Installation = Depends(require_installation),
    credential_cipher: JobCredentialCipher = Depends(get_job_credential_cipher),
    pipeline_revision: str = Depends(get_pipeline_revision),
    settings: Settings = Depends(get_settings),
    _: None = Depends(enforce_write_quota),
    __: None = Depends(enforce_analysis_create_lock),
) -> AnalysisCreateResponse:
    installation_id = installation.id
    _validate_llm_config(request.llm_config)
    _validate_video_id(request.video_id)
    duration_ms = await _video_duration_ms(
        metadata_service, request.video_id, settings
    )
    inspection = await run_in_threadpool(
        transcript_service.inspect, request.video_id, [request.source_language]
    )
    _require_available_transcript(inspection)
    if inspection.selected is None or inspection.selected.language_code != request.source_language:
        raise _api_error(422, "source_language_unavailable", "所选字幕语言不可读取")

    version = transcript_version(inspection.segments)
    cache_key = analysis_cache_key(
        installation_id,
        request.video_id,
        request.source_language,
        request.target_language,
        version,
        f"{pipeline_revision}|{request.llm_config.provider}|{request.llm_config.model or ''}|{normalize_chat_completions_url(request.llm_config.api_url)}",
    )
    if request.force:
        cache_key = f"{cache_key}:run:{uuid.uuid4().hex}"
    existing = await session.scalar(
        select(AnalysisJob).where(
            AnalysisJob.cache_key == cache_key,
            AnalysisJob.installation_id == installation_id,
        )
    )
    if existing and existing.status != "failed":
        if existing.status in INTERRUPTIBLE_JOB_STATUSES:
            # A worker can disappear after claiming a job. Re-queue the job when
            # the user explicitly starts the same analysis again.
            existing.status = "queued"
            _store_llm_credential(
                existing,
                request.llm_config,
                credential_cipher,
                settings.llm_credential_ttl_seconds,
            )
            await session.commit()
            try:
                dispatcher(existing.id)
            except WorkerUnavailableError as error:
                existing.status = "failed"
                existing.failure_code = "worker_unavailable"
                existing.failure_detail = str(error)
                existing.completed_at = datetime.now(timezone.utc)
                _clear_llm_credential(existing)
                await session.commit()
                raise _api_error(
                    503,
                    "worker_unavailable",
                    "后台任务服务未启动，请运行 docker compose up -d 后重试",
                ) from error
            except Exception as error:
                existing.status = "failed"
                existing.failure_code = "dispatch_failed"
                existing.failure_detail = str(error)
                existing.completed_at = datetime.now(timezone.utc)
                _clear_llm_credential(existing)
                await session.commit()
                raise _api_error(
                    503, "dispatch_failed", "后台任务暂时无法启动，请重试"
                ) from error
        cache_hit = existing.status == "completed"
        response.status_code = 200 if cache_hit else 202
        return AnalysisCreateResponse(
            job_id=existing.id, cache_hit=cache_hit, status=existing.status
        )

    active_jobs = await session.scalar(
        select(func.count())
        .select_from(AnalysisJob)
        .where(
            AnalysisJob.installation_id == installation_id,
            AnalysisJob.status.in_(
                {"queued", "fetching_transcript", "translating", "analyzing"}
            ),
        )
    )
    if (active_jobs or 0) >= settings.max_active_jobs_per_installation:
        raise _analysis_concurrency_error()

    video = await session.get(Video, request.video_id)
    if video is None:
        video = Video(
            video_id=request.video_id,
            title=request.title or f"YouTube video {request.video_id}",
            duration_ms=duration_ms,
            source_url=f"https://www.youtube.com/watch?v={request.video_id}",
        )
        session.add(video)
    elif request.title:
        video.title = request.title
        video.duration_ms = duration_ms

    if existing is None:
        job_id = str(uuid.uuid4())
        job = AnalysisJob(
            id=job_id,
            installation_id=installation_id,
            video_id=request.video_id,
            source_language=request.source_language,
            target_language=request.target_language,
            transcript_version=version,
            cache_key=cache_key,
            llm_config=_llm_snapshot(request.llm_config),
        )
        _store_llm_credential(
            job,
            request.llm_config,
            credential_cipher,
            settings.llm_credential_ttl_seconds,
        )
        session.add(job)
    else:
        job = existing
        job.status = "queued"
        job.failure_code = None
        job.failure_detail = None
        job.completed_at = None
        job.transcript_version = version
        job.llm_config = _llm_snapshot(request.llm_config)
        _store_llm_credential(
            job,
            request.llm_config,
            credential_cipher,
            settings.llm_credential_ttl_seconds,
        )

    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        concurrent = await session.scalar(
            select(AnalysisJob).where(
                AnalysisJob.cache_key == cache_key,
                AnalysisJob.installation_id == installation_id,
            )
        )
        if concurrent is None:
            active_job = await session.scalar(
                select(AnalysisJob).where(
                    AnalysisJob.installation_id == installation_id,
                    AnalysisJob.status.in_(
                        {"queued", "fetching_transcript", "translating", "analyzing"}
                    ),
                )
            )
            if active_job is not None:
                raise _analysis_concurrency_error()
            raise
        response.status_code = 200 if concurrent.status == "completed" else 202
        return AnalysisCreateResponse(
            job_id=concurrent.id,
            cache_hit=concurrent.status == "completed",
            status=concurrent.status,
        )
    await session.refresh(job)
    try:
        dispatcher(job.id)
    except WorkerUnavailableError as error:
        job.status = "failed"
        job.failure_code = "worker_unavailable"
        job.failure_detail = str(error)
        job.completed_at = datetime.now(timezone.utc)
        _clear_llm_credential(job)
        await session.commit()
        raise _api_error(
            503,
            "worker_unavailable",
            "后台任务服务未启动，请运行 docker compose up -d 后重试",
        ) from error
    except Exception as error:
        job.status = "failed"
        job.failure_code = "dispatch_failed"
        job.failure_detail = str(error)
        job.completed_at = datetime.now(timezone.utc)
        _clear_llm_credential(job)
        await session.commit()
        raise _api_error(503, "dispatch_failed", "后台任务暂时无法启动，请重试") from error
    response.status_code = 202
    return AnalysisCreateResponse(job_id=job.id, cache_hit=False, status=job.status)


@router.get("/analyses/history", response_model=AnalysisHistoryResponse)
async def get_analysis_history(
    video_id: str | None = Query(default=None, alias="videoId"),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    session: AsyncSession = Depends(get_session),
    installation: Installation = Depends(require_installation),
    _: None = Depends(enforce_read_quota),
) -> AnalysisHistoryResponse:
    installation_id = installation.id
    query = (
        select(AnalysisJob, Video, AnalysisResult)
        .join(Video, Video.video_id == AnalysisJob.video_id)
        .join(AnalysisResult, AnalysisResult.job_id == AnalysisJob.id)
        .where(
            AnalysisJob.status == "completed",
            AnalysisJob.completed_at.is_not(None),
            AnalysisJob.installation_id == installation_id,
        )
    )
    if video_id is not None:
        query = query.where(AnalysisJob.video_id == video_id)
    rows = (
        await session.execute(
            query.order_by(AnalysisJob.completed_at.desc(), AnalysisJob.id.desc())
            .offset(offset)
            .limit(limit + 1)
        )
    ).all()
    return AnalysisHistoryResponse(
        items=[
            AnalysisHistoryItemResponse(
                job_id=job.id,
                video_id=job.video_id,
                video_title=video.title,
                duration_ms=video.duration_ms,
                source_language=job.source_language,
                target_language=job.target_language,
                completed_at=job.completed_at,
                model_name=result.model_name,
                model_version=result.model_version,
            )
            for job, video, result in rows[:limit]
            if job.completed_at is not None
        ],
        has_more=len(rows) > limit,
    )


@router.get("/analyses/{job_id}", response_model=AnalysisStatusResponse)
async def get_analysis_status(
    job_id: str,
    session: AsyncSession = Depends(get_session),
    installation: Installation = Depends(require_installation),
    _: None = Depends(enforce_read_quota),
) -> AnalysisStatusResponse:
    installation_id = installation.id
    job = await _owned_job(session, job_id, installation_id)
    return AnalysisStatusResponse(
        job_id=job.id,
        status=job.status,
        failure_code=job.failure_code,
        failure_detail=job.failure_detail,
    )


@router.get("/analyses/{job_id}/result", response_model=AnalysisResultResponse)
async def get_analysis_result(
    job_id: str,
    session: AsyncSession = Depends(get_session),
    installation: Installation = Depends(require_installation),
    _: None = Depends(enforce_read_quota),
) -> AnalysisResultResponse:
    installation_id = installation.id
    job = await _owned_job(
        session,
        job_id,
        installation_id,
        options=(selectinload(AnalysisJob.result), selectinload(AnalysisJob.video)),
    )
    partial = (
        (job.status == "failed" and job.failure_code == "translation_failed")
        or (job.status == "translating" and job.result is not None)
    )
    if not partial and (job.status != "completed" or job.result is None):
        raise _api_error(409, "analysis_not_complete", "分析结果还没有准备好")

    version = job.transcript_version
    track = await session.scalar(
        select(TranscriptTrack)
        .options(selectinload(TranscriptTrack.segments))
        .where(
            TranscriptTrack.video_id == job.video_id,
            TranscriptTrack.language_code == job.source_language,
            TranscriptTrack.transcript_version == version,
        )
        .order_by(TranscriptTrack.created_at.desc())
    )
    translated_by_id: dict[str, str] = {}
    if track is not None:
        translation_filters = [
            Translation.track_id == track.id,
            Translation.target_language == job.target_language,
            Translation.transcript_version == version,
        ]
        if job.llm_config and job.llm_config.get("provider", "kimi") == "kimi":
            translation_filters.extend(
                [
                    Translation.provider == job.llm_config.get("provider", "kimi"),
                    Translation.provider_version == provider_translation_version(
                        normalize_chat_completions_url(job.llm_config["api_url"]),
                        provider=job.llm_config.get("provider", "kimi"),
                        version=job.llm_config.get("model", "kimi-k2.5"),
                    ),
                ]
            )
        translation = await session.scalar(
            select(Translation)
            .where(*translation_filters)
            .order_by(Translation.created_at.desc())
        )
        if translation is None and job.llm_config.get("provider", "kimi") == "kimi":
            # Preserve results from injected/legacy providers while ensuring a
            # real Kimi result prefers the endpoint-specific cache entry.
            translation = await session.scalar(
                select(Translation)
                .where(
                    Translation.track_id == track.id,
                    Translation.target_language == job.target_language,
                    Translation.transcript_version == version,
                )
                .order_by(Translation.created_at.desc())
            )
        if translation is not None:
            translated_by_id = {
                str(segment["segment_id"]): str(segment["text"])
                for segment in translation.segments
                if segment.get("segment_id") and segment.get("text") is not None
            }

    result: AnalysisResult | None = job.result
    return AnalysisResultResponse(
        job_id=job.id,
        video_id=job.video_id,
        video_title=job.video.title,
        duration_ms=job.video.duration_ms,
        source_language=job.source_language,
        target_language=job.target_language,
        is_generated=track.is_generated if track is not None else None,
        one_line_summary=(
            result.one_line_summary if result else "翻译暂时失败，摘要尚未生成。"
        ),
        summary_points=result.summary_points if result else [],
        chapters=result.chapters if result else [],
        highlights=result.highlights if result else [],
        transcript=[
            TranscriptSegmentResponse(
                id=segment.id,
                start_ms=segment.start_ms,
                duration_ms=segment.duration_ms,
                original=segment.text,
                translated=translated_by_id.get(segment.id),
            )
            for segment in sorted(
                track.segments if track is not None else [],
                key=lambda item: item.sequence,
            )
        ],
        partial=partial,
        failure_code=job.failure_code if partial else None,
        model_name=result.model_name if result else "not-generated",
        model_version=result.model_version if result else "not-generated",
    )


def extract_youtube_video_id(url: str) -> str:
    try:
        parsed = urlparse(url)
    except ValueError as error:
        raise _api_error(422, "invalid_youtube_url", "请输入有效的 YouTube 视频链接") from error
    host = (parsed.hostname or "").lower()
    video_id = ""
    if host in {"youtu.be", "www.youtu.be"}:
        video_id = parsed.path.strip("/").split("/")[0]
    elif host == "youtube.com" or host.endswith(".youtube.com"):
        if parsed.path == "/watch":
            video_id = parse_qs(parsed.query).get("v", [""])[0]
        elif parsed.path.startswith("/shorts/"):
            video_id = parsed.path.split("/")[2]
    if parsed.scheme not in {"http", "https"} or not _is_video_id(video_id):
        raise _api_error(422, "invalid_youtube_url", "请输入有效的 YouTube 视频链接")
    return video_id


def analysis_cache_key(
    installation_id: str,
    video_id: str,
    source_language: str,
    target_language: str,
    transcript_version: str,
    pipeline_revision: str,
) -> str:
    revision = hashlib.sha256(pipeline_revision.encode()).hexdigest()[:16]
    return ":".join(
        [
            installation_id,
            video_id,
            source_language,
            target_language,
            transcript_version,
            revision,
        ]
    )


async def _owned_job(
    session: AsyncSession,
    job_id: str,
    installation_id: str,
    *,
    options: tuple[Any, ...] = (),
) -> AnalysisJob:
    query = select(AnalysisJob)
    if options:
        query = query.options(*options)
    job = await session.scalar(
        query.where(
            AnalysisJob.id == job_id,
            AnalysisJob.installation_id == installation_id,
        )
    )
    if job is None:
        raise _api_error(404, "analysis_not_found", "没有找到这个分析任务")
    return job


def _validate_video_id(video_id: str) -> None:
    if not _is_video_id(video_id):
        raise _api_error(422, "invalid_video_id", "视频 ID 无效")


def _validate_llm_config(config: LlmConfigRequest | None) -> None:
    if config is None:
        raise _api_error(422, "llm_config_required", "请先配置 LLM 服务")
    try:
        normalize_provider_config(config.provider, config.api_url, config.api_key, config.model)
    except ValueError as error:
        raise _api_error(422, "llm_config_invalid", str(error)) from error


def _llm_snapshot(config: LlmConfigRequest) -> dict[str, str]:
    normalized = normalize_provider_config(
        config.provider, config.api_url, config.api_key, config.model
    )
    return {
        "provider": normalized.provider,
        "api_url": normalized.api_url,
        "model": normalized.model,
    }


def _store_llm_credential(
    job: AnalysisJob,
    config: LlmConfigRequest,
    cipher: JobCredentialCipher,
    ttl_seconds: int,
) -> None:
    normalized = normalize_provider_config(
        config.provider, config.api_url, config.api_key, config.model
    )
    job.llm_credential_ciphertext = cipher.encrypt(job.id, normalized.api_key)
    job.llm_credential_expires_at = datetime.now(timezone.utc) + timedelta(
        seconds=ttl_seconds
    )


def _clear_llm_credential(job: AnalysisJob) -> None:
    job.llm_credential_ciphertext = None
    job.llm_credential_expires_at = None


async def _enforce_quota(
    limiter: RedisQuotaLimiter,
    subject: str,
    request_class: str,
    limit: int,
) -> None:
    try:
        await limiter.enforce(subject, request_class, limit)
    except RateLimitExceeded as error:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "rate_limit_exceeded",
                "message": "操作过于频繁，请稍后再试。",
            },
            headers={"Retry-After": str(error.retry_after)},
        ) from error
    except QuotaServiceUnavailable as error:
        raise _api_error(
            503,
            "quota_service_unavailable",
            "服务暂时繁忙，请稍后再试。",
        ) from error


def _analysis_concurrency_error() -> HTTPException:
    return _api_error(
        429,
        "analysis_concurrency_limit",
        "已有视频正在分析，请等待完成后再试。",
    )


async def _video_duration_ms(
    service: VideoMetadataService,
    video_id: str,
    settings: Settings,
) -> int:
    try:
        duration_ms = await run_in_threadpool(service.duration_ms, video_id)
    except VideoMetadataError as error:
        raise _api_error(
            502,
            "video_metadata_unavailable",
            "暂时无法读取视频时长，请稍后再试。",
        ) from error
    if duration_ms > settings.max_video_duration_seconds * 1000:
        raise _api_error(
            422,
            "video_too_long",
            "此视频时长过长，无法分析。",
        )
    return duration_ms


def _is_video_id(video_id: str) -> bool:
    return len(video_id) == 11 and all(character.isalnum() or character in "-_" for character in video_id)


def _require_available_transcript(inspection: TranscriptInspection) -> None:
    if not inspection.available:
        raise _api_error(
            422,
            inspection.failure_code or "transcript_unavailable",
            "当前视频没有可读取字幕",
        )


def _api_error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})
