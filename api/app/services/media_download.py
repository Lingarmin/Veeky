from __future__ import annotations

import asyncio
import ipaddress
import logging
import os
import secrets
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urljoin

import httpx

from app.services.media_security import Resolver, validate_x_media_url


logger = logging.getLogger(__name__)
PINNED_IP_EXTENSION = "veeky_pinned_ip"
MEDIA_DOWNLOAD_JOB_PREFIX = ".media-download-"


class MediaDownloadError(RuntimeError):
    """Raised when an allowed media resource cannot be downloaded."""


class MediaDownloadTimeout(MediaDownloadError):
    """Raised when a media download exceeds its request timeout."""


class MediaTooLarge(MediaDownloadError):
    """Raised when a media resource exceeds the configured byte limit."""


class PinnedMediaTransport(httpx.AsyncBaseTransport):
    def __init__(
        self,
        *,
        inner_transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._inner_transport = inner_transport or httpx.AsyncHTTPTransport(
            trust_env=False
        )

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        raw_address = request.extensions.get(PINNED_IP_EXTENSION)
        if not isinstance(raw_address, str):
            raise MediaDownloadError("media request has no validated address")
        try:
            address = ipaddress.ip_address(raw_address)
        except ValueError:
            raise MediaDownloadError("media request address is invalid") from None
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
            address = address.ipv4_mapped
        if not address.is_global or address.is_multicast:
            raise MediaDownloadError("media request address is not allowed")
        if request.url.scheme != "https" or request.url.host != "video.twimg.com":
            raise MediaDownloadError("media request host is not allowed")

        headers = request.headers.copy()
        headers["Host"] = request.url.netloc.decode("ascii")
        extensions = dict(request.extensions)
        extensions.pop(PINNED_IP_EXTENSION, None)
        extensions["sni_hostname"] = request.url.host
        pinned_request = httpx.Request(
            method=request.method,
            url=request.url.copy_with(host=address.compressed),
            headers=headers,
            stream=request.stream,
            extensions=extensions,
        )
        return await self._inner_transport.handle_async_request(pinned_request)

    async def aclose(self) -> None:
        await self._inner_transport.aclose()


def build_media_http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=PinnedMediaTransport(),
        trust_env=False,
        follow_redirects=False,
    )


class MediaDownloader:
    _REDIRECT_STATUSES = {301, 302, 303, 307, 308}

    def __init__(
        self,
        *,
        client: httpx.AsyncClient | None = None,
        max_bytes: int,
        timeout_seconds: float = 1800,
        max_redirects: int = 5,
        resolver: Resolver | None = None,
        clock: Callable[[], float] = time.monotonic,
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
        self._clock = clock

    async def download(self, url: str, destination: str | Path) -> Path:
        deadline = self._clock() + self._timeout_seconds
        destination_path = Path(destination)
        parent_fd = self._open_destination_directory(destination_path)
        parent_identity = self._directory_identity(parent_fd)
        job_name: str | None = None
        job_fd: int | None = None
        try:
            self._ensure_destination_absent(parent_fd, destination_path.name)
            job_name, job_fd = self._create_job_directory(parent_fd)
            try:
                async with asyncio.timeout(self._remaining_seconds(deadline)):
                    async with self._client_for_download() as client:
                        await self._stream_to_file(
                            client,
                            url,
                            job_fd,
                            deadline,
                        )
                    self._remaining_seconds(deadline)
                    self._commit_without_overwrite(
                        job_fd,
                        parent_fd,
                        destination_path,
                        parent_identity,
                    )
            except TimeoutError:
                raise MediaDownloadTimeout("media download timed out") from None
            return destination_path
        finally:
            self._cleanup_job_directory(parent_fd, job_fd, job_name)
            try:
                os.close(parent_fd)
            except OSError:
                logger.warning("media download temporary directory cleanup failed")

    @staticmethod
    def _open_destination_directory(destination: Path) -> int:
        parent = destination.parent
        if not destination.name:
            raise MediaDownloadError("destination path is not safe")
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        try:
            return os.open(parent, flags)
        except OSError:
            raise MediaDownloadError("destination directory is not safe") from None

    @staticmethod
    def _directory_identity(directory_fd: int) -> tuple[int, int]:
        details = os.fstat(directory_fd)
        return details.st_dev, details.st_ino

    @staticmethod
    def _ensure_destination_absent(parent_fd: int, name: str) -> None:
        try:
            os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            return
        except OSError:
            raise MediaDownloadError("destination path is not safe") from None
        else:
            raise MediaDownloadError("destination already exists")

    @staticmethod
    def _create_job_directory(parent_fd: int) -> tuple[str, int]:
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        for _attempt in range(10):
            job_name = f"{MEDIA_DOWNLOAD_JOB_PREFIX}{secrets.token_hex(16)}"
            try:
                os.mkdir(job_name, mode=0o700, dir_fd=parent_fd)
            except FileExistsError:
                continue
            except OSError:
                raise MediaDownloadError(
                    "could not create media download directory"
                ) from None
            try:
                return job_name, os.open(job_name, flags, dir_fd=parent_fd)
            except OSError:
                try:
                    os.rmdir(job_name, dir_fd=parent_fd)
                except OSError:
                    logger.warning(
                        "media download temporary directory cleanup failed"
                    )
                raise MediaDownloadError(
                    "could not open media download directory"
                ) from None
        raise MediaDownloadError("could not create media download directory")

    @asynccontextmanager
    async def _client_for_download(self) -> AsyncIterator[httpx.AsyncClient]:
        if self._client is not None:
            yield self._client
            return
        async with build_media_http_client() as client:
            yield client

    def _remaining_seconds(self, deadline: float) -> float:
        remaining = deadline - self._clock()
        if remaining <= 0:
            raise MediaDownloadTimeout("media download timed out")
        return remaining

    async def _stream_to_file(
        self,
        client: httpx.AsyncClient,
        url: str,
        job_fd: int,
        deadline: float,
    ) -> None:
        current_url = url
        redirects = 0
        try:
            while True:
                async with asyncio.timeout(self._remaining_seconds(deadline)):
                    addresses = await validate_x_media_url(
                        current_url,
                        resolver=self._resolver,
                    )
                self._remaining_seconds(deadline)
                pinned_address = min(
                    addresses,
                    key=lambda address: (address.version, int(address)),
                )
                async with client.stream(
                    "GET",
                    current_url,
                    headers={"Accept-Encoding": "identity"},
                    follow_redirects=False,
                    timeout=self._remaining_seconds(deadline),
                    extensions={PINNED_IP_EXTENSION: pinned_address.compressed},
                ) as response:
                    self._remaining_seconds(deadline)
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
                    self._validate_content_encoding(response)
                    self._validate_content_length(response)
                    await self._write_bounded(response, job_fd, deadline)
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

    @staticmethod
    def _validate_content_encoding(response: httpx.Response) -> None:
        encoding = response.headers.get("Content-Encoding", "identity")
        if encoding.strip().lower() != "identity":
            raise MediaDownloadError("media response encoding is not supported")

    async def _write_bounded(
        self,
        response: httpx.Response,
        job_fd: int,
        deadline: float,
    ) -> None:
        bytes_written = 0
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
        try:
            self._remaining_seconds(deadline)
            output_fd = os.open(
                "payload.partial",
                flags,
                0o600,
                dir_fd=job_fd,
            )
            with os.fdopen(output_fd, "wb") as output:
                async for chunk in response.aiter_raw():
                    self._remaining_seconds(deadline)
                    bytes_written += len(chunk)
                    if bytes_written > self._max_bytes:
                        raise MediaTooLarge(
                            "media exceeds the configured byte limit"
                        )
                    output.write(chunk)
        except OSError as error:
            raise MediaDownloadError("could not write media download") from error

    @staticmethod
    def _parent_path_matches(
        destination_parent: Path,
        expected_identity: tuple[int, int],
    ) -> bool:
        try:
            details = os.stat(destination_parent, follow_symlinks=False)
        except OSError:
            return False
        return (details.st_dev, details.st_ino) == expected_identity

    def _commit_without_overwrite(
        self,
        job_fd: int,
        parent_fd: int,
        destination: Path,
        parent_identity: tuple[int, int],
    ) -> None:
        try:
            os.link(
                "payload.partial",
                destination.name,
                src_dir_fd=job_fd,
                dst_dir_fd=parent_fd,
                follow_symlinks=False,
            )
        except FileExistsError:
            raise MediaDownloadError("destination already exists") from None
        except OSError:
            raise MediaDownloadError("could not finalize media download") from None

        if self._parent_path_matches(destination.parent, parent_identity):
            return
        try:
            os.unlink(destination.name, dir_fd=parent_fd)
        except OSError:
            logger.warning("media download temporary directory cleanup failed")
        raise MediaDownloadError("destination directory changed")

    @staticmethod
    def _cleanup_job_directory(
        parent_fd: int,
        job_fd: int | None,
        job_name: str | None,
    ) -> None:
        cleanup_failed = False
        if job_fd is not None:
            try:
                os.unlink("payload.partial", dir_fd=job_fd)
            except FileNotFoundError:
                pass
            except OSError:
                cleanup_failed = True
            try:
                os.close(job_fd)
            except OSError:
                cleanup_failed = True
        if job_name is not None:
            try:
                os.rmdir(job_name, dir_fd=parent_fd)
            except OSError:
                cleanup_failed = True
        if cleanup_failed:
            logger.warning("media download temporary directory cleanup failed")
