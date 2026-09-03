from __future__ import annotations

import asyncio
import gzip
import ipaddress
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

    assert addresses == frozenset({ipaddress.ip_address(PUBLIC_IPV4)})


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

    assert addresses == frozenset({ipaddress.ip_address("8.8.8.8")})


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

    transport = media_download_module.PinnedMediaTransport(
        inner_transport=httpx.MockTransport(handler)
    )
    destination = tmp_path / "media.mp4"
    async with httpx.AsyncClient(transport=transport, trust_env=False) as client:
        await MediaDownloader(
            client=client,
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

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        downloader = MediaDownloader(
            client=client,
            max_bytes=16,
            resolver=resolver_returning(PUBLIC_IPV4),
        )

        with pytest.raises(UnsafeMediaUrl):
            await downloader.download(
                "https://video.twimg.com/start.mp4",
                tmp_path / "media.mp4",
            )

    assert requested_hosts == ["video.twimg.com"]
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

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        downloader = MediaDownloader(
            client=client,
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
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await MediaDownloader(
            client=client,
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

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(MediaTooLarge):
            await MediaDownloader(
                client=client,
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

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(MediaTooLarge):
            await MediaDownloader(
                client=client,
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

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(MediaDownloadError, match="encoding"):
            await MediaDownloader(
                client=client,
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

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(MediaDownloadTimeout) as error:
            await MediaDownloader(
                client=client,
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

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _request: httpx.Response(200))
    ) as client:
        with pytest.raises(MediaDownloadTimeout) as error:
            await asyncio.wait_for(
                MediaDownloader(
                    client=client,
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

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(MediaDownloadTimeout):
            await MediaDownloader(
                client=client,
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

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(MediaDownloadError) as error:
            await MediaDownloader(
                client=client,
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

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(MediaDownloadError, match="redirect limit"):
            await MediaDownloader(
                client=client,
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

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(MediaDownloadError, match="destination already exists"):
            await MediaDownloader(
                client=client,
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

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(MediaDownloadError, match="destination already exists"):
            await MediaDownloader(
                client=client,
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

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(MediaDownloadError, match="destination directory changed"):
            await MediaDownloader(
                client=client,
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

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _request: httpx.Response(200))
    ) as client:
        with pytest.raises(MediaDownloadError, match="destination directory"):
            await MediaDownloader(
                client=client,
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
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        ) as client:
            await MediaDownloader(
                client=client,
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
