import re
from urllib.parse import urlparse

from app.sources.base import ContentRef


_STATUS_PATH = re.compile(
    r"^/[^/]+/status/(?P<status_id>[0-9]+)(?:/video/(?P<media_index>[0-9]+))?/?$"
)


def parse_x_url(
    url: str, active_media_index: int | None = None
) -> ContentRef | None:
    try:
        parsed = urlparse(url)
    except ValueError:
        return None

    if parsed.scheme not in {"http", "https"}:
        return None
    if (parsed.hostname or "").lower() not in {"x.com", "www.x.com"}:
        return None

    match = _STATUS_PATH.fullmatch(parsed.path)
    if match is None:
        return None

    route_media_index = match.group("media_index")
    try:
        media_index = int(route_media_index) if route_media_index else active_media_index
    except ValueError:
        return None
    if not isinstance(media_index, int) or isinstance(media_index, bool) or media_index <= 0:
        return None

    return ContentRef(
        platform="x",
        source_content_id=match.group("status_id"),
        media_index=media_index,
    )
