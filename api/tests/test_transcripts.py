from __future__ import annotations

from dataclasses import dataclass

import pytest
from requests.exceptions import ConnectTimeout, ConnectionError

from app.services.transcripts import TranscriptService


@dataclass
class FakeSnippet:
    text: str
    start: float
    duration: float


class FakeTrack:
    def __init__(self, language_code, language, is_generated=False, is_translatable=True, snippets=None):
        self.language_code = language_code
        self.language = language
        self.is_generated = is_generated
        self.is_translatable = is_translatable
        self._snippets = [FakeSnippet("Hello", 0.0, 1.5)] if snippets is None else snippets

    def fetch(self):
        return self._snippets


class FakeTranscriptList:
    def __init__(self, tracks):
        self._tracks = tracks

    def __iter__(self):
        return iter(self._tracks)


class FakeApi:
    def __init__(self, tracks):
        self.tracks = tracks

    def list(self, video_id):
        return FakeTranscriptList(self.tracks)


def test_prefers_manual_requested_language_over_auto_generated_english():
    tracks = [
        FakeTrack("en", "English", is_generated=True),
        FakeTrack("zh-Hans", "Chinese (Simplified)", is_generated=False),
    ]
    result = TranscriptService(api=FakeApi(tracks)).inspect(
        "aircAruvnKk", preferred_languages=["zh-Hans"]
    )

    assert result.available is True
    assert result.selected.language_code == "zh-Hans"
    assert result.selected.is_generated is False
    assert result.segments[0].start_ms == 0
    assert result.segments[0].duration_ms == 1500


def test_prefers_manual_english_when_no_preferred_language_exists():
    tracks = [
        FakeTrack("en", "English", is_generated=True),
        FakeTrack("en", "English", is_generated=False),
        FakeTrack("ja", "Japanese", is_generated=False),
    ]
    result = TranscriptService(api=FakeApi(tracks)).inspect("aircAruvnKk")

    assert result.selected.language_code == "en"
    assert result.selected.is_generated is False


def test_empty_track_is_not_readable():
    tracks = [FakeTrack("en", "English", snippets=[])]
    result = TranscriptService(api=FakeApi(tracks)).inspect("aircAruvnKk")

    assert result.available is False
    assert result.failure_code == "empty_transcript"


def test_library_errors_are_normalized():
    class DisabledApi:
        def list(self, video_id):
            from youtube_transcript_api._errors import TranscriptsDisabled

            raise TranscriptsDisabled(video_id)

    result = TranscriptService(api=DisabledApi()).inspect("aircAruvnKk")

    assert result.available is False
    assert result.failure_code == "captions_disabled"


def test_no_track_is_reported_without_fabricating_segments():
    result = TranscriptService(api=FakeApi([])).inspect("aircAruvnKk")

    assert result.available is False
    assert result.failure_code == "no_caption_track"
    assert result.segments == []


def test_configured_proxy_is_passed_to_youtube_transcript_client(monkeypatch):
    captured = {}

    class RecordingApi:
        def __init__(self, *, proxy_config):
            captured["proxy_config"] = proxy_config

    monkeypatch.setattr("app.services.transcripts.YouTubeTranscriptApi", RecordingApi)

    TranscriptService(proxy_url="http://127.0.0.1:7890")

    assert captured["proxy_config"].to_requests_dict() == {
        "http": "http://127.0.0.1:7890",
        "https": "http://127.0.0.1:7890",
    }


def test_network_timeout_is_reported_as_a_transcript_connection_failure():
    class TimeoutApi:
        def list(self, video_id):
            raise ConnectTimeout("youtube connection timed out")

    result = TranscriptService(api=TimeoutApi()).inspect("aircAruvnKk")

    assert result.available is False
    assert result.failure_code == "transcript_connection_failed"


def test_retries_a_connection_reset_before_reading_captions():
    class ResetThenSuccessApi:
        def __init__(self):
            self.calls = 0

        def list(self, video_id):
            self.calls += 1
            if self.calls == 1:
                raise ConnectionError("Connection reset by peer")
            return FakeTranscriptList([FakeTrack("en", "English")])

    sleeps = []
    api = ResetThenSuccessApi()
    result = TranscriptService(api=api, sleep=sleeps.append).inspect("aircAruvnKk")

    assert result.available is True
    assert api.calls == 2
    assert sleeps == [0.25]
