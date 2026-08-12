from __future__ import annotations

import pytest

from app.services.video_metadata import VideoMetadataError, VideoMetadataService


class FakeYoutubeDL:
    def __init__(self, options, *, info=None, error=None):
        self.options = options
        self.info = info
        self.error = error
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def extract_info(self, url, *, download):
        self.calls.append((url, download))
        if self.error:
            raise self.error
        return self.info


def test_video_metadata_reads_duration_without_downloading_media():
    captured = {}

    def factory(options):
        captured["downloader"] = FakeYoutubeDL(options, info={"duration": 14_400})
        return captured["downloader"]

    service = VideoMetadataService(
        downloader_factory=factory,
        proxy_url="http://proxy.example:7890",
    )

    assert service.duration_ms("aircAruvnKk") == 14_400_000
    downloader = captured["downloader"]
    assert downloader.calls == [
        ("https://www.youtube.com/watch?v=aircAruvnKk", False)
    ]
    assert downloader.options["noplaylist"] is True
    assert downloader.options["proxy"] == "http://proxy.example:7890"


@pytest.mark.parametrize("info", [{}, {"duration": None}, {"duration": 0}, {"duration": "bad"}])
def test_video_metadata_rejects_missing_or_invalid_duration(info):
    service = VideoMetadataService(
        downloader_factory=lambda options: FakeYoutubeDL(options, info=info)
    )

    with pytest.raises(VideoMetadataError, match="duration"):
        service.duration_ms("aircAruvnKk")


def test_video_metadata_normalizes_extractor_failures():
    service = VideoMetadataService(
        downloader_factory=lambda options: FakeYoutubeDL(
            options, error=RuntimeError("youtube unavailable")
        )
    )

    with pytest.raises(VideoMetadataError, match="youtube unavailable"):
        service.duration_ms("aircAruvnKk")
