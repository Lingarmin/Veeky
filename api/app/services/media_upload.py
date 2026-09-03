from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.settings import Settings
from app.db.models import Installation, MediaUploadPart, MediaUploadSession, Video


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


class MediaUploadError(Exception):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


class PartIntegrityError(RuntimeError):
    pass


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
    await database.scalar(
        select(Installation.id)
        .where(Installation.id == installation_id)
        .with_for_update()
    )
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
        raise _error(
            429,
            "media_session_limit",
            "installation already has the maximum active media uploads",
        )
    if reserved_bytes + expected_bytes > settings.max_media_bytes:
        raise _error(
            429,
            "media_reservation_limit",
            "installation has reserved the maximum media bytes",
        )
    content_exists = await database.scalar(
        select(Video.content_id).where(Video.content_id == content_id)
    )
    if content_exists is None:
        raise _error(404, "content_not_found", "content was not found")

    now = utc_now()
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
    _require_writable(upload)
    upload_id = upload.id
    installation_id = upload.installation_id
    if part_number < 0 or part_number >= upload.part_count:
        raise _error(422, "invalid_part_number", "part number is outside the declaration")
    expected_size = _expected_part_size(upload, part_number)
    directory = _session_directory(settings, upload)
    temporary = directory / f".upload-{uuid.uuid4()}.tmp"
    final_path = _part_path(directory, part_number)

    try:
        size, actual_checksum = await _write_temporary_part(
            directory, temporary, chunks, expected_size
        )
    except MediaUploadError:
        raise
    except OSError as error:
        raise _error(503, "storage_unavailable", "media storage is unavailable") from error
    if actual_checksum != checksum.lower():
        await asyncio.to_thread(_unlink_if_exists_sync, temporary)
        raise _error(422, "checksum_mismatch", "part checksum does not match")
    try:
        created_file = await asyncio.to_thread(
            _publish_part_sync,
            temporary,
            final_path,
            size,
            actual_checksum,
        )
    except PartIntegrityError as error:
        raise _error(409, "part_conflict", str(error)) from error
    except OSError as error:
        raise _error(503, "storage_unavailable", "media storage is unavailable") from error

    await database.rollback()
    locked = await _lock_owned(database, upload_id, installation_id)
    if locked is None:
        if created_file:
            await asyncio.to_thread(_unlink_and_fsync_sync, final_path)
        raise _error(404, "media_session_not_found", "media session was not found")
    if _is_expired(locked):
        await _expire_locked(database, settings, locked)
        raise _error(409, "upload_expired", "media upload session has expired")
    if locked.status not in {"created", "uploading"}:
        if created_file:
            await asyncio.to_thread(_unlink_and_fsync_sync, final_path)
        raise _invalid_state(locked.status)

    existing = next(
        (part for part in locked.parts if part.part_number == part_number), None
    )
    if existing is not None:
        if existing.byte_size != size or existing.sha256 != actual_checksum:
            _transition(locked, "failed")
            await database.commit()
            raise _error(
                409,
                "part_integrity_failed",
                "published part does not match its stored metadata",
            )
        await database.commit()
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
        raise _error(409, "upload_failed", "received media exceeds its declaration")
    if locked.status == "created":
        _transition(locked, "uploading")
    locked.updated_at = utc_now()
    await database.commit()


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
    await database.rollback()
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
        if not await asyncio.to_thread(artifact_path.is_file):
            _transition(locked, "failed")
            await database.commit()
            raise _error(409, "upload_failed", "completed media artifact is missing")
        if locked.media_kind == "mp4":
            try:
                await asyncio.to_thread(
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
            artifact_path = await asyncio.to_thread(
                _assemble_mp4_sync, directory, locked.expected_bytes, locked.parts
            )
        else:
            canonical_manifest = _validate_hls_manifest(manifest, locked.part_count)
            await asyncio.to_thread(_verify_parts_sync, directory, locked.parts)
            artifact_path = directory / "manifest.json"
            await asyncio.to_thread(
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
        await database.rollback()
        raise _error(503, "storage_unavailable", "media storage is unavailable") from error

    _transition(locked, "complete")
    locked.updated_at = utc_now()
    await database.commit()
    if locked.media_kind == "mp4":
        try:
            await asyncio.to_thread(_remove_part_files_sync, directory, locked.parts)
        except OSError as error:
            raise _error(
                503, "storage_unavailable", "media storage is unavailable"
            ) from error
    return _artifact(locked, artifact_path)


async def delete_upload(
    database: AsyncSession,
    settings: Settings,
    upload: MediaUploadSession,
) -> None:
    upload_id = upload.id
    installation_id = upload.installation_id
    await database.rollback()
    locked = await _lock_owned(database, upload_id, installation_id)
    if locked is None:
        raise _error(404, "media_session_not_found", "media session was not found")
    await _expire_locked(database, settings, locked)


async def cleanup_expired_uploads(
    database: AsyncSession,
    settings: Settings,
    *,
    limit: int = 100,
) -> int:
    bounded_limit = max(1, min(limit, 1000))
    session_ids = list(
        await database.scalars(
            select(MediaUploadSession.id)
            .where(
                MediaUploadSession.expires_at <= utc_now(),
                MediaUploadSession.status != "expired",
            )
            .order_by(MediaUploadSession.expires_at, MediaUploadSession.id)
            .limit(bounded_limit)
        )
    )
    await database.rollback()
    cleaned = 0
    for session_id in session_ids:
        upload = await database.scalar(
            select(MediaUploadSession)
            .options(selectinload(MediaUploadSession.parts))
            .where(MediaUploadSession.id == session_id)
            .with_for_update()
        )
        if upload is not None and _is_expired(upload):
            await _expire_locked(database, settings, upload)
            cleaned += 1
        else:
            await database.rollback()
    return cleaned


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
    try:
        await asyncio.to_thread(_remove_session_directory_sync, settings, upload)
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
    await database.commit()


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
    temporary = directory / f".assemble-{uuid.uuid4()}.tmp"
    total_bytes = 0
    try:
        with temporary.open("xb") as destination:
            for part in parts:
                source_path = _part_path(directory, part.part_number)
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
                    raise PartIntegrityError("a verified media part is missing or changed")
                total_bytes += part_size
            destination.flush()
            os.fsync(destination.fileno())
        if total_bytes != expected_bytes:
            raise PartIntegrityError("assembled media size is incorrect")
        os.replace(temporary, artifact_path)
        _fsync_directory_sync(directory)
    finally:
        temporary.unlink(missing_ok=True)
    return artifact_path


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
        try:
            os.link(temporary, final_path)
            created = True
        except FileExistsError:
            existing_size, existing_checksum = _file_identity(final_path)
            if existing_size != size or existing_checksum != checksum:
                raise PartIntegrityError(
                    "part number already contains different bytes"
                )
        temporary.unlink(missing_ok=True)
        if created:
            _fsync_directory_sync(final_path.parent)
        return created
    except BaseException:
        temporary.unlink(missing_ok=True)
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
    removed = False
    for part in parts:
        path = _part_path(directory, part.part_number)
        if path.exists():
            path.unlink()
            removed = True
    if removed and directory.exists():
        _fsync_directory_sync(directory)


def _remove_session_directory_sync(
    settings: Settings, upload: MediaUploadSession
) -> None:
    directory = _session_directory(settings, upload)
    root = directory.parent
    if directory.exists():
        shutil.rmtree(directory)
        _fsync_directory_sync(root)


def _ensure_directory_sync(directory: Path) -> None:
    existed = directory.exists()
    directory.mkdir(parents=True, exist_ok=True)
    if not existed:
        _fsync_directory_sync(directory.parent)


def _unlink_and_fsync_sync(path: Path) -> None:
    if path.exists():
        path.unlink()
        _fsync_directory_sync(path.parent)


def _fsync_directory_sync(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


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


def _require_writable(upload: MediaUploadSession) -> None:
    if upload.status == "expired" or _is_expired(upload):
        raise _error(409, "upload_expired", "media upload session has expired")
    if upload.status not in {"created", "uploading"}:
        raise _invalid_state(upload.status)


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
