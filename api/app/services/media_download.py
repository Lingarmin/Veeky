from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path
from urllib.parse import urljoin

import httpx

from app.services.media_security import Resolver, validate_x_media_url


class MediaDownloadError(RuntimeError):
    """Raised when an allowed media resource cannot be downloaded."""


class MediaDownloadTimeout(MediaDownloadError):
    """Raised when a media download exceeds its request timeout."""


class MediaTooLarge(MediaDownloadError):
    """Raised when a media resource exceeds the configured byte limit."""


class MediaDownloader:
    _REDIRECT_STATUSES = {301, 302, 303, 307, 308}

    def __init__(
        self,
        *,
        client: httpx.AsyncClient,
        max_bytes: int,
        timeout_seconds: float = 1800,
        max_redirects: int = 5,
        resolver: Resolver | None = None,
    ) -> None:
        if max_bytes <= 0:
            raise ValueError("max_bytes must be positive")
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        if max_redirects < 0:
            raise ValueError("max_redirects cannot be negative")
        self._client = client
        self._max_bytes = max_bytes
        self._timeout_seconds = timeout_seconds
        self._max_redirects = max_redirects
        self._resolver = resolver

    async def download(self, url: str, destination: str | Path) -> Path:
        destination_path = Path(destination)
        self._validate_destination(destination_path)

        try:
            job_directory = Path(
                tempfile.mkdtemp(
                    prefix=".media-download-",
                    dir=destination_path.parent,
                )
            )
        except OSError as error:
            raise MediaDownloadError("could not create media download directory") from error

        partial_path = job_directory / "payload.partial"
        try:
            await self._stream_to_file(url, partial_path)
            if os.path.lexists(destination_path):
                raise MediaDownloadError("destination already exists")
            try:
                os.replace(partial_path, destination_path)
            except OSError as error:
                raise MediaDownloadError("could not finalize media download") from error
            return destination_path
        finally:
            shutil.rmtree(job_directory, ignore_errors=True)

    @staticmethod
    def _validate_destination(destination: Path) -> None:
        parent = destination.parent
        if not parent.exists() or not parent.is_dir() or parent.is_symlink():
            raise MediaDownloadError("destination directory is not safe")
        if os.path.lexists(destination):
            raise MediaDownloadError("destination already exists")

    async def _stream_to_file(self, url: str, partial_path: Path) -> None:
        current_url = url
        redirects = 0
        try:
            while True:
                await validate_x_media_url(current_url, resolver=self._resolver)
                async with self._client.stream(
                    "GET",
                    current_url,
                    follow_redirects=False,
                    timeout=self._timeout_seconds,
                ) as response:
                    if response.status_code in self._REDIRECT_STATUSES:
                        if redirects >= self._max_redirects:
                            raise MediaDownloadError("media redirect limit exceeded")
                        location = response.headers.get("Location")
                        if not location:
                            raise MediaDownloadError("media redirect had no location")
                        current_url = urljoin(str(response.url), location)
                        redirects += 1
                        continue

                    response.raise_for_status()
                    self._validate_content_length(response)
                    await self._write_bounded(response, partial_path)
                    return
        except httpx.TimeoutException:
            raise MediaDownloadTimeout("media download timed out") from None
        except httpx.HTTPStatusError as error:
            raise MediaDownloadError(
                f"media download failed with status {error.response.status_code}"
            ) from None
        except httpx.RequestError:
            raise MediaDownloadError("media download request failed") from None

    def _validate_content_length(self, response: httpx.Response) -> None:
        raw_length = response.headers.get("Content-Length")
        if raw_length is None:
            return
        try:
            content_length = int(raw_length)
        except ValueError:
            return
        if content_length > self._max_bytes:
            raise MediaTooLarge("media exceeds the configured byte limit")

    async def _write_bounded(
        self,
        response: httpx.Response,
        partial_path: Path,
    ) -> None:
        bytes_written = 0
        try:
            with partial_path.open("xb") as output:
                async for chunk in response.aiter_bytes():
                    bytes_written += len(chunk)
                    if bytes_written > self._max_bytes:
                        raise MediaTooLarge(
                            "media exceeds the configured byte limit"
                        )
                    output.write(chunk)
        except OSError as error:
            raise MediaDownloadError("could not write media download") from error
