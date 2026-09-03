from urllib.parse import parse_qs, urlparse

from app.sources.base import ContentRef


def parse_youtube_url(url: str) -> ContentRef | None:
    try:
        parsed = urlparse(url)
    except ValueError:
        return None

    host = (parsed.hostname or "").lower()
    video_id = ""
    if host in {"youtu.be", "www.youtu.be"}:
        video_id = parsed.path.strip("/").split("/")[0]
    elif host == "youtube.com" or host.endswith(".youtube.com"):
        if parsed.path == "/watch":
            video_id = parse_qs(parsed.query).get("v", [""])[0]
        elif parsed.path.startswith("/shorts/"):
            video_id = parsed.path.split("/")[2]

    if parsed.scheme not in {"http", "https"} or not _is_video_id(video_id):
        return None
    return ContentRef(platform="youtube", source_content_id=video_id)


def _is_video_id(video_id: str) -> bool:
    return len(video_id) == 11 and all(
        character.isalnum() or character in "-_" for character in video_id
    )
