from __future__ import annotations

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

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.db.models import MediaUploadSession, Video


MEDIA_SESSION_STATES = {
    "created",
    "uploading",
    "complete",
    "consumed",
    "expired",
    "failed",
}
MAX_PART_COUNT = 100_000


class MediaUploadError(Exception):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


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
        uploaded_parts={},
        directory_key=str(uuid.uuid4()),
        created_at=now,
        updated_at=now,
        expires_at=now + timedelta(seconds=settings.media_upload_session_ttl_seconds),
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
    reconcile: bool = True,
) -> MediaUploadSession:
    upload = await database.scalar(
        select(MediaUploadSession).where(
            MediaUploadSession.id == session_id,
            MediaUploadSession.installation_id == installation_id,
        )
    )
    if upload is None:
        raise _error(404, "media_session_not_found", "media session was not found")
    if _is_expired(upload):
        await _expire(database, settings, upload)
        return upload
    if reconcile and upload.status in {"created", "uploading"}:
        await _reconcile(database, settings, upload)
    return upload


async def store_part(
    database: AsyncSession,
    settings: Settings,
    upload: MediaUploadSession,
    part_number: int,
    checksum: str,
    chunks: AsyncIterator[bytes],
) -> None:
    if upload.status == "expired":
        raise _error(409, "upload_expired", "media upload session has expired")
    if upload.status not in {"created", "uploading"}:
        raise _error(409, "invalid_upload_state", "media upload is not writable")
    if part_number < 0 or part_number >= upload.part_count:
        raise _error(422, "invalid_part_number", "part number is outside the declaration")
    expected_size = _expected_part_size(upload, part_number)
    directory = _session_directory(settings, upload)
    directory.mkdir(parents=True, exist_ok=True)
    temporary = directory / f".upload-{uuid.uuid4()}.tmp"
    digest = hashlib.sha256()
    size = 0
    try:
        with temporary.open("xb") as destination:
            async for chunk in chunks:
                size += len(chunk)
                if size > expected_size:
                    raise _error(
                        422, "invalid_part_size", "part body has the wrong size"
                    )
                digest.update(chunk)
                destination.write(chunk)
            destination.flush()
            os.fsync(destination.fileno())
        if size != expected_size:
            raise _error(422, "invalid_part_size", "part body has the wrong size")
        actual_checksum = digest.hexdigest()
        if actual_checksum != checksum.lower():
            raise _error(422, "checksum_mismatch", "part checksum does not match")

        final_path = _part_path(directory, part_number)
        try:
            os.link(temporary, final_path)
        except FileExistsError:
            existing_size, existing_checksum = _file_identity(final_path)
            if existing_size != size or existing_checksum != actual_checksum:
                raise _error(
                    409,
                    "part_conflict",
                    "part number already contains different bytes",
                )
        finally:
            temporary.unlink(missing_ok=True)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise

    await _reconcile(database, settings, upload)


async def complete_upload(
    database: AsyncSession,
    settings: Settings,
    upload: MediaUploadSession,
    part_count: int,
    total_bytes: int,
    manifest: dict[str, Any] | None,
) -> MediaArtifact:
    if upload.status == "expired":
        raise _error(409, "upload_expired", "media upload session has expired")
    if upload.status == "consumed":
        raise _error(409, "upload_consumed", "media upload has already been consumed")
    if upload.status == "failed":
        raise _error(409, "upload_failed", "media upload session has failed")
    if part_count != upload.part_count or total_bytes != upload.expected_bytes:
        raise _error(
            422,
            "completion_declaration_mismatch",
            "completion does not match the upload declaration",
        )

    directory = _session_directory(settings, upload)
    if upload.status == "complete":
        artifact_path = _artifact_path(directory, upload.media_kind)
        if not artifact_path.is_file():
            upload.status = "failed"
            upload.updated_at = utc_now()
            await database.commit()
            raise _error(409, "upload_failed", "completed media artifact is missing")
        return _artifact(upload, artifact_path)

    await _reconcile(database, settings, upload)
    if (
        upload.received_bytes != upload.expected_bytes
        or _uploaded_part_numbers(upload) != list(range(upload.part_count))
    ):
        raise _error(409, "upload_incomplete", "not all declared parts are present")

    if upload.media_kind == "mp4":
        if manifest is not None:
            raise _error(422, "unexpected_manifest", "MP4 uploads do not use a manifest")
        artifact_path = await _assemble_mp4(directory, upload)
    else:
        canonical_manifest = _validate_hls_manifest(manifest, upload.part_count)
        artifact_path = directory / "manifest.json"
        _atomic_write(
            artifact_path,
            json.dumps(canonical_manifest, separators=(",", ":")).encode("utf-8"),
        )
        upload.hls_manifest = canonical_manifest

    upload.status = "complete"
    upload.updated_at = utc_now()
    await database.commit()
    return _artifact(upload, artifact_path)


async def delete_upload(
    database: AsyncSession,
    settings: Settings,
    upload: MediaUploadSession,
) -> None:
    _remove_session_directory(settings, upload)
    upload.status = "expired"
    upload.received_bytes = 0
    upload.uploaded_parts = {}
    upload.hls_manifest = None
    upload.updated_at = utc_now()
    upload.expires_at = upload.updated_at
    await database.commit()


async def _reconcile(
    database: AsyncSession,
    settings: Settings,
    upload: MediaUploadSession,
) -> None:
    directory = _session_directory(settings, upload)
    parts: dict[str, dict[str, int | str]] = {}
    received_bytes = 0
    for part_number in range(upload.part_count):
        path = _part_path(directory, part_number)
        stored = upload.uploaded_parts.get(str(part_number))
        if not path.is_file():
            if stored is not None:
                await _fail_integrity(database, upload)
            continue
        size, checksum = _file_identity(path)
        if size != _expected_part_size(upload, part_number):
            if stored is not None:
                await _fail_integrity(database, upload)
            path.unlink(missing_ok=True)
            continue
        if stored is not None and (
            stored.get("size") != size or stored.get("sha256") != checksum
        ):
            await _fail_integrity(database, upload)
        parts[str(part_number)] = {"size": size, "sha256": checksum}
        received_bytes += size
    next_status = "uploading" if parts else "created"
    if (
        upload.uploaded_parts != parts
        or upload.received_bytes != received_bytes
        or upload.status != next_status
    ):
        upload.uploaded_parts = parts
        upload.received_bytes = received_bytes
        upload.status = next_status
        upload.updated_at = utc_now()
        await database.commit()


async def _fail_integrity(
    database: AsyncSession, upload: MediaUploadSession
) -> None:
    upload.status = "failed"
    upload.updated_at = utc_now()
    await database.commit()
    raise _error(
        409,
        "part_integrity_failed",
        "a verified media part is missing or has changed",
    )


async def _expire(
    database: AsyncSession,
    settings: Settings,
    upload: MediaUploadSession,
) -> None:
    _remove_session_directory(settings, upload)
    upload.status = "expired"
    upload.received_bytes = 0
    upload.uploaded_parts = {}
    upload.updated_at = utc_now()
    await database.commit()


async def _assemble_mp4(directory: Path, upload: MediaUploadSession) -> Path:
    artifact_path = directory / "media.mp4"
    temporary = directory / f".assemble-{uuid.uuid4()}.tmp"
    try:
        with temporary.open("xb") as destination:
            for part_number in range(upload.part_count):
                source_path = _part_path(directory, part_number)
                with source_path.open("rb") as source:
                    shutil.copyfileobj(source, destination, length=1024 * 1024)
            destination.flush()
            os.fsync(destination.fileno())
        if temporary.stat().st_size != upload.expected_bytes:
            raise _error(409, "upload_incomplete", "assembled media size is incorrect")
        os.replace(temporary, artifact_path)
    finally:
        temporary.unlink(missing_ok=True)
    return artifact_path


def _validate_hls_manifest(
    manifest: dict[str, Any] | None, part_count: int
) -> dict[str, list[int]]:
    if not isinstance(manifest, dict) or set(manifest) != {"parts"}:
        raise _error(422, "invalid_hls_manifest", "HLS manifest must contain parts")
    parts = manifest["parts"]
    if (
        not isinstance(parts, list)
        or any(type(part) is not int for part in parts)
        or parts != list(range(part_count))
    ):
        raise _error(
            422,
            "invalid_hls_manifest",
            "HLS manifest parts must be all uploaded numeric part IDs in order",
        )
    return {"parts": parts}


def _atomic_write(path: Path, body: bytes) -> None:
    temporary = path.parent / f".write-{uuid.uuid4()}.tmp"
    try:
        with temporary.open("xb") as destination:
            destination.write(body)
            destination.flush()
            os.fsync(destination.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


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


def _remove_session_directory(settings: Settings, upload: MediaUploadSession) -> None:
    directory = _session_directory(settings, upload)
    if directory.exists():
        shutil.rmtree(directory)


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


def _uploaded_part_numbers(upload: MediaUploadSession) -> list[int]:
    return sorted(int(part_number) for part_number in upload.uploaded_parts)


def _is_expired(upload: MediaUploadSession) -> bool:
    if upload.status == "expired":
        return False
    expires_at = upload.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at <= utc_now()


def _error(status_code: int, code: str, message: str) -> MediaUploadError:
    return MediaUploadError(status_code, code, message)
