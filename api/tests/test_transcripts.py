from __future__ import annotations

from dataclasses import dataclass

import pytest

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
