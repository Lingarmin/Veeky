from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import shutil
import stat
import time
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal, TypedDict

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.settings import Settings
from app.db.models import (
    AnalysisJob,
    Installation,
    MediaUploadPart,
    MediaUploadSession,
    Video,
)


MEDIA_SESSION_STATES = {
    "created",
    "uploading",
    "complete",
    "consumed",
    "expired",
    "failed",
}
MEDIA_SESSION_TRANSITIONS = {
    "created": {"uploading", "expired", "failed"},
    "uploading": {"complete", "expired", "failed"},
    "complete": {"consumed", "expired", "failed"},
    "consumed": {"expired"},
    "expired": set(),
    "failed": {"expired"},
}
ACTIVE_UPLOAD_STATES = {"created", "uploading"}
RESERVED_UPLOAD_STATES = ACTIVE_UPLOAD_STATES | {"complete", "consumed", "failed"}
MAX_PART_COUNT = 100_000
MEDIA_CLEANUP_RETRY_DELAY_SECONDS = 900
logger = logging.getLogger(__name__)


class MediaUploadError(Exception):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


class PartIntegrityError(RuntimeError):
    pass


class MediaCleanupCounts(TypedDict):
    processed: int
    expired: int
    failed: int


@dataclass(frozen=True)
class MediaArtifact:
    session_id: str
    content_id: str
    kind: Literal["mp4", "hls"]
    path: Path
    total_bytes: int
    part_count: int


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


async def _to_thread_uninterruptibly(
    function: Callable[..., Any], /, *args: Any
) -> Any:
    task = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                pass
        try:
            task.result()
        except BaseException:
            pass
        raise


async def create_upload_session(
    database: AsyncSession,
    settings: Settings,
    installation_id: str,
    content_id: str,
    kind: Literal["mp4", "hls"],
    expected_bytes: int,
    part_count: int,
) -> MediaUploadSession:
    _validate_declaration(settings, expected_bytes, part_count)
    await _serialize_sqlite_write(database)
    await database.scalar(
        select(Installation.id)
        .where(Installation.id == installation_id)
        .with_for_update()
    )
    now = utc_now()
    expired_uploads = list(
        await database.scalars(
            select(MediaUploadSession)
            .options(selectinload(MediaUploadSession.parts))
            .where(
                MediaUploadSession.installation_id == installation_id,
                MediaUploadSession.expires_at <= now,
                MediaUploadSession.status.in_(RESERVED_UPLOAD_STATES),
            )
            .order_by(MediaUploadSession.expires_at, MediaUploadSession.id)
            .with_for_update()
        )
    )
    for expired_upload in expired_uploads:
        await _expire_uncommitted(database, settings, expired_upload)

    active_count, reserved_bytes = (
        await database.execute(
            select(
                func.count(MediaUploadSession.id).filter(
                    MediaUploadSession.status.in_(ACTIVE_UPLOAD_STATES)
                ),
                func.coalesce(
                    func.sum(MediaUploadSession.expected_bytes).filter(
                        MediaUploadSession.status.in_(RESERVED_UPLOAD_STATES)
                    ),
                    0,
                ),
            ).where(MediaUploadSession.installation_id == installation_id)
        )
    ).one()
    if active_count >= settings.max_active_media_upload_sessions_per_installation:
        if expired_uploads:
            await database.commit()
        raise _error(
            429,
            "media_session_limit",
            "installation already has the maximum active media uploads",
        )
    if reserved_bytes + expected_bytes > settings.max_media_bytes:
        if expired_uploads:
            await database.commit()
        raise _error(
            429,
            "media_reservation_limit",
            "installation has reserved the maximum media bytes",
        )
    content_exists = await database.scalar(
        select(Video.content_id).where(Video.content_id == content_id)
    )
    if content_exists is None:
        if expired_uploads:
            await database.commit()
        raise _error(404, "content_not_found", "content was not found")

    upload = MediaUploadSession(
        id=str(uuid.uuid4()),
        installation_id=installation_id,
        content_id=content_id,
        status="created",
        expected_bytes=expected_bytes,
        received_bytes=0,
        media_kind=kind,
        part_count=part_count,
        part_size_bytes=settings.media_chunk_bytes,
        hls_manifest=None,
        directory_key=str(uuid.uuid4()),
        created_at=now,
        updated_at=now,
        expires_at=now + timedelta(seconds=settings.media_upload_session_ttl_seconds),
        parts=[],
    )
    database.add(upload)
    await database.commit()
    await database.refresh(upload)
    return upload


async def get_owned_upload(
    database: AsyncSession,
    settings: Settings,
    session_id: str,
    installation_id: str,
    *,
    expire: bool = True,
) -> MediaUploadSession:
    upload = await _select_owned(database, session_id, installation_id)
    if upload is None:
        raise _error(404, "media_session_not_found", "media session was not found")
    if expire and _is_expired(upload):
        await _serialize_sqlite_write(database)
        upload = await _lock_owned(database, session_id, installation_id)
        if upload is None:
            raise _error(404, "media_session_not_found", "media session was not found")
        if _is_expired(upload):
            await _expire_locked(database, settings, upload)
    return upload


async def store_part(
    database: AsyncSession,
    settings: Settings,
    upload: MediaUploadSession,
    part_number: int,
    checksum: str,
    chunks: AsyncIterator[bytes],
) -> None:
    upload_id = upload.id
    installation_id = upload.installation_id
    if part_number < 0 or part_number >= upload.part_count:
        raise _error(422, "invalid_part_number", "part number is outside the declaration")
    expected_size = _expected_part_size(upload, part_number)
    staging_directory = _staging_directory(settings)
    temporary = staging_directory / f"{uuid.uuid4()}.tmp"
    created_file = False
    final_path: Path | None = None

    try:
        try:
            size, actual_checksum = await _write_temporary_part(
                staging_directory, temporary, chunks, expected_size
            )
        except MediaUploadError:
            raise
        except OSError as error:
            raise _error(
                503, "storage_unavailable", "media storage is unavailable"
            ) from error
        if actual_checksum != checksum.lower():
            raise _error(422, "checksum_mismatch", "part checksum does not match")

        await _restart_write_transaction(database)
        locked = await _lock_owned(database, upload_id, installation_id)
        if locked is None:
            raise _error(404, "media_session_not_found", "media session was not found")
        if _is_expired(locked):
            await _expire_locked(database, settings, locked)
            raise _error(409, "upload_expired", "media upload session has expired")

        existing = next(
            (part for part in locked.parts if part.part_number == part_number), None
        )
        metadata_matches = (
            existing is not None
            and existing.byte_size == size
            and existing.sha256 == actual_checksum
        )
        if locked.status in {"complete", "consumed"}:
            if metadata_matches:
                await database.commit()
                return
            raise _invalid_state(locked.status)
        if locked.status not in {"created", "uploading"}:
            raise _invalid_state(locked.status)
        if existing is not None and not metadata_matches:
            raise _error(
                409,
                "part_conflict",
                "part number already contains different bytes",
            )

        directory = _session_directory(settings, locked)
        final_path = _part_path(directory, part_number)
        try:
            created_file = await _to_thread_uninterruptibly(
                _publish_part_sync,
                temporary,
                final_path,
                size,
                actual_checksum,
            )
        except PartIntegrityError as error:
            raise _error(409, "part_conflict", str(error)) from error

        if existing is not None:
            await database.commit()
            created_file = False
            return

        locked.parts.append(
            MediaUploadPart(
                part_number=part_number,
                byte_size=size,
                sha256=actual_checksum,
                created_at=utc_now(),
            )
        )
        locked.received_bytes += size
        if locked.received_bytes > locked.expected_bytes:
            _transition(locked, "failed")
            await database.commit()
            created_file = False
            raise _error(409, "upload_failed", "received media exceeds its declaration")
        if locked.status == "created":
            _transition(locked, "uploading")
        locked.updated_at = utc_now()
        await database.commit()
        created_file = False
    except OSError as error:
        await database.rollback()
        raise _error(
            503, "storage_unavailable", "media storage is unavailable"
        ) from error
    finally:
        if created_file and final_path is not None:
            await _to_thread_uninterruptibly(_unlink_and_fsync_sync, final_path)
        await asyncio.to_thread(_unlink_if_exists_sync, temporary)


async def complete_upload(
    database: AsyncSession,
    settings: Settings,
    upload: MediaUploadSession,
    part_count: int,
    total_bytes: int,
    manifest: dict[str, Any] | None,
) -> MediaArtifact:
    upload_id = upload.id
    installation_id = upload.installation_id
    await _restart_write_transaction(database)
    locked = await _lock_owned(database, upload_id, installation_id)
    if locked is None:
        raise _error(404, "media_session_not_found", "media session was not found")
    if _is_expired(locked):
        await _expire_locked(database, settings, locked)
        raise _error(409, "upload_expired", "media upload session has expired")
    if locked.status == "consumed":
        raise _error(409, "upload_consumed", "media upload has already been consumed")
    if locked.status == "failed":
        raise _error(409, "upload_failed", "media upload session has failed")
    if part_count != locked.part_count or total_bytes != locked.expected_bytes:
        raise _error(
            422,
            "completion_declaration_mismatch",
            "completion does not match the upload declaration",
        )

    directory = _session_directory(settings, locked)
    if locked.status == "complete":
        artifact_path = _artifact_path(directory, locked.media_kind)
        if not await _to_thread_uninterruptibly(artifact_path.is_file):
            _transition(locked, "failed")
            await database.commit()
            raise _error(409, "upload_failed", "completed media artifact is missing")
        if locked.media_kind == "mp4":
            try:
                await _to_thread_uninterruptibly(
                    _remove_part_files_sync, directory, locked.parts
                )
            except OSError as error:
                await database.rollback()
                raise _error(
                    503, "storage_unavailable", "media storage is unavailable"
                ) from error
        await database.commit()
        return _artifact(locked, artifact_path)
    if (
        locked.status != "uploading"
        or locked.received_bytes != locked.expected_bytes
        or [part.part_number for part in locked.parts]
        != list(range(locked.part_count))
    ):
        raise _error(409, "upload_incomplete", "not all declared parts are present")

    try:
        if locked.media_kind == "mp4":
            if manifest is not None:
                raise _error(
                    422, "unexpected_manifest", "MP4 uploads do not use a manifest"
                )
            artifact_path = directory / "media.mp4"
            if await _to_thread_uninterruptibly(artifact_path.is_file):
                await _to_thread_uninterruptibly(
                    _verify_mp4_artifact_sync,
                    artifact_path,
                    locked.expected_bytes,
                    locked.parts,
                )
                await _to_thread_uninterruptibly(
                    _remove_mp4_work_files_sync, directory, locked.parts
                )
            else:
                artifact_path = await _to_thread_uninterruptibly(
                    _assemble_mp4_sync,
                    directory,
                    locked.expected_bytes,
                    locked.parts,
                )
        else:
            canonical_manifest = _validate_hls_manifest(manifest, locked.part_count)
            await _to_thread_uninterruptibly(
                _verify_parts_sync, directory, locked.parts
            )
            artifact_path = directory / "manifest.json"
            await _to_thread_uninterruptibly(
                _atomic_write_sync,
                artifact_path,
                json.dumps(canonical_manifest, separators=(",", ":")).encode("utf-8"),
            )
            locked.hls_manifest = canonical_manifest
    except PartIntegrityError as error:
        _transition(locked, "failed")
        locked.updated_at = utc_now()
        await database.commit()
        raise _error(409, "part_integrity_failed", str(error)) from error
    except OSError as error:
        if locked.media_kind == "mp4":
            await database.rollback()
        else:
            _transition(locked, "failed")
            locked.updated_at = utc_now()
            await database.commit()
        raise _error(
            503, "storage_unavailable", "media storage is unavailable"
        ) from error

    _transition(locked, "complete")
    locked.updated_at = utc_now()
    await database.commit()
    return _artifact(locked, artifact_path)


async def delete_upload(
    database: AsyncSession,
    settings: Settings,
    upload: MediaUploadSession,
) -> None:
    upload_id = upload.id
    installation_id = upload.installation_id
    await _restart_write_transaction(database)
    locked = await _lock_owned(database, upload_id, installation_id)
    if locked is None:
        raise _error(404, "media_session_not_found", "media session was not found")
    if locked.status == "consumed":
        await database.rollback()
        raise _error(409, "upload_consumed", "media upload has already been consumed")
    await _expire_locked(database, settings, locked)


async def expire_complete_upload_if_unreferenced(
    database: AsyncSession,
    settings: Settings,
    *,
    session_id: str,
    installation_id: str,
    content_id: str,
    excluding_job_id: str,
) -> bool:
    await _restart_write_transaction(database)
    upload = await _lock_unreferenced_complete_upload(
        database,
        session_id=session_id,
        installation_id=installation_id,
        content_id=content_id,
        excluding_job_id=excluding_job_id,
    )
    if upload is None:
        await database.rollback()
        return False
    try:
        await _expire_locked(database, settings, upload)
    except MediaUploadError as error:
        if error.code != "storage_unavailable":
            raise
        await _restart_write_transaction(database)
        upload = await _lock_unreferenced_complete_upload(
            database,
            session_id=session_id,
            installation_id=installation_id,
            content_id=content_id,
            excluding_job_id=excluding_job_id,
        )
        if upload is None:
            await database.rollback()
            return False
        retry_at = utc_now()
        upload.updated_at = retry_at
        upload.expires_at = retry_at
        await database.commit()
        return False
    return True


async def expire_consumed_upload_for_terminal_job(
    database: AsyncSession,
    settings: Settings,
    *,
    job_id: str,
    media_session_id: str | None = None,
) -> bool:
    await _restart_write_transaction(database)
    job_conditions = [
        AnalysisJob.id == job_id,
        AnalysisJob.status.in_(("completed", "failed")),
        AnalysisJob.lease_token.is_(None),
        AnalysisJob.media_session_id.is_not(None),
    ]
    if media_session_id is not None:
        job_conditions.append(AnalysisJob.media_session_id == media_session_id)
    job = await database.scalar(
        select(AnalysisJob).where(*job_conditions).with_for_update()
    )
    if job is None:
        await database.rollback()
        return False
    upload = await database.scalar(
        select(MediaUploadSession)
        .options(selectinload(MediaUploadSession.parts))
        .where(
            MediaUploadSession.id == job.media_session_id,
            MediaUploadSession.installation_id == job.installation_id,
            MediaUploadSession.content_id == job.content_id,
            MediaUploadSession.status == "consumed",
        )
        .with_for_update()
    )
    if upload is None:
        await database.rollback()
        return False
    active_reference = await database.scalar(
        select(AnalysisJob.id).where(
            AnalysisJob.id != job.id,
            AnalysisJob.media_session_id == upload.id,
            AnalysisJob.status.in_(
                (
                    "queued",
                    "waiting_for_media",
                    "downloading_media",
                    "extracting_audio",
                    "transcribing",
                    "fetching_transcript",
                    "translating",
                    "analyzing",
                )
            ),
        )
    )
    if active_reference is not None:
        await database.rollback()
        return False
    upload_id = upload.id
    try:
        await _expire_locked(database, settings, upload)
    except MediaUploadError as error:
        if error.code != "storage_unavailable":
            raise
        await _restart_write_transaction(database)
        retry_upload = await database.scalar(
            select(MediaUploadSession)
            .where(
                MediaUploadSession.id == upload_id,
                MediaUploadSession.status == "consumed",
            )
            .with_for_update()
        )
        if retry_upload is None:
            await database.rollback()
            return False
        retry_at = utc_now()
        retry_upload.updated_at = retry_at
        retry_upload.expires_at = retry_at
        await database.commit()
        return False
    return True


async def _lock_unreferenced_complete_upload(
    database: AsyncSession,
    *,
    session_id: str,
    installation_id: str,
    content_id: str,
    excluding_job_id: str,
) -> MediaUploadSession | None:
    upload = await database.scalar(
        select(MediaUploadSession)
        .options(selectinload(MediaUploadSession.parts))
        .where(
            MediaUploadSession.id == session_id,
            MediaUploadSession.installation_id == installation_id,
            MediaUploadSession.content_id == content_id,
            MediaUploadSession.status == "complete",
        )
        .with_for_update()
    )
    if upload is None:
        return None
    other_job_id = await database.scalar(
        select(AnalysisJob.id).where(
            AnalysisJob.id != excluding_job_id,
            AnalysisJob.media_session_id == session_id,
        )
    )
    if other_job_id is not None:
        return None
    return upload


async def cleanup_expired_uploads(
    database: AsyncSession,
    settings: Settings,
    *,
    limit: int = 100,
) -> MediaCleanupCounts:
    cutoff = time.time() - settings.media_upload_session_ttl_seconds
    await _to_thread_uninterruptibly(
        _cleanup_stale_staging_files_sync, settings, cutoff
    )
    bounded_limit = max(1, min(limit, 1000))
    session_ids = list(
        await database.scalars(
            select(MediaUploadSession.id)
            .where(
                MediaUploadSession.expires_at <= utc_now(),
                MediaUploadSession.status.not_in(("consumed", "expired")),
            )
            .order_by(MediaUploadSession.expires_at, MediaUploadSession.id)
            .limit(bounded_limit)
        )
    )
    await database.rollback()
    counts: MediaCleanupCounts = {"processed": 0, "expired": 0, "failed": 0}
    for session_id in session_ids:
        counts["processed"] += 1
        try:
            await _serialize_sqlite_write(database)
            upload = await database.scalar(
                select(MediaUploadSession)
                .options(selectinload(MediaUploadSession.parts))
                .where(MediaUploadSession.id == session_id)
                .with_for_update()
            )
            if (
                upload is not None
                and upload.status != "consumed"
                and _is_expired(upload)
            ):
                await _expire_locked(database, settings, upload)
                counts["expired"] += 1
            else:
                await database.rollback()
        except (MediaUploadError, OSError) as error:
            await database.rollback()
            counts["failed"] += 1
            error_code = (
                error.code
                if isinstance(error, MediaUploadError)
                else "storage_unavailable"
            )
            logger.warning(
                "expired media session cleanup failed",
                extra={
                    "cleanup_operation": "expire_session",
                    "media_session_id": session_id,
                    "error_code": error_code,
                },
            )
            await _defer_failed_cleanup(database, session_id)
    return counts


async def _defer_failed_cleanup(database: AsyncSession, session_id: str) -> None:
    try:
        await _serialize_sqlite_write(database)
        upload = await database.scalar(
            select(MediaUploadSession)
            .where(
                MediaUploadSession.id == session_id,
                MediaUploadSession.status.not_in(("consumed", "expired")),
            )
            .with_for_update()
        )
        if upload is None:
            await database.rollback()
            return
        now = utc_now()
        upload.updated_at = now
        upload.expires_at = now + timedelta(
            seconds=MEDIA_CLEANUP_RETRY_DELAY_SECONDS
        )
        await database.commit()
    except Exception:
        await database.rollback()
        logger.warning(
            "expired media session retry scheduling failed",
            extra={
                "cleanup_operation": "schedule_retry",
                "media_session_id": session_id,
                "error_code": "database_unavailable",
            },
        )


async def _select_owned(
    database: AsyncSession, session_id: str, installation_id: str
) -> MediaUploadSession | None:
    return await database.scalar(
        select(MediaUploadSession)
        .options(selectinload(MediaUploadSession.parts))
        .where(
            MediaUploadSession.id == session_id,
            MediaUploadSession.installation_id == installation_id,
        )
    )


async def _lock_owned(
    database: AsyncSession, session_id: str, installation_id: str
) -> MediaUploadSession | None:
    return await database.scalar(
        select(MediaUploadSession)
        .options(selectinload(MediaUploadSession.parts))
        .where(
            MediaUploadSession.id == session_id,
            MediaUploadSession.installation_id == installation_id,
        )
        .with_for_update()
    )


async def _expire_locked(
    database: AsyncSession,
    settings: Settings,
    upload: MediaUploadSession,
) -> None:
    await _expire_uncommitted(database, settings, upload)
    await database.commit()


async def _expire_uncommitted(
    database: AsyncSession,
    settings: Settings,
    upload: MediaUploadSession,
) -> None:
    try:
        await _to_thread_uninterruptibly(
            _remove_session_directory_sync, settings, upload
        )
    except OSError as error:
        await database.rollback()
        raise _error(
            503, "storage_unavailable", "media storage is unavailable"
        ) from error
    if upload.status != "expired":
        _transition(upload, "expired")
        upload.received_bytes = 0
        upload.parts.clear()
        upload.hls_manifest = None
        upload.updated_at = utc_now()
        upload.expires_at = upload.updated_at


async def _write_temporary_part(
    directory: Path,
    temporary: Path,
    chunks: AsyncIterator[bytes],
    expected_size: int,
) -> tuple[int, str]:
    await asyncio.to_thread(_ensure_directory_sync, directory)
    destination = await asyncio.to_thread(temporary.open, "xb")
    digest = hashlib.sha256()
    size = 0
    try:
        async for chunk in chunks:
            size += len(chunk)
            if size > expected_size:
                raise _error(422, "invalid_part_size", "part body has the wrong size")
            await asyncio.to_thread(_write_and_hash_sync, destination, digest, chunk)
        if size != expected_size:
            raise _error(422, "invalid_part_size", "part body has the wrong size")
        await asyncio.to_thread(_flush_fsync_close_sync, destination)
    except BaseException:
        await asyncio.to_thread(_close_quietly_sync, destination)
        await asyncio.to_thread(_unlink_if_exists_sync, temporary)
        raise
    return size, digest.hexdigest()


def _assemble_mp4_sync(
    directory: Path, expected_bytes: int, parts: list[MediaUploadPart]
) -> Path:
    artifact_path = directory / "media.mp4"
    assembly_path = directory / ".media.mp4.assembling"
    try:
        destination = assembly_path.open("r+b")
    except FileNotFoundError:
        destination = assembly_path.open("x+b")

    with destination:
        verified_bytes, next_part = _verified_assembly_prefix(destination, parts)
        destination.flush()
        os.fsync(destination.fileno())

        for part in parts[:next_part]:
            source_path = _part_path(directory, part.part_number)
            if source_path.exists():
                source_path.unlink()
                _fsync_directory_sync(directory)

        destination.seek(verified_bytes)
        for part in parts[next_part:]:
            source_path = _part_path(directory, part.part_number)
            part_start = destination.tell()
            digest = hashlib.sha256()
            part_size = 0
            try:
                with source_path.open("rb") as source:
                    while chunk := source.read(1024 * 1024):
                        digest.update(chunk)
                        part_size += len(chunk)
                        destination.write(chunk)
            except FileNotFoundError as error:
                raise PartIntegrityError(
                    "a verified media part is missing or changed"
                ) from error
            if part_size != part.byte_size or digest.hexdigest() != part.sha256:
                destination.truncate(part_start)
                destination.flush()
                os.fsync(destination.fileno())
                raise PartIntegrityError("a verified media part is missing or changed")
            verified_bytes += part_size
            destination.flush()
            os.fsync(destination.fileno())
            source_path.unlink(missing_ok=True)
            _fsync_directory_sync(directory)

        if verified_bytes != expected_bytes:
            raise PartIntegrityError("assembled media size is incorrect")

    os.replace(assembly_path, artifact_path)
    _fsync_directory_sync(directory)
    return artifact_path


def _verified_assembly_prefix(
    destination, parts: list[MediaUploadPart]
) -> tuple[int, int]:
    destination.seek(0)
    verified_bytes = 0
    for index, part in enumerate(parts):
        part_size, checksum = _read_segment_identity(destination, part.byte_size)
        if part_size == 0:
            destination.truncate(verified_bytes)
            return verified_bytes, index
        if part_size < part.byte_size:
            destination.truncate(verified_bytes)
            return verified_bytes, index
        if checksum != part.sha256:
            raise PartIntegrityError("assembled media data is missing or changed")
        verified_bytes += part_size
    if destination.read(1):
        raise PartIntegrityError("assembled media size is incorrect")
    return verified_bytes, len(parts)


def _verify_mp4_artifact_sync(
    artifact_path: Path,
    expected_bytes: int,
    parts: list[MediaUploadPart],
) -> None:
    try:
        with artifact_path.open("rb") as source:
            total_bytes = 0
            for part in parts:
                part_size, checksum = _read_segment_identity(source, part.byte_size)
                if part_size != part.byte_size or checksum != part.sha256:
                    raise PartIntegrityError(
                        "published media data is missing or changed"
                    )
                total_bytes += part_size
            if source.read(1) or total_bytes != expected_bytes:
                raise PartIntegrityError("published media size is incorrect")
    except FileNotFoundError as error:
        raise PartIntegrityError(
            "published media data is missing or changed"
        ) from error


def _read_segment_identity(source, expected_size: int) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    while size < expected_size:
        chunk = source.read(min(1024 * 1024, expected_size - size))
        if not chunk:
            break
        size += len(chunk)
        digest.update(chunk)
    return size, digest.hexdigest()


def _verify_parts_sync(directory: Path, parts: list[MediaUploadPart]) -> None:
    for part in parts:
        try:
            size, checksum = _file_identity(
                _part_path(directory, part.part_number)
            )
        except FileNotFoundError as error:
            raise PartIntegrityError(
                "a verified media part is missing or changed"
            ) from error
        if size != part.byte_size or checksum != part.sha256:
            raise PartIntegrityError("a verified media part is missing or changed")


def _publish_part_sync(
    temporary: Path,
    final_path: Path,
    size: int,
    checksum: str,
) -> bool:
    created = False
    try:
        _ensure_directory_sync(final_path.parent)
        try:
            os.link(temporary, final_path)
            created = True
        except FileExistsError:
            existing_size, existing_checksum = _file_identity(final_path)
            if existing_size != size or existing_checksum != checksum:
                raise PartIntegrityError(
                    "part number already contains different bytes"
                )
        if created:
            _fsync_directory_sync(final_path.parent)
        return created
    except BaseException:
        if created:
            final_path.unlink(missing_ok=True)
        raise


def _atomic_write_sync(path: Path, body: bytes) -> None:
    temporary = path.parent / f".write-{uuid.uuid4()}.tmp"
    try:
        with temporary.open("xb") as destination:
            destination.write(body)
            destination.flush()
            os.fsync(destination.fileno())
        os.replace(temporary, path)
        _fsync_directory_sync(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def _remove_part_files_sync(directory: Path, parts: list[MediaUploadPart]) -> None:
    for part in parts:
        _part_path(directory, part.part_number).unlink(missing_ok=True)
    _fsync_directory_if_exists_sync(directory)


def _remove_mp4_work_files_sync(
    directory: Path, parts: list[MediaUploadPart]
) -> None:
    _remove_part_files_sync(directory, parts)
    (directory / ".media.mp4.assembling").unlink(missing_ok=True)
    _fsync_directory_if_exists_sync(directory)


def _cleanup_stale_staging_files_sync(
    settings: Settings, cutoff_timestamp: float
) -> None:
    staging = Path(settings.media_temp_root).resolve() / ".staging"
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(staging, flags)
    except (FileNotFoundError, NotADirectoryError):
        return
    removed = False
    try:
        with os.scandir(descriptor) as entries:
            for entry in entries:
                if not entry.is_file(follow_symlinks=False):
                    continue
                name = entry.name
                if not name.endswith(".tmp"):
                    continue
                stem = name.removesuffix(".tmp")
                try:
                    parsed = uuid.UUID(stem)
                except ValueError:
                    continue
                if str(parsed) != stem:
                    continue
                try:
                    metadata = entry.stat(follow_symlinks=False)
                except FileNotFoundError:
                    continue
                if (
                    not stat.S_ISREG(metadata.st_mode)
                    or metadata.st_mtime > cutoff_timestamp
                ):
                    continue
                try:
                    os.unlink(name, dir_fd=descriptor)
                except FileNotFoundError:
                    continue
                removed = True
        if removed:
            os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _remove_session_directory_sync(
    settings: Settings, upload: MediaUploadSession
) -> None:
    directory = _session_directory(settings, upload)
    root = directory.parent
    try:
        shutil.rmtree(directory)
    except FileNotFoundError:
        return
    else:
        _fsync_directory_sync(root)


def _ensure_directory_sync(directory: Path) -> None:
    existed = directory.exists()
    directory.mkdir(parents=True, exist_ok=True)
    if not existed:
        _fsync_directory_sync(directory.parent)


def _unlink_and_fsync_sync(path: Path) -> None:
    path.unlink(missing_ok=True)
    _fsync_directory_if_exists_sync(path.parent)


def _fsync_directory_sync(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _fsync_directory_if_exists_sync(directory: Path) -> None:
    try:
        _fsync_directory_sync(directory)
    except FileNotFoundError:
        pass


def _write_and_hash_sync(destination, digest, chunk: bytes) -> None:
    digest.update(chunk)
    destination.write(chunk)


def _flush_fsync_close_sync(destination) -> None:
    destination.flush()
    os.fsync(destination.fileno())
    destination.close()


def _close_quietly_sync(destination) -> None:
    try:
        destination.close()
    except OSError:
        pass


def _unlink_if_exists_sync(path: Path) -> None:
    path.unlink(missing_ok=True)


def _validate_declaration(
    settings: Settings, expected_bytes: int, part_count: int
) -> None:
    if expected_bytes <= 0:
        raise _error(422, "invalid_expected_bytes", "expectedBytes must be positive")
    if expected_bytes > settings.max_media_bytes:
        raise _error(422, "media_too_large", "media exceeds the configured size cap")
    expected_part_count = (expected_bytes + settings.media_chunk_bytes - 1) // (
        settings.media_chunk_bytes
    )
    if (
        part_count <= 0
        or part_count > MAX_PART_COUNT
        or part_count != expected_part_count
    ):
        raise _error(
            422,
            "invalid_part_declaration",
            "partCount does not match expectedBytes and the server part size",
        )


def _validate_hls_manifest(
    manifest: dict[str, Any] | None, part_count: int
) -> dict[str, list[int]]:
    if not isinstance(manifest, dict) or set(manifest) != {"parts"}:
        raise _error(422, "invalid_hls_manifest", "HLS manifest must contain parts")
    parts = manifest["parts"]
    if (
        not isinstance(parts, list)
        or len(parts) > MAX_PART_COUNT
        or any(type(part) is not int for part in parts)
        or parts != list(range(part_count))
    ):
        raise _error(
            422,
            "invalid_hls_manifest",
            "HLS manifest parts must be all uploaded numeric part IDs in order",
        )
    return {"parts": parts}


def _artifact(upload: MediaUploadSession, path: Path) -> MediaArtifact:
    return MediaArtifact(
        session_id=upload.id,
        content_id=upload.content_id,
        kind=upload.media_kind,
        path=path,
        total_bytes=upload.expected_bytes,
        part_count=upload.part_count,
    )


def _session_directory(settings: Settings, upload: MediaUploadSession) -> Path:
    try:
        directory_key = str(uuid.UUID(upload.directory_key))
    except ValueError as error:
        raise _error(409, "upload_failed", "media directory key is invalid") from error
    root = Path(settings.media_temp_root).resolve()
    directory = (root / directory_key).resolve()
    if directory.parent != root:
        raise _error(409, "upload_failed", "media directory is invalid")
    return directory


def _staging_directory(settings: Settings) -> Path:
    root = Path(settings.media_temp_root).resolve()
    return (root / ".staging").resolve()


def _part_path(directory: Path, part_number: int) -> Path:
    return directory / f"part-{part_number:08d}.bin"


def _artifact_path(directory: Path, kind: str) -> Path:
    return directory / ("media.mp4" if kind == "mp4" else "manifest.json")


def _expected_part_size(upload: MediaUploadSession, part_number: int) -> int:
    if part_number < upload.part_count - 1:
        return upload.part_size_bytes
    return upload.expected_bytes - upload.part_size_bytes * (upload.part_count - 1)


def _file_identity(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            size += len(chunk)
            digest.update(chunk)
    return size, digest.hexdigest()


def _transition(upload: MediaUploadSession, target: str) -> None:
    if target not in MEDIA_SESSION_TRANSITIONS[upload.status]:
        raise _error(
            409,
            "invalid_upload_state",
            f"media upload cannot transition from {upload.status} to {target}",
        )
    upload.status = target


def _invalid_state(status: str) -> MediaUploadError:
    if status == "expired":
        return _error(409, "upload_expired", "media upload session has expired")
    return _error(409, "invalid_upload_state", "media upload is not writable")


def _is_expired(upload: MediaUploadSession) -> bool:
    if upload.status == "expired":
        return False
    expires_at = upload.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at <= utc_now()


def _error(status_code: int, code: str, message: str) -> MediaUploadError:
    return MediaUploadError(status_code, code, message)


async def _serialize_sqlite_write(database: AsyncSession) -> None:
    if database.get_bind().dialect.name == "sqlite":
        await database.rollback()
        await database.execute(text("BEGIN IMMEDIATE"))


async def _restart_write_transaction(database: AsyncSession) -> None:
    await database.rollback()
    if database.get_bind().dialect.name == "sqlite":
        await database.execute(text("BEGIN IMMEDIATE"))
