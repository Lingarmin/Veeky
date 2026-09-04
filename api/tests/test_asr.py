from __future__ import annotations

import json
import logging
import threading
import time
import tomllib
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

import app.services.asr as asr_module
from app.core.settings import Settings
from app.services.asr import (
    AsrError,
    FasterWhisperTranscriber,
    asr_version,
    normalize_whisper_segments,
)
from app.sources.base import TranscriptSegment


EXPECTED_MODEL_REVISION = "536b0662742c02347bc0e980a01041f333bce120"
EXPECTED_TRANSCRIBE_OPTIONS = {
    "language": None,
    "task": "transcribe",
    "log_progress": False,
    "beam_size": 5,
    "best_of": 5,
    "patience": 1.0,
    "length_penalty": 1.0,
    "repetition_penalty": 1.0,
    "no_repeat_ngram_size": 0,
    "temperature": (0.0, 0.2, 0.4, 0.6, 0.8, 1.0),
    "compression_ratio_threshold": 2.4,
    "log_prob_threshold": -1.0,
    "no_speech_threshold": 0.6,
    "condition_on_previous_text": True,
    "prompt_reset_on_temperature": 0.5,
    "initial_prompt": None,
    "prefix": None,
    "suppress_blank": True,
    "suppress_tokens": [-1],
    "without_timestamps": False,
    "max_initial_timestamp": 1.0,
    "word_timestamps": False,
    "prepend_punctuations": "\"'“¿([{-",
    "append_punctuations": "\"'.。,，!！?？:：”)]}、",
    "multilingual": False,
    "vad_filter": True,
    "vad_parameters": {
        "threshold": 0.5,
        "neg_threshold": None,
        "min_speech_duration_ms": 0,
        "max_speech_duration_s": 14400.0,
        "min_silence_duration_ms": 2000,
        "speech_pad_ms": 400,
    },
    "max_new_tokens": None,
    "chunk_length": None,
    "clip_timestamps": "0",
    "hallucination_silence_threshold": None,
    "hotwords": None,
    "language_detection_threshold": 0.5,
    "language_detection_segments": 1,
}


class FakeWhisperModel:
    def __init__(
        self,
        segments: list[SimpleNamespace] | None = None,
        *,
        language: Any = "en",
        error: Exception | None = None,
    ) -> None:
        self.segments = segments or []
        self.info = SimpleNamespace(language=language)
        self.error = error
        self.calls: list[dict[str, Any]] = []

    def transcribe(self, audio: str, **kwargs: Any):
        self.calls.append({"audio": audio, **kwargs})
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


def raw_segment(start: Any, end: Any, text: Any) -> SimpleNamespace:
    return SimpleNamespace(start=start, end=end, text=text)


def test_transcriber_uses_cpu_small_int8_and_returns_language(tmp_path: Path):
    model = FakeWhisperModel([raw_segment(1.25, 3.0, " Hello world ")])
    factory = FakeWhisperFactory(model)
    transcriber = FasterWhisperTranscriber(factory=factory)
    audio_path = tmp_path / "audio.wav"

    segments, language = transcriber.transcribe(audio_path)

    assert factory.calls == [
        {
            "model_size_or_path": "Systran/faster-whisper-small",
            "device": "cpu",
            "compute_type": "int8",
            "download_root": "/models/whisper",
            "revision": EXPECTED_MODEL_REVISION,
            "local_files_only": False,
            "device_index": 0,
            "cpu_threads": 0,
            "num_workers": 1,
        }
    ]
    assert model.calls == [
        {"audio": str(audio_path), **EXPECTED_TRANSCRIBE_OPTIONS}
    ]
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
    version = json.loads(first)
    assert version["model"] == {
        "compute_type": "int8",
        "cpu_threads": 0,
        "device": "cpu",
        "device_index": 0,
        "local_files_only": False,
        "num_workers": 1,
        "repo": "Systran/faster-whisper-small",
        "revision": EXPECTED_MODEL_REVISION,
        "size": "small",
    }
    assert version["runtime"] == {
        "ctranslate2": "4.8.2",
        "faster_whisper": "1.2.1",
    }
    assert version["transcribe"] == json.loads(
        json.dumps(EXPECTED_TRANSCRIBE_OPTIONS)
    )


def test_model_revision_matches_the_verified_hugging_face_metadata():
    assert asr_module.ASR_MODEL_REPO == "Systran/faster-whisper-small"
    assert asr_module.ASR_MODEL_REVISION == EXPECTED_MODEL_REVISION


def test_transcriber_rejects_a_model_size_that_does_not_match_the_pinned_repo():
    with pytest.raises(ValueError, match="small"):
        FasterWhisperTranscriber(model_size="medium")


def test_asr_dependencies_are_exactly_pinned():
    pyproject = tomllib.loads(
        (Path(__file__).parents[1] / "pyproject.toml").read_text()
    )

    assert "faster-whisper==1.2.1" in pyproject["project"]["dependencies"]
    assert "ctranslate2==4.8.2" in pyproject["project"]["dependencies"]


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


def test_normalization_skips_missing_none_or_non_string_text():
    missing_text = SimpleNamespace(start=0.0, end=1.0)

    segments = normalize_whisper_segments(
        [
            missing_text,
            raw_segment(0.0, 1.0, None),
            raw_segment(0.0, 1.0, 42),
            raw_segment(1.0, 2.0, "spoken"),
        ]
    )

    assert segments == [
        TranscriptSegment(sequence=0, start_ms=1000, duration_ms=1000, text="spoken")
    ]


@pytest.mark.parametrize(
    "invalid_timestamp",
    [float("nan"), float("inf"), float("-inf"), "not-a-timestamp", None],
)
def test_normalization_skips_non_finite_or_invalid_timestamps(invalid_timestamp: Any):
    segments = normalize_whisper_segments(
        [
            raw_segment(invalid_timestamp, 1.0, "bad start"),
            raw_segment(0.0, invalid_timestamp, "bad end"),
            SimpleNamespace(start=0.0, text="missing end"),
            SimpleNamespace(end=1.0, text="missing start"),
            raw_segment(1.0, 2.0, "spoken"),
        ]
    )

    assert segments == [
        TranscriptSegment(sequence=0, start_ms=1000, duration_ms=1000, text="spoken")
    ]


def test_normalization_suppresses_identical_text_only_when_raw_ranges_overlap():
    segments = normalize_whisper_segments(
        [
            raw_segment(0.0, 1.0, "repeat"),
            raw_segment(0.75, 1.25, "repeat"),
            raw_segment(1.0, 1.5, "different"),
            raw_segment(1.5, 2.0, "repeat"),
        ]
    )

    assert segments == [
        TranscriptSegment(sequence=0, start_ms=0, duration_ms=1000, text="repeat"),
        TranscriptSegment(sequence=1, start_ms=1000, duration_ms=500, text="different"),
        TranscriptSegment(sequence=2, start_ms=1500, duration_ms=500, text="repeat"),
    ]


def test_normalization_keeps_adjacent_identical_text():
    segments = normalize_whisper_segments(
        [raw_segment(0.0, 1.0, "repeat"), raw_segment(1.0, 2.0, "repeat")]
    )

    assert [segment.text for segment in segments] == ["repeat", "repeat"]


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
    upstream_message = "token=factory-secret /private/model https://models.invalid"

    def factory(**_: Any) -> FakeWhisperModel:
        raise RuntimeError(upstream_message)

    transcriber = FasterWhisperTranscriber(factory=factory)

    with caplog.at_level(logging.ERROR, logger="app.services.asr"):
        with pytest.raises(AsrError) as exc_info:
            transcriber.transcribe(tmp_path / "private-audio.wav")

    assert exc_info.value.code == "asr_model_unavailable"
    assert str(exc_info.value) == "语音识别模型加载失败"
    assert "factory-secret" not in caplog.text
    assert "private-audio.wav" not in caplog.text
    formatted = "".join(
        traceback.format_exception(
            type(exc_info.value), exc_info.value, exc_info.value.__traceback__
        )
    )
    assert "factory-secret" not in formatted
    assert "/private/model" not in formatted
    assert "https://models.invalid" not in formatted


def test_transcription_error_is_mapped_without_logging_secrets(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
):
    upstream_message = (
        "token=transcribe-secret /private/audio.wav https://media.invalid"
    )
    model = FakeWhisperModel(error=RuntimeError(upstream_message))
    transcriber = FasterWhisperTranscriber(factory=FakeWhisperFactory(model))

    with caplog.at_level(logging.ERROR, logger="app.services.asr"):
        with pytest.raises(AsrError) as exc_info:
            transcriber.transcribe(tmp_path / "private-audio.wav")

    assert exc_info.value.code == "asr_transcription_failed"
    assert str(exc_info.value) == "语音识别失败"
    assert "transcribe-secret" not in caplog.text
    assert "private-audio.wav" not in caplog.text
    formatted = "".join(
        traceback.format_exception(
            type(exc_info.value), exc_info.value, exc_info.value.__traceback__
        )
    )
    assert "transcribe-secret" not in formatted
    assert "/private/audio.wav" not in formatted
    assert "https://media.invalid" not in formatted


def test_detected_language_is_canonicalized_to_lowercase(tmp_path: Path):
    model = FakeWhisperModel(
        [raw_segment(0.0, 1.0, "speech")], language="ZH-Hant"
    )

    _, language = FasterWhisperTranscriber(
        factory=FakeWhisperFactory(model)
    ).transcribe(tmp_path / "audio.wav")

    assert language == "zh-hant"


@pytest.mark.parametrize("language", [None, "", "english", "en_US", 42])
def test_invalid_detected_language_is_rejected_safely(tmp_path: Path, language: Any):
    model = FakeWhisperModel(
        [raw_segment(0.0, 1.0, "speech")], language=language
    )

    with pytest.raises(AsrError) as exc_info:
        FasterWhisperTranscriber(factory=FakeWhisperFactory(model)).transcribe(
            tmp_path / "private-audio.wav"
        )

    assert exc_info.value.code == "asr_invalid_language"
    assert str(exc_info.value) == "语音识别返回了无效语言"
    formatted = "".join(
        traceback.format_exception(
            type(exc_info.value), exc_info.value, exc_info.value.__traceback__
        )
    )
    assert "private-audio.wav" not in formatted


def test_missing_detected_language_is_rejected_safely(tmp_path: Path):
    model = FakeWhisperModel([raw_segment(0.0, 1.0, "speech")])
    model.info = SimpleNamespace()

    with pytest.raises(AsrError) as exc_info:
        FasterWhisperTranscriber(factory=FakeWhisperFactory(model)).transcribe(
            tmp_path / "private-audio.wav"
        )

    assert exc_info.value.code == "asr_invalid_language"
    assert str(exc_info.value) == "语音识别返回了无效语言"


def test_default_transcriber_is_reused_within_a_process(monkeypatch):
    monkeypatch.setattr(asr_module, "_default_transcriber", None, raising=False)
    monkeypatch.setattr(asr_module, "_default_transcriber_pid", None, raising=False)
    monkeypatch.setattr(asr_module.os, "getpid", lambda: 100)
    factory = FakeWhisperFactory(FakeWhisperModel())
    settings = Settings(_env_file=None)

    first = asr_module.get_default_transcriber(settings=settings, factory=factory)
    second = asr_module.get_default_transcriber(settings=settings, factory=factory)

    assert first is second
    assert factory.calls == []


def test_default_transcriber_is_recreated_after_process_id_changes(monkeypatch):
    monkeypatch.setattr(asr_module, "_default_transcriber", None, raising=False)
    monkeypatch.setattr(asr_module, "_default_transcriber_pid", None, raising=False)
    process_id = [100]
    monkeypatch.setattr(asr_module.os, "getpid", lambda: process_id[0])
    factory = FakeWhisperFactory(FakeWhisperModel())
    settings = Settings(_env_file=None)

    parent_transcriber = asr_module.get_default_transcriber(
        settings=settings, factory=factory
    )
    process_id[0] = 101
    child_transcriber = asr_module.get_default_transcriber(
        settings=settings, factory=factory
    )

    assert child_transcriber is not parent_transcriber


def test_default_transcriber_provider_is_thread_safe(monkeypatch):
    monkeypatch.setattr(asr_module, "_default_transcriber", None, raising=False)
    monkeypatch.setattr(asr_module, "_default_transcriber_pid", None, raising=False)
    monkeypatch.setattr(asr_module.os, "getpid", lambda: 100)
    factory = FakeWhisperFactory(FakeWhisperModel())
    settings = Settings(_env_file=None)

    with ThreadPoolExecutor(max_workers=8) as executor:
        transcribers = list(
            executor.map(
                lambda _: asr_module.get_default_transcriber(
                    settings=settings, factory=factory
                ),
                range(32),
            )
        )

    assert len({id(transcriber) for transcriber in transcribers}) == 1


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


def test_container_smoke_does_not_require_existing_service_containers():
    script = (
        Path(__file__).parents[1] / "scripts" / "asr_container_smoke.sh"
    ).read_text()

    assert "docker compose images" not in script
    assert "docker compose run --rm --no-deps" in script
    assert 'version("faster-whisper") == "1.2.1"' in script
    assert 'version("ctranslate2") == "4.8.2"' in script
    assert "touch /models/whisper/.asr-smoke" in script
    assert "touch /var/lib/veeky/media/.asr-smoke" in script
