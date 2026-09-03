from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from pydantic import Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.analyses import ApiModel
from app.core.settings import Settings, get_settings
from app.db.models import Installation, MediaUploadSession
from app.db.session import get_session
from app.security.installations import require_installation
from app.services.media_upload import (
    MediaArtifact,
    MediaUploadError,
    complete_upload,
    create_upload_session,
    delete_upload,
    get_owned_upload,
    store_part,
)


router = APIRouter(prefix="/v1/media-sessions", tags=["media"])
_SHA256_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")


class MediaSessionCreateRequest(ApiModel):
    content_id: str
    kind: Literal["mp4", "hls"]
    expected_bytes: int = Field(strict=True)
    part_count: int = Field(strict=True)


class MediaSessionResponse(ApiModel):
    session_id: str
    content_id: str
    kind: Literal["mp4", "hls"]
    status: str
    expected_bytes: int
    received_bytes: int
    part_size_bytes: int
    part_count: int
    uploaded_parts: list[int]
    created_at: datetime
    updated_at: datetime
    expires_at: datetime


class MediaSessionCreateResponse(MediaSessionResponse):
    pass


class MediaSessionCompleteRequest(ApiModel):
    part_count: int = Field(strict=True)
    total_bytes: int = Field(strict=True)
    manifest: dict[str, Any] | None = None


class MediaArtifactResponse(ApiModel):
    session_id: str
    content_id: str
    kind: Literal["mp4", "hls"]
    status: Literal["complete"] = "complete"
    total_bytes: int
    part_count: int


@router.post("", response_model=MediaSessionCreateResponse, status_code=201)
async def create_media_session(
    request: MediaSessionCreateRequest,
    database: AsyncSession = Depends(get_session),
    installation: Installation = Depends(require_installation),
    settings: Settings = Depends(get_settings),
) -> MediaSessionCreateResponse:
    try:
        upload = await create_upload_session(
            database,
            settings,
            installation.id,
            request.content_id,
            request.kind,
            request.expected_bytes,
            request.part_count,
        )
    except MediaUploadError as error:
        raise _http_error(error) from error
    return _session_response(upload)


@router.get("/{session_id}", response_model=MediaSessionResponse)
async def get_media_session(
    session_id: str,
    database: AsyncSession = Depends(get_session),
    installation: Installation = Depends(require_installation),
    settings: Settings = Depends(get_settings),
) -> MediaSessionResponse:
    try:
        upload = await get_owned_upload(
            database, settings, session_id, installation.id
        )
    except MediaUploadError as error:
        raise _http_error(error) from error
    return _session_response(upload)


@router.put("/{session_id}/parts/{part_number}", status_code=204)
async def upload_media_part(
    session_id: str,
    part_number: int,
    request: Request,
    database: AsyncSession = Depends(get_session),
    installation: Installation = Depends(require_installation),
    settings: Settings = Depends(get_settings),
    content_sha256: str | None = Header(default=None, alias="X-Content-SHA256"),
) -> Response:
    try:
        upload = await get_owned_upload(
            database, settings, session_id, installation.id
        )
    except MediaUploadError as error:
        raise _http_error(error) from error
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != (
        "application/octet-stream"
    ):
        raise HTTPException(
            status_code=415,
            detail={
                "code": "unsupported_media_type",
                "message": "part body must use application/octet-stream",
            },
        )
    if content_sha256 is None or not _SHA256_PATTERN.fullmatch(content_sha256):
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_checksum", "message": "checksum must be SHA-256"},
        )
    try:
        await store_part(
            database,
            settings,
            upload,
            part_number,
            content_sha256,
            request.stream(),
        )
    except MediaUploadError as error:
        raise _http_error(error) from error
    return Response(status_code=204)


@router.post("/{session_id}/complete", response_model=MediaArtifactResponse)
async def complete_media_session(
    session_id: str,
    request: MediaSessionCompleteRequest,
    database: AsyncSession = Depends(get_session),
    installation: Installation = Depends(require_installation),
    settings: Settings = Depends(get_settings),
) -> MediaArtifactResponse:
    try:
        upload = await get_owned_upload(
            database, settings, session_id, installation.id
        )
        artifact = await complete_upload(
            database,
            settings,
            upload,
            request.part_count,
            request.total_bytes,
            request.manifest,
        )
    except MediaUploadError as error:
        raise _http_error(error) from error
    return _artifact_response(artifact)


@router.delete("/{session_id}", status_code=204)
async def delete_media_session(
    session_id: str,
    database: AsyncSession = Depends(get_session),
    installation: Installation = Depends(require_installation),
    settings: Settings = Depends(get_settings),
) -> Response:
    try:
        upload = await get_owned_upload(
            database, settings, session_id, installation.id, reconcile=False
        )
        await delete_upload(database, settings, upload)
    except MediaUploadError as error:
        raise _http_error(error) from error
    return Response(status_code=204)


def _session_response(upload: MediaUploadSession) -> MediaSessionCreateResponse:
    return MediaSessionCreateResponse(
        session_id=upload.id,
        content_id=upload.content_id,
        kind=upload.media_kind,
        status=upload.status,
        expected_bytes=upload.expected_bytes,
        received_bytes=upload.received_bytes,
        part_size_bytes=upload.part_size_bytes,
        part_count=upload.part_count,
        uploaded_parts=sorted(int(value) for value in upload.uploaded_parts),
        created_at=upload.created_at,
        updated_at=upload.updated_at,
        expires_at=upload.expires_at,
    )


def _artifact_response(artifact: MediaArtifact) -> MediaArtifactResponse:
    return MediaArtifactResponse(
        session_id=artifact.session_id,
        content_id=artifact.content_id,
        kind=artifact.kind,
        total_bytes=artifact.total_bytes,
        part_count=artifact.part_count,
    )


def _http_error(error: MediaUploadError) -> HTTPException:
    return HTTPException(
        status_code=error.status_code,
        detail={"code": error.code, "message": error.message},
    )
