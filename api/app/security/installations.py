from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import hmac
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Installation
from app.db.session import get_session


router = APIRouter(prefix="/v1/installations", tags=["installations"])
_bearer_scheme = HTTPBearer(auto_error=False)


class RegistrationRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    installation_id: str = Field(alias="installationId")
    installation_token: str = Field(
        alias="installationToken", min_length=43, max_length=500
    )

    @field_validator("installation_id")
    @classmethod
    def validate_installation_id(cls, value: str) -> str:
        try:
            parsed = uuid.UUID(value)
        except ValueError as error:
            raise ValueError("installationId must be a UUID") from error
        if str(parsed) != value:
            raise ValueError("installationId must be a canonical UUID")
        return str(parsed)


class RegistrationResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    installation_id: str = Field(alias="installationId")


def hash_installation_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _authentication_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={
            "code": "installation_auth_required",
            "message": "需要有效的插件安装身份",
        },
    )


@router.post("/register", response_model=RegistrationResponse)
async def register_installation(
    request: RegistrationRequest,
    response: Response,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> RegistrationResponse:
    token_hash = hash_installation_token(request.installation_token)
    installation = await session.get(Installation, request.installation_id)
    if installation is not None:
        if not hmac.compare_digest(installation.token_hash, token_hash):
            raise _authentication_error()
        installation.last_seen_at = datetime.now(timezone.utc)
        await session.commit()
        return RegistrationResponse(installation_id=installation.id)

    installation = Installation(id=request.installation_id, token_hash=token_hash)
    session.add(installation)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        existing = await session.get(Installation, request.installation_id)
        if existing is None or not hmac.compare_digest(existing.token_hash, token_hash):
            raise _authentication_error()
        existing.last_seen_at = datetime.now(timezone.utc)
        await session.commit()
        return RegistrationResponse(installation_id=existing.id)

    response.status_code = status.HTTP_201_CREATED
    return RegistrationResponse(installation_id=installation.id)


async def require_installation(
    session: Annotated[AsyncSession, Depends(get_session)],
    credentials: Annotated[
        HTTPAuthorizationCredentials | None, Depends(_bearer_scheme)
    ],
    installation_id: Annotated[
        str | None, Header(alias="X-Veeky-Installation-Id")
    ] = None,
) -> Installation:
    if credentials is None or not installation_id:
        raise _authentication_error()
    try:
        parsed_id = uuid.UUID(installation_id)
    except ValueError as error:
        raise _authentication_error() from error
    canonical_id = str(parsed_id)
    if canonical_id != installation_id:
        raise _authentication_error()

    installation = await session.get(Installation, canonical_id)
    if installation is None or not hmac.compare_digest(
        installation.token_hash, hash_installation_token(credentials.credentials)
    ):
        raise _authentication_error()
    installation.last_seen_at = datetime.now(timezone.utc)
    await session.commit()
    return installation
