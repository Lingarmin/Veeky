from __future__ import annotations

from collections.abc import Callable
from typing import Any

import yt_dlp


class VideoMetadataError(RuntimeError):
    pass


class VideoMetadataService:
    def __init__(
        self,
        *,
        downloader_factory: Callable[[dict[str, Any]], Any] = yt_dlp.YoutubeDL,
        proxy_url: str | None = None,
    ):
        self.downloader_factory = downloader_factory
        self.proxy_url = proxy_url

    def duration_ms(self, video_id: str) -> int:
        options: dict[str, Any] = {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "socket_timeout": 15,
            "skip_download": True,
        }
        if self.proxy_url:
            options["proxy"] = self.proxy_url
        url = f"https://www.youtube.com/watch?v={video_id}"
        try:
            with self.downloader_factory(options) as downloader:
                info = downloader.extract_info(url, download=False)
        except Exception as error:
            raise VideoMetadataError(str(error)) from error
        duration = info.get("duration") if isinstance(info, dict) else None
        if isinstance(duration, bool) or not isinstance(duration, (int, float)):
            raise VideoMetadataError("video metadata duration is unavailable")
        if duration <= 0:
            raise VideoMetadataError("video metadata duration must be positive")
        return round(duration * 1000)
