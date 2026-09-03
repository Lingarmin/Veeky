from __future__ import annotations

import asyncio
import gzip
import ipaddress
import inspect
import logging
import os
import shutil
import ssl
from collections.abc import Iterable
from pathlib import Path

import httpcore
import httpx
import pytest

import app.services.media_download as media_download_module
from app.services.media_download import (
    MediaDownloadError,
    MediaDownloader,
    MediaDownloadTimeout,
    MediaTooLarge,
)
from app.services.media_security import UnsafeMediaUrl, validate_x_media_url


PUBLIC_IPV4 = "8.8.8.8"


def resolver_returning(*addresses: str):
    async def resolve(_hostname: str) -> Iterable[str]:
        return addresses

    return resolve


def streaming_response(content: bytes) -> httpx.Response:
    class Stream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield content

    return httpx.Response(200, stream=Stream())


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url",
    [
        "http://video.twimg.com/file.mp4",
        "https://video.twimg.com:444/file.mp4",
        "https://user@video.twimg.com/file.mp4",
        "https://user:password@video.twimg.com/file.mp4",
        "https://example.com/file.mp4",
        "https://video.twimg.com/file.mp4#fragment",
    ],
)
async def test_x_media_url_rejects_invalid_url_shapes(url: str):
    with pytest.raises(UnsafeMediaUrl):
        await validate_x_media_url(url, resolver=resolver_returning(PUBLIC_IPV4))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url",
    [
        "https://video.twimg.com/file.mp4",
        "https://video.twimg.com:443/path/file.mp4?tag=1",
        "https://VIDEO.TWIMG.COM/file.mp4",
    ],
)
async def test_x_media_url_accepts_the_exact_https_host(url: str):
    addresses = await validate_x_media_url(
        url,
        resolver=resolver_returning(PUBLIC_IPV4),
    )

    assert addresses == (ipaddress.ip_address(PUBLIC_IPV4),)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "10.0.0.1",
        "169.254.1.1",
        "224.0.0.1",
        "240.0.0.1",
        "0.0.0.0",
        "100.64.0.1",
        "::1",
        "fc00::1",
        "fe80::1",
        "ff02::1",
        "2001:db8::1",
        "::",
        "::ffff:10.0.0.1",
        "::ffff:100.64.0.1",
    ],
)
async def test_x_media_url_rejects_non_public_dns_addresses(address: str):
    with pytest.raises(UnsafeMediaUrl):
        await validate_x_media_url(
            "https://video.twimg.com/file.mp4",
            resolver=resolver_returning(address),
        )


@pytest.mark.asyncio
async def test_x_media_url_rejects_mixed_public_and_private_dns_answers():
    with pytest.raises(UnsafeMediaUrl):
        await validate_x_media_url(
            "https://video.twimg.com/file.mp4",
            resolver=resolver_returning(PUBLIC_IPV4, "127.0.0.1"),
        )


@pytest.mark.asyncio
async def test_x_media_url_normalizes_a_global_ipv4_mapped_address():
    addresses = await validate_x_media_url(
        "https://video.twimg.com/file.mp4",
        resolver=resolver_returning("::ffff:8.8.8.8"),
    )

    assert addresses == (ipaddress.ip_address("8.8.8.8"),)


@pytest.mark.asyncio
async def test_x_media_url_preserves_resolver_order_and_removes_duplicates():
    addresses = await validate_x_media_url(
        "https://video.twimg.com/file.mp4",
        resolver=resolver_returning(
            "2606:4700:4700::1111",
            PUBLIC_IPV4,
            "2606:4700:4700::1111",
        ),
    )

    assert addresses == (
        ipaddress.ip_address("2606:4700:4700::1111"),
        ipaddress.ip_address(PUBLIC_IPV4),
    )


@pytest.mark.asyncio
async def test_x_media_url_rejects_empty_or_invalid_dns_answers():
    with pytest.raises(UnsafeMediaUrl):
        await validate_x_media_url(
            "https://video.twimg.com/file.mp4",
            resolver=resolver_returning(),
        )
    with pytest.raises(UnsafeMediaUrl):
        await validate_x_media_url(
            "https://video.twimg.com/file.mp4",
            resolver=resolver_returning("not-an-ip"),
        )


def assert_no_download_artifacts(directory: Path) -> None:
    assert list(directory.iterdir()) == []


@pytest.mark.asyncio
async def test_pinned_transport_rewrites_authority_but_keeps_host_and_sni():
    observed: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        observed["host"] = request.url.host
        observed["host_header"] = request.headers["Host"]
        observed["sni_hostname"] = request.extensions["sni_hostname"]
        return httpx.Response(200, content=b"ok")

    transport = media_download_module.PinnedMediaTransport(
        inner_transport=httpx.MockTransport(handler)
    )
    async with httpx.AsyncClient(transport=transport, trust_env=False) as client:
        response = await client.get(
            "https://video.twimg.com/file.mp4?token=secret",
            extensions={media_download_module.PINNED_IP_EXTENSION: PUBLIC_IPV4},
        )

    assert response.url.host == "video.twimg.com"
    assert observed == {
        "host": PUBLIC_IPV4,
        "host_header": "video.twimg.com",
        "sni_hostname": "video.twimg.com",
    }


@pytest.mark.asyncio
async def test_default_media_client_does_not_trust_environment_proxies():
    client = media_download_module.build_media_http_client()
    try:
        assert client.trust_env is False
    finally:
        await client.aclose()


def test_downloader_can_use_its_secure_production_client():
    MediaDownloader(max_bytes=16)


def test_downloader_does_not_accept_a_prebuilt_http_client():
    assert "client" not in inspect.signature(MediaDownloader).parameters


@pytest.mark.asyncio
async def test_downloader_tries_validated_ipv4_then_ipv6_addresses(tmp_path: Path):
    attempted_hosts: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        attempted_hosts.append(request.url.host)
        if request.url.host == PUBLIC_IPV4:
            raise httpx.ConnectError("unreachable", request=request)
        return streaming_response(b"media")

    destination = tmp_path / "media.mp4"
    await MediaDownloader(
        inner_transport=httpx.MockTransport(handler),
        max_bytes=16,
        resolver=resolver_returning(PUBLIC_IPV4, "2606:4700:4700::1111"),
    ).download("https://video.twimg.com/file.mp4", destination)

    assert attempted_hosts == [PUBLIC_IPV4, "2606:4700:4700::1111"]
    assert destination.read_bytes() == b"media"


@pytest.mark.asyncio
async def test_downloader_tries_multiple_ipv6_addresses_in_resolver_order(
    tmp_path: Path,
):
    attempted_hosts: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        attempted_hosts.append(request.url.host)
        if len(attempted_hosts) == 1:
            raise httpx.ConnectTimeout("unreachable", request=request)
        return streaming_response(b"media")

    destination = tmp_path / "media.mp4"
    await MediaDownloader(
        inner_transport=httpx.MockTransport(handler),
        max_bytes=16,
        resolver=resolver_returning(
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
        ),
    ).download("https://video.twimg.com/file.mp4", destination)

    assert attempted_hosts == [
        "2606:4700:4700::1111",
        "2001:4860:4860::8888",
    ]
    assert destination.read_bytes() == b"media"


@pytest.mark.asyncio
async def test_downloader_does_not_try_another_address_after_http_response(
    tmp_path: Path,
):
    attempted_hosts: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        attempted_hosts.append(request.url.host)
        return httpx.Response(403)

    with pytest.raises(MediaDownloadError, match="403"):
        await MediaDownloader(
            inner_transport=httpx.MockTransport(handler),
            max_bytes=16,
            resolver=resolver_returning(PUBLIC_IPV4, "1.1.1.1"),
        ).download(
            "https://video.twimg.com/file.mp4",
            tmp_path / "media.mp4",
        )

    assert attempted_hosts == [PUBLIC_IPV4]


@pytest.mark.asyncio
async def test_downloader_does_not_retry_connect_error_after_response_headers(
    tmp_path: Path,
):
    attempted_hosts: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        attempted_hosts.append(request.url.host)

        class FailingResponseStream(httpx.AsyncByteStream):
            async def __aiter__(self):
                raise httpx.ConnectError("stream failed", request=request)
                yield b""

        return httpx.Response(200, stream=FailingResponseStream())

    with pytest.raises(MediaDownloadError, match="request failed"):
        await MediaDownloader(
            inner_transport=httpx.MockTransport(handler),
            max_bytes=16,
            resolver=resolver_returning(PUBLIC_IPV4, "1.1.1.1"),
        ).download(
            "https://video.twimg.com/file.mp4",
            tmp_path / "media.mp4",
        )

    assert attempted_hosts == [PUBLIC_IPV4]


@pytest.mark.asyncio
async def test_downloader_bounds_each_address_connect_timeout(tmp_path: Path):
    request_timeouts: list[dict[str, float | None]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        request_timeouts.append(request.extensions["timeout"])
        return streaming_response(b"media")

    await MediaDownloader(
        inner_transport=httpx.MockTransport(handler),
        max_bytes=16,
        timeout_seconds=1800,
        resolver=resolver_returning(PUBLIC_IPV4),
    ).download(
        "https://video.twimg.com/file.mp4",
        tmp_path / "media.mp4",
    )

    assert request_timeouts[0]["connect"] < request_timeouts[0]["read"]


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["success", "forbidden", "redirect"])
async def test_httpx_media_logs_redact_signed_queries_without_changing_requests(
    tmp_path: Path,
    caplog,
    outcome: str,
):
    requested_urls: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requested_urls.append(str(request.url))
        if outcome == "forbidden":
            return httpx.Response(403)
        if outcome == "redirect" and len(requested_urls) == 1:
            return httpx.Response(
                302,
                headers={"Location": "/final.mp4?token=redirect-secret"},
            )
        return streaming_response(b"media")

    downloader = MediaDownloader(
        inner_transport=httpx.MockTransport(handler),
        max_bytes=16,
        resolver=resolver_returning(PUBLIC_IPV4),
    )
    with caplog.at_level(logging.INFO, logger="httpx"):
        if outcome == "forbidden":
            with pytest.raises(MediaDownloadError, match="403"):
                await downloader.download(
                    "https://video.twimg.com/file.mp4?token=initial-secret",
                    tmp_path / "media.mp4",
                )
        else:
            await downloader.download(
                "https://video.twimg.com/file.mp4?token=initial-secret",
                tmp_path / "media.mp4",
            )

    assert "initial-secret" in requested_urls[0]
    if outcome == "redirect":
        assert "redirect-secret" in requested_urls[1]
    messages = [record.getMessage() for record in caplog.records]
    assert messages
    assert all("initial-secret" not in message for message in messages)
    assert all("redirect-secret" not in message for message in messages)


@pytest.mark.asyncio
async def test_httpx_media_log_filter_leaves_non_media_urls_unchanged(caplog):
    media_client = media_download_module.build_media_http_client()
    await media_client.aclose()

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200)

    with caplog.at_level(logging.INFO, logger="httpx"):
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            trust_env=False,
        ) as client:
            await client.get("https://example.com/file?token=visible")

    assert any("token=visible" in record.getMessage() for record in caplog.records)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("logger_name", "media_return_value", "non_media_return_value"),
    [
        (
            "httpcore.http11",
            (
                b"HTTP/1.1",
                302,
                b"Found",
                [
                    (b"Location", b"/final.mp4?token=http11-secret#part"),
                    (b"X-Debug", b"keep?token=visible"),
                ],
            ),
            (
                b"HTTP/1.1",
                302,
                b"Found",
                [(b"Location", b"/other.mp4?token=http11-non-media")],
            ),
        ),
        (
            "httpcore.http2",
            (
                302,
                [
                    (b"location", b"/final.mp4?token=http2-secret#part"),
                    (b"x-debug", b"keep?token=visible"),
                ],
            ),
            (
                302,
                [(b"location", b"/other.mp4?token=http2-non-media")],
            ),
        ),
    ],
)
async def test_httpcore_media_filter_is_isolated_between_concurrent_tasks(
    tmp_path: Path,
    caplog,
    logger_name: str,
    media_return_value: tuple,
    non_media_return_value: tuple,
):
    media_request_started = asyncio.Event()
    non_media_log_written = asyncio.Event()

    async def handler(_request: httpx.Request) -> httpx.Response:
        media_request_started.set()
        await non_media_log_written.wait()
        logging.getLogger(logger_name).debug(
            "receive_response_headers.complete "
            f"return_value={media_return_value!r}"
        )
        return streaming_response(b"media")

    async def log_non_media_response() -> None:
        await media_request_started.wait()
        logging.getLogger(logger_name).debug(
            "receive_response_headers.complete "
            f"return_value={non_media_return_value!r}"
        )
        non_media_log_written.set()

    with caplog.at_level(logging.DEBUG, logger=logger_name):
        await asyncio.gather(
            MediaDownloader(
                inner_transport=httpx.MockTransport(handler),
                max_bytes=16,
                resolver=resolver_returning(PUBLIC_IPV4),
            ).download(
                "https://video.twimg.com/file.mp4",
                tmp_path / "media.mp4",
            ),
            log_non_media_response(),
        )

    messages = [record.getMessage() for record in caplog.records]
    assert messages
    assert all("http11-secret" not in message for message in messages)
    assert all("http2-secret" not in message for message in messages)
    assert any("http11-non-media" in message for message in messages) or any(
        "http2-non-media" in message for message in messages
    )
    assert any("keep?token=visible" in message for message in messages)


@pytest.mark.asyncio
async def test_httpcore_media_context_is_restored_after_request_error(
    tmp_path: Path,
    caplog,
):
    logger_name = "httpcore.http11"
    media_return_value = (
        b"HTTP/1.1",
        302,
        b"Found",
        [(b"Location", b"/media.mp4?token=media-secret")],
    )
    later_return_value = (
        b"HTTP/1.1",
        302,
        b"Found",
        [(b"Location", b"/later.mp4?token=after-error")],
    )

    async def handler(request: httpx.Request) -> httpx.Response:
        logging.getLogger(logger_name).debug(
            "receive_response_headers.complete "
            f"return_value={media_return_value!r}"
        )
        raise httpx.ConnectError("connection failed", request=request)

    with caplog.at_level(logging.DEBUG, logger=logger_name):
        with pytest.raises(MediaDownloadError, match="request failed"):
            await MediaDownloader(
                inner_transport=httpx.MockTransport(handler),
                max_bytes=16,
                resolver=resolver_returning(PUBLIC_IPV4),
            ).download(
                "https://video.twimg.com/file.mp4",
                tmp_path / "media.mp4",
            )
        logging.getLogger(logger_name).debug(
            "receive_response_headers.complete "
            f"return_value={later_return_value!r}"
        )

    messages = [record.getMessage() for record in caplog.records]
    assert all("media-secret" not in message for message in messages)
    assert any("after-error" in message for message in messages)


@pytest.mark.asyncio
async def test_httpcore_media_context_is_restored_after_request_cancellation(
    tmp_path: Path,
    caplog,
):
    logger_name = "httpcore.http11"
    request_cancelled = False
    media_return_value = (
        b"HTTP/1.1",
        302,
        b"Found",
        [(b"Location", b"/media.mp4?token=media-secret")],
    )
    later_return_value = (
        b"HTTP/1.1",
        302,
        b"Found",
        [(b"Location", b"/later.mp4?token=after-cancel")],
    )

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal request_cancelled
        logging.getLogger(logger_name).debug(
            "receive_response_headers.complete "
            f"return_value={media_return_value!r}"
        )
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            request_cancelled = True
            raise
        raise AssertionError("unreachable")

    with caplog.at_level(logging.DEBUG, logger=logger_name):
        with pytest.raises(MediaDownloadTimeout):
            await MediaDownloader(
                inner_transport=httpx.MockTransport(handler),
                max_bytes=16,
                timeout_seconds=0.01,
                resolver=resolver_returning(PUBLIC_IPV4),
            ).download(
                "https://video.twimg.com/file.mp4",
                tmp_path / "media.mp4",
            )
        logging.getLogger(logger_name).debug(
            "receive_response_headers.complete "
            f"return_value={later_return_value!r}"
        )

    messages = [record.getMessage() for record in caplog.records]
    assert request_cancelled is True
    assert all("media-secret" not in message for message in messages)
    assert any("after-cancel" in message for message in messages)


@pytest.mark.asyncio
async def test_httpcore_filter_does_not_change_other_loggers(caplog):
    media_client = media_download_module.build_media_http_client()
    await media_client.aclose()
    return_value = (
        b"HTTP/1.1",
        302,
        b"Found",
        [(b"Location", b"/final.mp4?token=visible")],
    )

    with caplog.at_level(logging.DEBUG, logger="httpcore.connection"):
        logging.getLogger("httpcore.connection").debug(
            f"receive_response_headers.complete return_value={return_value!r}"
        )

    assert any("token=visible" in record.getMessage() for record in caplog.records)


@pytest.mark.asyncio
async def test_media_log_filters_are_installed_once():
    first_client = media_download_module.build_media_http_client()
    second_client = media_download_module.build_media_http_client()
    await first_client.aclose()
    await second_client.aclose()

    for logger_name in ("httpx", "httpcore.http11", "httpcore.http2"):
        installed_filters = [
            log_filter
            for log_filter in logging.getLogger(logger_name).filters
            if getattr(log_filter, "_media_url_filter", False)
        ]
        assert len(installed_filters) == 1


def test_media_download_job_prefix_is_available_to_periodic_cleanup():
    assert media_download_module.MEDIA_DOWNLOAD_JOB_PREFIX == ".media-download-"


@pytest.mark.asyncio
async def test_httpcore_connects_to_pinned_authority_and_verifies_original_tls_name():
    class RecordingStream(httpcore.AsyncNetworkStream):
        def __init__(self) -> None:
            self.reads = 0
            self.writes: list[bytes] = []
            self.tls_hostname: str | None = None
            self.check_hostname: bool | None = None

        async def read(self, max_bytes: int, timeout: float | None = None) -> bytes:
            self.reads += 1
            if self.reads == 1:
                return b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"
            return b""

        async def write(self, buffer: bytes, timeout: float | None = None) -> None:
            self.writes.append(buffer)

        async def aclose(self) -> None:
            return None

        async def start_tls(
            self,
            ssl_context: ssl.SSLContext,
            server_hostname: str | None = None,
            timeout: float | None = None,
        ) -> httpcore.AsyncNetworkStream:
            self.tls_hostname = server_hostname
            self.check_hostname = ssl_context.check_hostname
            return self

        def get_extra_info(self, info: str):
            return None

    class RecordingBackend(httpcore.AsyncNetworkBackend):
        def __init__(self) -> None:
            self.connected_host: str | None = None
            self.stream = RecordingStream()

        async def connect_tcp(
            self,
            host: str,
            port: int,
            timeout: float | None = None,
            local_address: str | None = None,
            socket_options=None,
        ) -> httpcore.AsyncNetworkStream:
            self.connected_host = host
            return self.stream

        async def connect_unix_socket(self, *args, **kwargs):
            raise AssertionError("Unix sockets are not allowed")

        async def sleep(self, seconds: float) -> None:
            return None

    backend = RecordingBackend()
    inner_transport = httpx.AsyncHTTPTransport(
        verify=ssl.create_default_context(),
        trust_env=False,
    )
    inner_transport._pool._network_backend = backend
    transport = media_download_module.PinnedMediaTransport(
        inner_transport=inner_transport
    )
    async with httpx.AsyncClient(transport=transport, trust_env=False) as client:
        async with client.stream(
            "GET",
            "https://video.twimg.com/file.mp4",
            extensions={
                media_download_module.PINNED_IP_EXTENSION: PUBLIC_IPV4
            },
        ) as response:
            await response.aread()
            assert response.url.host == "video.twimg.com"

    assert backend.connected_host == PUBLIC_IPV4
    assert backend.stream.tls_hostname == "video.twimg.com"
    assert backend.stream.check_hostname is True
    assert b"Host: video.twimg.com\r\n" in b"".join(backend.stream.writes)


@pytest.mark.asyncio
async def test_httpcore_redirect_logs_are_redacted_without_changing_redirect(
    tmp_path: Path,
    caplog,
):
    class ScriptedStream(httpcore.AsyncNetworkStream):
        def __init__(self, response: bytes) -> None:
            self.response = response
            self.response_sent = False
            self.writes: list[bytes] = []

        async def read(self, max_bytes: int, timeout: float | None = None) -> bytes:
            if self.response_sent:
                return b""
            self.response_sent = True
            return self.response

        async def write(self, buffer: bytes, timeout: float | None = None) -> None:
            self.writes.append(buffer)

        async def aclose(self) -> None:
            return None

        async def start_tls(
            self,
            ssl_context: ssl.SSLContext,
            server_hostname: str | None = None,
            timeout: float | None = None,
        ) -> httpcore.AsyncNetworkStream:
            return self

        def get_extra_info(self, info: str):
            return None

    class ScriptedBackend(httpcore.AsyncNetworkBackend):
        def __init__(self) -> None:
            self.responses = [
                (
                    b"HTTP/1.1 302 Found\r\n"
                    b"Location: /final.mp4?token=redirect-secret\r\n"
                    b"Content-Length: 0\r\n"
                    b"Connection: close\r\n\r\n"
                ),
                (
                    b"HTTP/1.1 200 OK\r\n"
                    b"Content-Length: 5\r\n"
                    b"Connection: close\r\n\r\n"
                    b"media"
                ),
            ]
            self.streams: list[ScriptedStream] = []

        async def connect_tcp(
            self,
            host: str,
            port: int,
            timeout: float | None = None,
            local_address: str | None = None,
            socket_options=None,
        ) -> httpcore.AsyncNetworkStream:
            stream = ScriptedStream(self.responses.pop(0))
            self.streams.append(stream)
            return stream

        async def connect_unix_socket(self, *args, **kwargs):
            raise AssertionError("Unix sockets are not allowed")

        async def sleep(self, seconds: float) -> None:
            return None

    backend = ScriptedBackend()
    inner_transport = httpx.AsyncHTTPTransport(
        verify=ssl.create_default_context(),
        trust_env=False,
    )
    inner_transport._pool._network_backend = backend
    destination = tmp_path / "media.mp4"

    with caplog.at_level(logging.DEBUG, logger="httpcore.http11"):
        await MediaDownloader(
            inner_transport=inner_transport,
            max_bytes=16,
            resolver=resolver_returning(PUBLIC_IPV4),
        ).download(
            "https://video.twimg.com/start.mp4",
            destination,
        )

    requests = b"".join(
        write for stream in backend.streams for write in stream.writes
    )
    assert b"GET /final.mp4?token=redirect-secret HTTP/1.1" in requests
    assert destination.read_bytes() == b"media"
    messages = [record.getMessage() for record in caplog.records]
    assert any("receive_response_headers.complete" in message for message in messages)
    assert all("redirect-secret" not in message for message in messages)


@pytest.mark.asyncio
async def test_downloader_pins_each_redirect_to_its_validated_ip(tmp_path: Path):
    resolver_calls = 0
    connected_hosts: list[str] = []
    tls_names: list[str] = []

    async def resolver(_hostname: str) -> list[str]:
        nonlocal resolver_calls
        resolver_calls += 1
        return [PUBLIC_IPV4] if resolver_calls == 1 else ["1.1.1.1"]

    async def handler(request: httpx.Request) -> httpx.Response:
        connected_hosts.append(request.url.host)
        tls_names.append(request.extensions["sni_hostname"])
        if len(connected_hosts) == 1:
            return httpx.Response(302, headers={"Location": "/final.mp4"})
        return streaming_response(b"media")

    destination = tmp_path / "media.mp4"
    await MediaDownloader(
        inner_transport=httpx.MockTransport(handler),
        max_bytes=16,
        resolver=resolver,
    ).download("https://video.twimg.com/start.mp4", destination)

    assert resolver_calls == 2
    assert connected_hosts == [PUBLIC_IPV4, "1.1.1.1"]
    assert tls_names == ["video.twimg.com", "video.twimg.com"]
    assert destination.read_bytes() == b"media"


@pytest.mark.asyncio
async def test_downloader_revalidates_a_redirect_before_requesting_it(tmp_path: Path):
    requested_hosts: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requested_hosts.append(request.url.host)
        return httpx.Response(
            302,
            headers={"Location": "https://example.com/private.mp4"},
        )

    downloader = MediaDownloader(
        inner_transport=httpx.MockTransport(handler),
        max_bytes=16,
        resolver=resolver_returning(PUBLIC_IPV4),
    )

    with pytest.raises(UnsafeMediaUrl):
        await downloader.download(
            "https://video.twimg.com/start.mp4",
            tmp_path / "media.mp4",
        )

    assert requested_hosts == [PUBLIC_IPV4]
    assert_no_download_artifacts(tmp_path)


@pytest.mark.asyncio
async def test_downloader_re_resolves_the_host_after_every_redirect(tmp_path: Path):
    resolved = 0
    requests = 0

    async def changing_resolver(hostname: str) -> list[str]:
        nonlocal resolved
        assert hostname == "video.twimg.com"
        resolved += 1
        return [PUBLIC_IPV4] if resolved == 1 else ["127.0.0.1"]

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        return httpx.Response(
            302,
            headers={"Location": "https://video.twimg.com/final.mp4"},
        )

    downloader = MediaDownloader(
        inner_transport=httpx.MockTransport(handler),
        max_bytes=16,
        resolver=changing_resolver,
    )

    with pytest.raises(UnsafeMediaUrl):
        await downloader.download(
            "https://video.twimg.com/start.mp4",
            tmp_path / "media.mp4",
        )

    assert resolved == 2
    assert requests == 1
    assert_no_download_artifacts(tmp_path)


@pytest.mark.asyncio
async def test_downloader_streams_to_an_atomic_destination(tmp_path: Path):
    calls = 0

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(
                302,
                headers={"Location": "/final.mp4"},
            )
        return streaming_response(b"sixteen-byte-mp4")

    destination = tmp_path / "media.mp4"
    result = await MediaDownloader(
        inner_transport=httpx.MockTransport(handler),
        max_bytes=16,
        resolver=resolver_returning(PUBLIC_IPV4),
    ).download("https://video.twimg.com/start.mp4", destination)

    assert result == destination
    assert destination.read_bytes() == b"sixteen-byte-mp4"
    assert list(tmp_path.iterdir()) == [destination]
    assert calls == 2


@pytest.mark.asyncio
async def test_downloader_stops_and_removes_partial_file_over_limit(tmp_path: Path):
    class TrackingStream(httpx.AsyncByteStream):
        def __init__(self) -> None:
            self.chunks_read = 0

        async def __aiter__(self):
            for chunk in (b"12345678", b"901234567", b"must-not-be-read"):
                self.chunks_read += 1
                yield chunk

    stream = TrackingStream()

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream)

    with pytest.raises(MediaTooLarge):
        await MediaDownloader(
            inner_transport=httpx.MockTransport(handler),
            max_bytes=16,
            resolver=resolver_returning(PUBLIC_IPV4),
        ).download(
            "https://video.twimg.com/file.mp4",
            tmp_path / "media.mp4",
        )

    assert_no_download_artifacts(tmp_path)
    assert stream.chunks_read == 2


@pytest.mark.asyncio
async def test_downloader_rejects_oversized_content_length_before_streaming(
    tmp_path: Path,
):
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"Content-Length": "17"},
            content=b"",
        )

    with pytest.raises(MediaTooLarge):
        await MediaDownloader(
            inner_transport=httpx.MockTransport(handler),
            max_bytes=16,
            resolver=resolver_returning(PUBLIC_IPV4),
        ).download(
            "https://video.twimg.com/file.mp4",
            tmp_path / "media.mp4",
        )

    assert_no_download_artifacts(tmp_path)


@pytest.mark.asyncio
async def test_downloader_rejects_compressed_media_and_requests_identity(
    tmp_path: Path,
):
    accept_encodings: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        accept_encodings.append(request.headers["Accept-Encoding"])
        return httpx.Response(
            200,
            headers={"Content-Encoding": "gzip"},
            content=gzip.compress(b"small body"),
        )

    with pytest.raises(MediaDownloadError, match="encoding"):
        await MediaDownloader(
            inner_transport=httpx.MockTransport(handler),
            max_bytes=1024,
            resolver=resolver_returning(PUBLIC_IPV4),
        ).download(
            "https://video.twimg.com/file.mp4",
            tmp_path / "media.mp4",
        )

    assert accept_encodings == ["identity"]
    assert_no_download_artifacts(tmp_path)


@pytest.mark.asyncio
async def test_downloader_maps_timeout_without_exposing_query(tmp_path: Path):
    async def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timeout", request=request)

    with pytest.raises(MediaDownloadTimeout) as error:
        await MediaDownloader(
            inner_transport=httpx.MockTransport(handler),
            max_bytes=16,
            timeout_seconds=1,
            resolver=resolver_returning(PUBLIC_IPV4),
        ).download(
            "https://video.twimg.com/file.mp4?token=secret",
            tmp_path / "media.mp4",
        )

    assert "secret" not in str(error.value)
    assert error.value.__cause__ is None
    assert_no_download_artifacts(tmp_path)


@pytest.mark.asyncio
async def test_downloader_deadline_includes_dns_resolution(tmp_path: Path):
    async def resolver_that_never_returns(_hostname: str) -> list[str]:
        await asyncio.Event().wait()
        return [PUBLIC_IPV4]

    with pytest.raises(MediaDownloadTimeout) as error:
        await asyncio.wait_for(
            MediaDownloader(
                inner_transport=httpx.MockTransport(
                    lambda _request: httpx.Response(200)
                ),
                max_bytes=16,
                timeout_seconds=0.01,
                resolver=resolver_that_never_returns,
            ).download(
                "https://video.twimg.com/file.mp4?token=secret",
                tmp_path / "media.mp4",
            ),
            timeout=0.2,
        )

    assert "secret" not in str(error.value)
    assert error.value.__cause__ is None
    assert_no_download_artifacts(tmp_path)


@pytest.mark.asyncio
async def test_downloader_uses_one_deadline_across_redirects_and_streaming(
    tmp_path: Path,
):
    class FakeClock:
        def __init__(self) -> None:
            self.now = 0.0

        def __call__(self) -> float:
            return self.now

        def advance(self, seconds: float) -> None:
            self.now += seconds

    class AdvancingStream(httpx.AsyncByteStream):
        def __init__(self, clock: FakeClock) -> None:
            self.clock = clock
            self.chunks_read = 0

        async def __aiter__(self):
            for chunk in (b"first", b"second", b"must-not-be-read"):
                self.clock.advance(2)
                self.chunks_read += 1
                yield chunk

    clock = FakeClock()
    stream = AdvancingStream(clock)
    request_timeouts: list[float] = []
    requests = 0

    async def resolver(_hostname: str) -> list[str]:
        clock.advance(2)
        return [PUBLIC_IPV4]

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        request_timeouts.append(request.extensions["timeout"]["read"])
        if requests == 1:
            clock.advance(3)
            return httpx.Response(302, headers={"Location": "/final.mp4"})
        return httpx.Response(200, stream=stream)

    with pytest.raises(MediaDownloadTimeout):
        await MediaDownloader(
            inner_transport=httpx.MockTransport(handler),
            max_bytes=64,
            timeout_seconds=10,
            resolver=resolver,
            clock=clock,
        ).download(
            "https://video.twimg.com/file.mp4",
            tmp_path / "media.mp4",
        )

    assert request_timeouts == pytest.approx([8, 3])
    assert stream.chunks_read == 2
    assert_no_download_artifacts(tmp_path)


@pytest.mark.asyncio
async def test_downloader_maps_http_error_without_exposing_query(tmp_path: Path):
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, text="request token=secret was rejected")

    with pytest.raises(MediaDownloadError) as error:
        await MediaDownloader(
            inner_transport=httpx.MockTransport(handler),
            max_bytes=16,
            resolver=resolver_returning(PUBLIC_IPV4),
        ).download(
            "https://video.twimg.com/file.mp4?token=secret",
            tmp_path / "media.mp4",
        )

    assert "secret" not in str(error.value)
    assert "403" in str(error.value)
    assert error.value.__cause__ is None
    assert_no_download_artifacts(tmp_path)


@pytest.mark.asyncio
async def test_downloader_enforces_redirect_limit(tmp_path: Path):
    calls = 0

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            302,
            headers={"Location": f"/redirect-{calls}.mp4"},
        )

    with pytest.raises(MediaDownloadError, match="redirect limit"):
        await MediaDownloader(
            inner_transport=httpx.MockTransport(handler),
            max_bytes=16,
            max_redirects=2,
            resolver=resolver_returning(PUBLIC_IPV4),
        ).download(
            "https://video.twimg.com/file.mp4",
            tmp_path / "media.mp4",
        )

    assert calls == 3
    assert_no_download_artifacts(tmp_path)


@pytest.mark.asyncio
async def test_downloader_refuses_an_existing_destination(tmp_path: Path):
    destination = tmp_path / "media.mp4"
    destination.write_bytes(b"keep-me")
    requests = 0

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        return httpx.Response(200, content=b"replacement")

    with pytest.raises(MediaDownloadError, match="destination already exists"):
        await MediaDownloader(
            inner_transport=httpx.MockTransport(handler),
            max_bytes=16,
            resolver=resolver_returning(PUBLIC_IPV4),
        ).download(
            "https://video.twimg.com/file.mp4",
            destination,
        )

    assert destination.read_bytes() == b"keep-me"
    assert requests == 0


@pytest.mark.asyncio
async def test_downloader_does_not_overwrite_a_destination_created_at_commit(
    tmp_path: Path,
    monkeypatch,
):
    destination = tmp_path / "media.mp4"
    real_link = os.link

    def racing_link(source, target, *args, **kwargs):
        destination.write_bytes(b"racer")
        return real_link(source, target, *args, **kwargs)

    monkeypatch.setattr(media_download_module.os, "link", racing_link)

    async def handler(_request: httpx.Request) -> httpx.Response:
        return streaming_response(b"download")

    with pytest.raises(MediaDownloadError, match="destination already exists"):
        await MediaDownloader(
            inner_transport=httpx.MockTransport(handler),
            max_bytes=16,
            resolver=resolver_returning(PUBLIC_IPV4),
        ).download(
            "https://video.twimg.com/file.mp4",
            destination,
        )

    assert destination.read_bytes() == b"racer"
    assert list(tmp_path.iterdir()) == [destination]


@pytest.mark.asyncio
async def test_downloader_does_not_follow_a_parent_directory_symlink_swap(
    tmp_path: Path,
    monkeypatch,
):
    trusted_directory = tmp_path / "trusted"
    trusted_directory.mkdir()
    moved_trusted_directory = tmp_path / "trusted-original"
    attacker_directory = tmp_path / "attacker"
    attacker_directory.mkdir()
    destination = trusted_directory / "media.mp4"
    real_link = os.link

    def swapping_link(source, target, *args, **kwargs):
        trusted_directory.rename(moved_trusted_directory)
        trusted_directory.symlink_to(attacker_directory, target_is_directory=True)
        return real_link(source, target, *args, **kwargs)

    monkeypatch.setattr(media_download_module.os, "link", swapping_link)

    async def handler(_request: httpx.Request) -> httpx.Response:
        return streaming_response(b"download")

    with pytest.raises(MediaDownloadError, match="destination directory changed"):
        await MediaDownloader(
            inner_transport=httpx.MockTransport(handler),
            max_bytes=16,
            resolver=resolver_returning(PUBLIC_IPV4),
        ).download(
            "https://video.twimg.com/file.mp4",
            destination,
        )

    assert list(attacker_directory.iterdir()) == []
    assert list(moved_trusted_directory.iterdir()) == []


@pytest.mark.asyncio
async def test_downloader_rejects_a_symlinked_destination_directory(tmp_path: Path):
    real_directory = tmp_path / "real"
    real_directory.mkdir()
    linked_directory = tmp_path / "linked"
    linked_directory.symlink_to(real_directory, target_is_directory=True)

    with pytest.raises(MediaDownloadError, match="destination directory"):
        await MediaDownloader(
            inner_transport=httpx.MockTransport(
                lambda _request: httpx.Response(200)
            ),
            max_bytes=16,
            resolver=resolver_returning(PUBLIC_IPV4),
        ).download(
            "https://video.twimg.com/file.mp4",
            linked_directory / "media.mp4",
        )

    assert list(real_directory.iterdir()) == []


@pytest.mark.asyncio
async def test_downloader_logs_generic_cleanup_failure_for_later_recovery(
    tmp_path: Path,
    monkeypatch,
    caplog,
):
    real_rmdir = os.rmdir

    def failing_job_rmdir(path, *args, **kwargs):
        if str(path).startswith(
            media_download_module.MEDIA_DOWNLOAD_JOB_PREFIX
        ) or Path(path).name.startswith(
            media_download_module.MEDIA_DOWNLOAD_JOB_PREFIX
        ):
            raise OSError("cleanup path contains token=secret")
        return real_rmdir(path, *args, **kwargs)

    monkeypatch.setattr(media_download_module.os, "rmdir", failing_job_rmdir)

    async def handler(_request: httpx.Request) -> httpx.Response:
        return streaming_response(b"media")

    destination = tmp_path / "media.mp4"
    with caplog.at_level(logging.WARNING, logger="app.services.media_download"):
        await MediaDownloader(
            inner_transport=httpx.MockTransport(handler),
            max_bytes=16,
            resolver=resolver_returning(PUBLIC_IPV4),
        ).download(
            "https://video.twimg.com/file.mp4?token=secret",
            destination,
        )

    messages = [record.getMessage() for record in caplog.records]
    assert messages == ["media download temporary directory cleanup failed"]
    assert all("secret" not in message for message in messages)
    recovery_directories = [
        path
        for path in tmp_path.iterdir()
        if path.name.startswith(media_download_module.MEDIA_DOWNLOAD_JOB_PREFIX)
    ]
    assert len(recovery_directories) == 1

    monkeypatch.setattr(media_download_module.os, "rmdir", real_rmdir)
    shutil.rmtree(recovery_directories[0])
