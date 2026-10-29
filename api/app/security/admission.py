"""Durable resource limits, serialized with admission and committed with the work.

Daily usage is charged on acceptance (including failed work), not refunded by
deleting uploads or retrying tasks. Active reservations are derived from DB state.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import shutil

from fastapi import HTTPException
from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import DBAPIError

from app.core.settings import Settings
from app.db.models import AnalysisJob, MediaUploadSession, QuotaUsage, Video


ACTIVE_JOBS = {
    "queued",
    "waiting_for_media",
    "downloading_media",
    "extracting_audio",
    "transcribing",
    "fetching_transcript",
    "translating",
    "analyzing",
}
RESERVED_UPLOADS = {"created", "uploading", "complete", "consumed", "failed"}
ACTIVE_UPLOADS = {"created", "uploading"}
_ADMISSION_LOCK = 796601030


def reject(code: str, message: str, *, status: int = 429, retry: int = 60):
    raise HTTPException(
        status,
        detail={"code": code, "message": message},
        headers={"Retry-After": str(retry)},
    )


async def acquire_admission_lock(database: AsyncSession) -> None:
    # Call only before mutations. Restart the read-only transaction so SQLite
    # acquires its writer lock before any read snapshot can become stale.
    await database.rollback()
    if database.get_bind().dialect.name == "sqlite":
        await database.execute(text("BEGIN IMMEDIATE"))
    else:
        try:
            await database.execute(text("SET LOCAL lock_timeout = '2s'"))
            await database.execute(
                text("SELECT pg_advisory_xact_lock(:key)"), {"key": _ADMISSION_LOCK}
            )
        except DBAPIError as error:
            await database.rollback()
            raise HTTPException(
                503,
                detail={
                    "code": "admission_busy",
                    "message": "服务正在接收其他任务，请稍后重试。",
                },
                headers={"Retry-After": "2"},
            ) from error


async def _charge(
    database: AsyncSession,
    kind: str,
    subject: str,
    installation_id: str,
    resource_id: str,
    amount: int,
    *,
    count_limits: tuple[int, int, int] | None,
    amount_limits: tuple[int, int, int] | None,
    code: str,
    amount_code: str | None = None,
) -> None:
    now = datetime.now(timezone.utc)
    base = [QuotaUsage.kind == kind, QuotaUsage.created_at > now - timedelta(days=1)]
    scopes = [
        QuotaUsage.subject == subject,
        QuotaUsage.installation_id == installation_id,
        True,
    ]
    for index, scope in enumerate(scopes):
        count, used = (
            await database.execute(
                select(
                    func.count(),
                    func.coalesce(func.sum(QuotaUsage.amount), 0),
                ).where(*base, scope)
            )
        ).one()
        if count_limits and count >= count_limits[index]:
            reject(code, "过去 24 小时的使用次数已达上限，请稍后再试。", retry=86400)
        if amount_limits and used + amount > amount_limits[index]:
            reject(
                amount_code or code,
                "过去 24 小时的媒体或语音识别额度已用完，请稍后再试。",
                retry=86400,
            )
    database.add(
        QuotaUsage(
            kind=kind,
            subject=subject,
            installation_id=installation_id,
            resource_id=resource_id,
            amount=amount,
        )
    )


async def admit_registration(
    database: AsyncSession, settings: Settings, subject: str, installation_id: str
) -> None:
    await _charge(
        database,
        "registration",
        subject,
        installation_id,
        installation_id,
        0,
        count_limits=(
            settings.registration_limit_per_ip_per_day,
            settings.registration_limit_per_ip_per_day,
            settings.registration_limit_global_per_day,
        ),
        amount_limits=None,
        code="registration_daily_limit",
    )


def _resources_for_subject(kind: str, subject: str):
    return select(QuotaUsage.resource_id).where(
        QuotaUsage.kind == kind, QuotaUsage.subject == subject
    )


async def reserved_temp_bytes(database: AsyncSession, settings: Settings) -> int:
    media = await database.scalar(
        select(func.coalesce(func.sum(MediaUploadSession.expected_bytes), 0)).where(
            MediaUploadSession.status.in_(RESERVED_UPLOADS)
        )
    )
    jobs = await database.scalar(
        select(func.count())
        .select_from(AnalysisJob)
        .join(Video, Video.content_id == AnalysisJob.content_id)
        .where(AnalysisJob.status.in_(ACTIVE_JOBS), Video.platform == "x")
    )
    return int(media or 0) + int(jobs or 0) * settings.max_temp_bytes_per_job


async def ensure_temp_capacity(
    database: AsyncSession, settings: Settings, additional_bytes: int
) -> None:
    reserved = await reserved_temp_bytes(database, settings)
    required = reserved + additional_bytes
    if required > settings.max_temp_bytes_global:
        reject(
            "media_global_capacity",
            "服务临时存储额度已满，请等待其他任务结束后再试。",
            status=503,
        )
    # The configured mount may not yet contain a media directory. Inspect the
    # closest existing parent on the same filesystem without creating user data.
    root = Path(settings.media_temp_root).resolve()
    while not root.exists() and root.parent != root:
        root = root.parent
    try:
        free = shutil.disk_usage(root).free
    except OSError as error:
        raise HTTPException(
            503,
            detail={
                "code": "media_storage_unavailable",
                "message": "无法检查临时存储，请稍后重试。",
            },
        ) from error
    # Deliberately conservative: existing on-disk bytes are not subtracted from
    # reservations, so staged copies and partially written files remain covered.
    if free < required + settings.min_media_free_disk_bytes:
        reject("media_disk_low", "服务可用磁盘空间不足，请稍后重试。", status=503)


async def admit_analysis(
    database: AsyncSession,
    settings: Settings,
    subject: str,
    installation_id: str,
    job_id: str,
    platform: str,
) -> None:
    active = (
        select(func.count())
        .select_from(AnalysisJob)
        .where(AnalysisJob.status.in_(ACTIVE_JOBS))
    )
    if (await database.scalar(active) or 0) >= settings.max_active_jobs_global:
        reject(
            "global_analysis_concurrency_limit",
            "服务分析队列已满，请稍后重试。",
            status=503,
        )
    if (
        await database.scalar(
            active.where(
                AnalysisJob.id.in_(_resources_for_subject("analysis", subject))
            )
        )
        or 0
    ) >= settings.max_active_jobs_per_ip:
        reject(
            "ip_analysis_concurrency_limit",
            "当前网络已有视频正在分析，请等待完成后再试。",
        )
    # X durations are supplied by browsers and are not a trustworthy CPU budget.
    # Reserve the full allowed duration for every accepted ASR attempt.
    asr_seconds = settings.max_video_duration_seconds if platform == "x" else 0
    if asr_seconds:
        await ensure_temp_capacity(database, settings, settings.max_temp_bytes_per_job)
    await _charge(
        database,
        "analysis",
        subject,
        installation_id,
        job_id,
        asr_seconds,
        count_limits=(
            settings.analysis_limit_per_ip_per_day,
            settings.analysis_limit_per_installation_per_day,
            settings.analysis_limit_global_per_day,
        ),
        amount_limits=(
            settings.asr_seconds_per_ip_per_day,
            settings.asr_seconds_per_installation_per_day,
            settings.asr_seconds_global_per_day,
        ),
        code="analysis_daily_limit",
        amount_code="asr_daily_limit",
    )


async def admit_upload(
    database: AsyncSession,
    settings: Settings,
    subject: str,
    installation_id: str,
    upload_id: str,
    expected_bytes: int,
) -> None:
    active = (
        select(func.count())
        .select_from(MediaUploadSession)
        .where(MediaUploadSession.status.in_(ACTIVE_UPLOADS))
    )
    if (
        await database.scalar(active) or 0
    ) >= settings.max_active_media_upload_sessions_global:
        reject(
            "global_media_session_limit", "服务上传队列已满，请稍后重试。", status=503
        )
    if (
        await database.scalar(
            active.where(
                MediaUploadSession.id.in_(_resources_for_subject("media", subject))
            )
        )
        or 0
    ) >= settings.max_active_media_upload_sessions_per_ip:
        reject("ip_media_session_limit", "当前网络已有媒体正在上传，请等待完成后再试。")
    await ensure_temp_capacity(database, settings, expected_bytes)
    await _charge(
        database,
        "media",
        subject,
        installation_id,
        upload_id,
        expected_bytes,
        count_limits=None,
        amount_limits=(
            settings.media_bytes_per_ip_per_day,
            settings.media_bytes_per_installation_per_day,
            settings.media_bytes_global_per_day,
        ),
        code="media_daily_limit",
    )


async def cleanup_usage(database: AsyncSession) -> int:
    """Keep rolling daily usage and all records backing outstanding reservations."""
    result = await database.execute(
        delete(QuotaUsage).where(
            QuotaUsage.created_at < datetime.now(timezone.utc) - timedelta(days=2),
            QuotaUsage.resource_id.not_in(
                select(AnalysisJob.id).where(AnalysisJob.status.in_(ACTIVE_JOBS))
            ),
            QuotaUsage.resource_id.not_in(
                select(MediaUploadSession.id).where(
                    MediaUploadSession.status.in_(RESERVED_UPLOADS)
                )
            ),
        )
    )
    return result.rowcount
