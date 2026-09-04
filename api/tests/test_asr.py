from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from app.core.settings import Settings
from app.services.asr import (
    AsrError,
    FasterWhisperTranscriber,
    asr_version,
    normalize_whisper_segments,
)
from app.sources.base import TranscriptSegment


class FakeWhisperModel:
    def __init__(
        self,
        segments: list[SimpleNamespace] | None = None,
        *,
        language: str = "en",
        error: Exception | None = None,
    ) -> None:
        self.segments = segments or []
        self.info = SimpleNamespace(language=language)
        self.error = error
        self.calls: list[dict[str, Any]] = []

    def transcribe(self, audio: str, *, vad_filter: bool):
        self.calls.append({"audio": audio, "vad_filter": vad_filter})
        if self.error is not None:
            raise self.error
        return iter(self.segments), self.info


class FakeWhisperFactory:
    def __init__(self, model: FakeWhisperModel) -> None:
        self.model = model
        self.calls: list[dict[str, Any]] = []

    def __call__(self, **kwargs: Any) -> FakeWhisperModel:
        self.calls.append(kwargs)
        return self.model


def raw_segment(start: float, end: float, text: str) -> SimpleNamespace:
    return SimpleNamespace(start=start, end=end, text=text)


def test_transcriber_uses_cpu_small_int8_and_returns_language(tmp_path: Path):
    model = FakeWhisperModel([raw_segment(1.25, 3.0, " Hello world ")])
    factory = FakeWhisperFactory(model)
    transcriber = FasterWhisperTranscriber(factory=factory)
    audio_path = tmp_path / "audio.wav"

    segments, language = transcriber.transcribe(audio_path)

    assert factory.calls == [
        {
            "model_size_or_path": "small",
            "device": "cpu",
            "compute_type": "int8",
            "download_root": "/models/whisper",
        }
    ]
    assert model.calls == [{"audio": str(audio_path), "vad_filter": True}]
    assert language == "en"
    assert segments == [
        TranscriptSegment(
            sequence=0,
            start_ms=1250,
            duration_ms=1750,
            text="Hello world",
        )
    ]


def test_asr_version_is_deterministic_and_contains_runtime_parameters():
    first = asr_version("small", "cpu", "int8", True)

    assert first == asr_version("small", "cpu", "int8", True)
    assert "small" in first
    assert "cpu" in first
    assert "int8" in first
    assert "vad_filter=true" in first


def test_normalization_clamps_negative_time_and_rounds_half_milliseconds_up():
    segments = normalize_whisper_segments(
        [
            raw_segment(-0.25, 0.0005, " first "),
            raw_segment(0.0015, 0.0035, "second"),
        ]
    )

    assert segments == [
        TranscriptSegment(sequence=0, start_ms=0, duration_ms=1, text="first"),
        TranscriptSegment(sequence=1, start_ms=2, duration_ms=2, text="second"),
    ]


def test_normalization_trims_overlap_and_skips_reversed_or_consumed_ranges():
    segments = normalize_whisper_segments(
        [
            raw_segment(0.0, 1.0, "first"),
            raw_segment(0.75, 1.5, "overlap"),
            raw_segment(0.25, 0.5, "out of order"),
            raw_segment(2.0, 1.75, "reversed"),
            raw_segment(1.5, 2.0, "last"),
        ]
    )

    assert segments == [
        TranscriptSegment(sequence=0, start_ms=0, duration_ms=1000, text="first"),
        TranscriptSegment(sequence=1, start_ms=1000, duration_ms=500, text="overlap"),
        TranscriptSegment(sequence=2, start_ms=1500, duration_ms=500, text="last"),
    ]


def test_normalization_skips_blank_text_without_advancing_timeline():
    segments = normalize_whisper_segments(
        [
            raw_segment(0.0, 5.0, " \n "),
            raw_segment(1.0, 2.0, "spoken"),
        ]
    )

    assert segments == [
        TranscriptSegment(sequence=0, start_ms=1000, duration_ms=1000, text="spoken")
    ]


def test_transcriber_rejects_an_empty_normalized_transcript(tmp_path: Path):
    factory = FakeWhisperFactory(
        FakeWhisperModel(
            [raw_segment(0.0, 0.0, "speech"), raw_segment(0.0, 1.0, "  ")]
        )
    )

    with pytest.raises(AsrError) as exc_info:
        FasterWhisperTranscriber(factory=factory).transcribe(tmp_path / "audio.wav")

    assert exc_info.value.code == "empty_transcript"
    assert str(exc_info.value) == "未识别到可用语音"


def test_model_is_loaded_lazily_and_cached(tmp_path: Path):
    model = FakeWhisperModel([raw_segment(0.0, 1.0, "speech")])
    factory = FakeWhisperFactory(model)
    transcriber = FasterWhisperTranscriber(factory=factory)

    assert factory.calls == []
    transcriber.transcribe(tmp_path / "one.wav")
    transcriber.transcribe(tmp_path / "two.wav")

    assert len(factory.calls) == 1


def test_concurrent_calls_initialize_the_model_once(tmp_path: Path):
    model = FakeWhisperModel([raw_segment(0.0, 1.0, "speech")])
    calls = 0
    calls_lock = threading.Lock()

    def factory(**_: Any) -> FakeWhisperModel:
        nonlocal calls
        with calls_lock:
            calls += 1
        time.sleep(0.02)
        return model

    transcriber = FasterWhisperTranscriber(factory=factory)

    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(
            executor.map(
                transcriber.transcribe,
                [tmp_path / f"audio-{index}.wav" for index in range(8)],
            )
        )

    assert calls == 1
    assert all(language == "en" for _, language in results)


def test_model_factory_error_is_mapped_without_logging_secrets(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
):
    def factory(**_: Any) -> FakeWhisperModel:
        raise RuntimeError("token=factory-secret")

    transcriber = FasterWhisperTranscriber(factory=factory)

    with caplog.at_level(logging.ERROR, logger="app.services.asr"):
        with pytest.raises(AsrError) as exc_info:
            transcriber.transcribe(tmp_path / "private-audio.wav")

    assert exc_info.value.code == "asr_model_unavailable"
    assert str(exc_info.value) == "语音识别模型加载失败"
    assert "factory-secret" not in caplog.text
    assert "private-audio.wav" not in caplog.text


def test_transcription_error_is_mapped_without_logging_secrets(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
):
    model = FakeWhisperModel(error=RuntimeError("token=transcribe-secret"))
    transcriber = FasterWhisperTranscriber(factory=FakeWhisperFactory(model))

    with caplog.at_level(logging.ERROR, logger="app.services.asr"):
        with pytest.raises(AsrError) as exc_info:
            transcriber.transcribe(tmp_path / "private-audio.wav")

    assert exc_info.value.code == "asr_transcription_failed"
    assert str(exc_info.value) == "语音识别失败"
    assert "transcribe-secret" not in caplog.text
    assert "private-audio.wav" not in caplog.text


def test_asr_settings_have_cpu_small_int8_defaults():
    settings = Settings(_env_file=None)

    assert settings.asr_model_size == "small"
    assert settings.asr_device == "cpu"
    assert settings.asr_compute_type == "int8"
    assert settings.asr_model_dir == "/models/whisper"


def test_asr_model_directory_allows_an_environment_override(monkeypatch):
    monkeypatch.setenv("ASR_MODEL_DIR", "/tmp/test-whisper-models")

    settings = Settings(_env_file=None)

    assert settings.asr_model_dir == "/tmp/test-whisper-models"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("asr_model_size", "medium"),
        ("asr_device", "cuda"),
        ("asr_compute_type", "float16"),
    ],
)
def test_asr_settings_reject_unsupported_runtime_modes(field: str, value: str):
    with pytest.raises(ValueError):
        Settings(_env_file=None, **{field: value})
