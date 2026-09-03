from app.sources.base import ContentRef
from app.sources.x import parse_x_url
from app.sources.youtube import parse_youtube_url


def test_parses_youtube_content_ref():
    assert parse_youtube_url(
        "https://www.youtube.com/watch?v=aircAruvnKk"
    ) == ContentRef(
        platform="youtube", source_content_id="aircAruvnKk", media_index=1
    )


def test_parses_x_video_route():
    assert parse_x_url(
        "https://x.com/viktoroddy/status/2075545587093807111/video/1"
    ) == ContentRef(
        platform="x", source_content_id="2075545587093807111", media_index=1
    )


def test_bare_x_status_requires_active_media_index():
    assert (
        parse_x_url(
            "https://x.com/viktoroddy/status/2075545587093807111",
            active_media_index=2,
        ).media_index
        == 2
    )


def test_rejects_twitter_dot_com():
    assert parse_x_url("https://twitter.com/user/status/2075545587093807111") is None


def test_content_ref_has_unambiguous_key():
    ref = ContentRef(
        platform="x", source_content_id="2075545587093807111", media_index=1
    )
    assert ref.stable_key == "x:2075545587093807111:1"
