from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import uuid

from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AnalysisJob


_REAL_DATETIME = datetime


ACTIVE_JOB_STATUSES = {
    "queued",
    "waiting_for_media",
    "downloading_media",
    "extracting_audio",
    "transcribing",
    "fetching_transcript",
    "translating",
    "analyzing",
}
REQUEUEABLE_JOB_STATUSES = ACTIVE_JOB_STATUSES - {"queued", "waiting_for_media"}


@dataclass(frozen=True)
class JobLeaseClaim:
    token: str | None = None
    retry_at: datetime | None = None


async def claim_job_lease(
    session: AsyncSession,
    job_id: str,
    *,
    resume: bool,
    lease_seconds: float,
) -> JobLeaseClaim:
    now, expires_at = await _lease_timestamps(session, lease_seconds)
    token = str(uuid.uuid4())
    eligible_statuses = ACTIVE_JOB_STATUSES if resume else {"queued"}
    claimed_id = await session.scalar(
        update(AnalysisJob)
        .where(
            AnalysisJob.id == job_id,
            AnalysisJob.status.in_(eligible_statuses),
            or_(
                AnalysisJob.lease_token.is_(None),
                AnalysisJob.lease_expires_at.is_(None),
                AnalysisJob.lease_expires_at <= now,
            ),
        )
        .values(
            lease_token=token,
            lease_expires_at=expires_at,
        )
        .execution_options(synchronize_session=False)
        .returning(AnalysisJob.id)
    )
    if claimed_id is not None:
        await session.commit()
        return JobLeaseClaim(token=token)

    row = (
        await session.execute(
            select(
                AnalysisJob.status,
                AnalysisJob.lease_token,
                AnalysisJob.lease_expires_at,
            ).where(AnalysisJob.id == job_id)
        )
    ).one_or_none()
    await session.rollback()
    if row is None or row.status not in ACTIVE_JOB_STATUSES or not row.lease_token:
        return JobLeaseClaim()
    retry_at = row.lease_expires_at
    if retry_at is None:
        return JobLeaseClaim()
    if retry_at.tzinfo is None:
        retry_at = retry_at.replace(tzinfo=timezone.utc)
    return JobLeaseClaim(retry_at=retry_at)


async def update_owned_job(
    session: AsyncSession,
    job_id: str,
    lease_token: str,
    *,
    lease_seconds: float,
    values: dict,
) -> bool:
    now, expires_at = await _lease_timestamps(session, lease_seconds)
    result = await session.execute(
        update(AnalysisJob)
        .where(
            AnalysisJob.id == job_id,
            AnalysisJob.status.in_(ACTIVE_JOB_STATUSES),
            AnalysisJob.lease_token == lease_token,
            AnalysisJob.lease_expires_at > now,
        )
        .values(
            **values,
            lease_expires_at=expires_at,
        )
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        await session.rollback()
        return False
    await session.commit()
    return True


async def requeue_stale_job(
    session: AsyncSession,
    job_id: str,
    *,
    values: dict,
) -> bool:
    now, _ = await _lease_timestamps(session, 1)
    result = await session.execute(
        update(AnalysisJob)
        .where(
            AnalysisJob.id == job_id,
            AnalysisJob.status.in_(REQUEUEABLE_JOB_STATUSES),
            or_(
                AnalysisJob.lease_token.is_(None),
                AnalysisJob.lease_expires_at.is_(None),
                AnalysisJob.lease_expires_at <= now,
            ),
        )
        .values(
            **values,
            status="queued",
            lease_token=None,
            lease_expires_at=None,
        )
        .execution_options(synchronize_session=False)
    )
    await session.commit()
    return result.rowcount == 1


async def finish_owned_job(
    session: AsyncSession,
    job_id: str,
    lease_token: str,
    *,
    values: dict,
) -> bool:
    now, _ = await _lease_timestamps(session, 1)
    result = await session.execute(
        update(AnalysisJob)
        .where(
            AnalysisJob.id == job_id,
            AnalysisJob.status.in_(ACTIVE_JOB_STATUSES),
            AnalysisJob.lease_token == lease_token,
            AnalysisJob.lease_expires_at > now,
        )
        .values(
            **values,
            lease_token=None,
            lease_expires_at=None,
        )
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        await session.rollback()
        return False
    await session.commit()
    return True


async def timeout_job_delivery(
    session: AsyncSession,
    job_id: str,
    lease_token: str | None,
) -> tuple[str | None, datetime | None]:
    await session.scalar(
        select(AnalysisJob.id)
        .where(AnalysisJob.id == job_id)
        .with_for_update()
    )
    now, _ = await _lease_timestamps(session, 1)
    ownership_conditions = [
        AnalysisJob.lease_token == lease_token
        if lease_token is not None
        else AnalysisJob.lease_token.is_(None)
    ]
    if lease_token is not None:
        ownership_conditions.append(AnalysisJob.lease_expires_at > now)
    status_condition = (
        AnalysisJob.status.in_(ACTIVE_JOB_STATUSES)
        if lease_token is not None
        else AnalysisJob.status == "queued"
    )
    changed = (
        await session.execute(
            update(AnalysisJob)
            .where(
                AnalysisJob.id == job_id,
                status_condition,
                *ownership_conditions,
            )
            .values(
                status="failed",
                failure_code="analysis_timeout",
                failure_detail=None,
                completed_at=now,
                lease_token=None,
                lease_expires_at=None,
                llm_credential_ciphertext=None,
                llm_credential_expires_at=None,
                media_url_ciphertext=None,
            )
            .execution_options(synchronize_session=False)
            .returning(AnalysisJob.id, AnalysisJob.media_session_id)
        )
    ).one_or_none()
    if changed is not None:
        await session.commit()
        return changed.media_session_id, None

    row = (
        await session.execute(
            select(
                AnalysisJob.status,
                AnalysisJob.lease_token,
                AnalysisJob.lease_expires_at,
            ).where(AnalysisJob.id == job_id)
        )
    ).one_or_none()
    await session.rollback()
    if (
        row is not None
        and row.status in ACTIVE_JOB_STATUSES
        and row.lease_token is not None
    ):
        retry_at = row.lease_expires_at
        if retry_at is None:
            return None, datetime.now(timezone.utc) + timedelta(seconds=1)
        if retry_at.tzinfo is None:
            retry_at = retry_at.replace(tzinfo=timezone.utc)
        return None, retry_at
    return None, None


async def _lease_timestamps(
    session: AsyncSession, lease_seconds: float
) -> tuple[object, object]:
    duration = timedelta(seconds=max(1.0, lease_seconds))
    if session.get_bind().dialect.name == "postgresql":
        now = func.clock_timestamp()
        return now, now + duration
    now = await _database_now(session)
    return now, now + duration


async def _database_now(session: AsyncSession) -> datetime:
    bind = session.get_bind()
    if bind.dialect.name == "sqlite":
        value = await session.scalar(
            select(func.strftime("%Y-%m-%d %H:%M:%f", "now"))
        )
        return _REAL_DATETIME.fromisoformat(value).replace(tzinfo=timezone.utc)
    value = await session.scalar(select(func.now()))
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)
