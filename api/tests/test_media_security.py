from __future__ import annotations

import asyncio
from collections.abc import Iterable
from pathlib import Path

import httpx
import pytest

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
    await validate_x_media_url(url, resolver=resolver_returning(PUBLIC_IPV4))


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
        "::1",
        "fc00::1",
        "fe80::1",
        "ff02::1",
        "2001:db8::1",
        "::",
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
        return httpx.Response(200, content=b"sixteen-byte-mp4")

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
