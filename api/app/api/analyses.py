from __future__ import annotations

import hashlib
from collections.abc import Callable
from urllib.parse import parse_qs, urlparse

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.models import AnalysisJob, AnalysisResult, Video
from app.db.session import get_session
from app.services.transcripts import TranscriptInspection, TranscriptService


router = APIRouter(prefix="/v1")
JobDispatcher = Callable[[str], object]


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


class AnalysisCreateRequest(ApiModel):
    video_id: str
    source_language: str
    target_language: str = "zh-Hans"
    title: str | None = None


class AnalysisCreateResponse(ApiModel):
    job_id: str
    cache_hit: bool
    status: str


class AnalysisStatusResponse(ApiModel):
    job_id: str
    status: str
    failure_code: str | None = None
    failure_detail: str | None = None


class AnalysisResultResponse(ApiModel):
    job_id: str
    video_id: str
    source_language: str
    target_language: str
    one_line_summary: str
    summary_points: list[str]
    chapters: list[dict]
    highlights: list[dict]
    model_name: str
    model_version: str


def get_transcript_service() -> TranscriptService:
    return TranscriptService()


def dispatch_analysis_job(job_id: str) -> object:
    from app.workers.tasks import analyze_video

    return analyze_video.delay(job_id)


def get_job_dispatcher() -> JobDispatcher:
    return dispatch_analysis_job


@router.post("/videos/inspect", response_model=InspectResponse)
async def inspect_video(
    request: InspectRequest,
    transcript_service: TranscriptService = Depends(get_transcript_service),
) -> InspectResponse:
    video_id = extract_youtube_video_id(request.url)
    inspection = await run_in_threadpool(
        transcript_service.inspect, video_id, request.preferred_languages
    )
    _require_available_transcript(inspection)
    assert inspection.selected is not None
    duration_ms = max(segment.start_ms + segment.duration_ms for segment in inspection.segments)
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
    dispatcher: JobDispatcher = Depends(get_job_dispatcher),
) -> AnalysisCreateResponse:
    _validate_video_id(request.video_id)
    inspection = await run_in_threadpool(
        transcript_service.inspect, request.video_id, [request.source_language]
    )
    _require_available_transcript(inspection)
    if inspection.selected is None or inspection.selected.language_code != request.source_language:
        raise _api_error(422, "source_language_unavailable", "所选字幕语言不可读取")

    transcript_version = _transcript_version(inspection)
    cache_key = ":".join(
        [request.video_id, request.source_language, request.target_language, transcript_version]
    )
    existing = await session.scalar(select(AnalysisJob).where(AnalysisJob.cache_key == cache_key))
    if existing and existing.status != "failed":
        cache_hit = existing.status == "completed"
        response.status_code = 200 if cache_hit else 202
        return AnalysisCreateResponse(
            job_id=existing.id, cache_hit=cache_hit, status=existing.status
        )

    duration_ms = max(segment.start_ms + segment.duration_ms for segment in inspection.segments)
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
        job = AnalysisJob(
            video_id=request.video_id,
            source_language=request.source_language,
            target_language=request.target_language,
            cache_key=cache_key,
        )
        session.add(job)
    else:
        job = existing
        job.status = "queued"
        job.failure_code = None
        job.failure_detail = None
        job.completed_at = None

    await session.commit()
    await session.refresh(job)
    dispatcher(job.id)
    response.status_code = 202
    return AnalysisCreateResponse(job_id=job.id, cache_hit=False, status=job.status)


@router.get("/analyses/{job_id}", response_model=AnalysisStatusResponse)
async def get_analysis_status(
    job_id: str, session: AsyncSession = Depends(get_session)
) -> AnalysisStatusResponse:
    job = await session.get(AnalysisJob, job_id)
    if job is None:
        raise _api_error(404, "analysis_not_found", "没有找到这个分析任务")
    return AnalysisStatusResponse(
        job_id=job.id,
        status=job.status,
        failure_code=job.failure_code,
        failure_detail=job.failure_detail,
    )


@router.get("/analyses/{job_id}/result", response_model=AnalysisResultResponse)
async def get_analysis_result(
    job_id: str, session: AsyncSession = Depends(get_session)
) -> AnalysisResultResponse:
    job = await session.scalar(
        select(AnalysisJob)
        .options(selectinload(AnalysisJob.result))
        .where(AnalysisJob.id == job_id)
    )
    if job is None:
        raise _api_error(404, "analysis_not_found", "没有找到这个分析任务")
    if job.status != "completed" or job.result is None:
        raise _api_error(409, "analysis_not_complete", "分析结果还没有准备好")
    result: AnalysisResult = job.result
    return AnalysisResultResponse(
        job_id=job.id,
        video_id=job.video_id,
        source_language=job.source_language,
        target_language=job.target_language,
        one_line_summary=result.one_line_summary,
        summary_points=result.summary_points,
        chapters=result.chapters,
        highlights=result.highlights,
        model_name=result.model_name,
        model_version=result.model_version,
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


def _validate_video_id(video_id: str) -> None:
    if not _is_video_id(video_id):
        raise _api_error(422, "invalid_video_id", "视频 ID 无效")


def _is_video_id(video_id: str) -> bool:
    return len(video_id) == 11 and all(character.isalnum() or character in "-_" for character in video_id)


def _transcript_version(inspection: TranscriptInspection) -> str:
    digest = hashlib.sha256()
    for segment in inspection.segments:
        digest.update(
            f"{segment.sequence}:{segment.start_ms}:{segment.duration_ms}:{segment.text}\n".encode()
        )
    return digest.hexdigest()


def _require_available_transcript(inspection: TranscriptInspection) -> None:
    if not inspection.available:
        raise _api_error(
            422,
            inspection.failure_code or "transcript_unavailable",
            "当前视频没有可读取字幕",
        )


def _api_error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})
