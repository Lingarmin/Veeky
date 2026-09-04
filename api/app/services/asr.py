from __future__ import annotations

import json
import logging
import os
import re
import threading
from collections.abc import Callable, Iterable
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any

from app.core.settings import Settings, get_settings
from app.sources.base import TranscriptSegment


logger = logging.getLogger(__name__)

ASR_MODEL_REPO = "Systran/faster-whisper-small"
# Hugging Face model metadata `sha` for ASR_MODEL_REPO, verified 2026-09-04.
ASR_MODEL_REVISION = "536b0662742c02347bc0e980a01041f333bce120"
FASTER_WHISPER_VERSION = "1.2.1"
CTRANSLATE2_VERSION = "4.8.2"

_LANGUAGE_CODE = re.compile(r"^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$")


class AsrError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def asr_version(
    model_size: str, device: str, compute_type: str, vad_filter: bool
) -> str:
    value = {
        "model": {
            "compute_type": compute_type,
            "cpu_threads": 0,
            "device": device,
            "device_index": 0,
            "local_files_only": False,
            "num_workers": 1,
            "repo": ASR_MODEL_REPO,
            "revision": ASR_MODEL_REVISION,
            "size": model_size,
        },
        "runtime": {
            "ctranslate2": CTRANSLATE2_VERSION,
            "faster_whisper": FASTER_WHISPER_VERSION,
        },
        "transcribe": _transcribe_options(vad_filter),
    }
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def normalize_whisper_segments(
    raw_segments: Iterable[Any],
) -> list[TranscriptSegment]:
    result: list[TranscriptSegment] = []
    emitted_raw_ranges: list[tuple[str, int, int]] = []
    previous_end_ms = 0

    for raw_segment in raw_segments:
        text = getattr(raw_segment, "text", None)
        if not isinstance(text, str):
            continue
        text = text.strip()
        if not text:
            continue

        raw_start_ms = _seconds_to_milliseconds(
            getattr(raw_segment, "start", None)
        )
        raw_end_ms = _seconds_to_milliseconds(getattr(raw_segment, "end", None))
        if raw_start_ms is None or raw_end_ms is None:
            continue
        raw_start_ms = max(0, raw_start_ms)
        raw_end_ms = max(0, raw_end_ms)
        if raw_end_ms <= raw_start_ms:
            continue
        if any(
            text == emitted_text
            and raw_start_ms < emitted_end_ms
            and emitted_start_ms < raw_end_ms
            for emitted_text, emitted_start_ms, emitted_end_ms in emitted_raw_ranges
        ):
            continue

        start_ms = max(previous_end_ms, raw_start_ms)
        if raw_end_ms <= start_ms:
            continue

        result.append(
            TranscriptSegment(
                sequence=len(result),
                start_ms=start_ms,
                duration_ms=raw_end_ms - start_ms,
                text=text,
            )
        )
        emitted_raw_ranges.append((text, raw_start_ms, raw_end_ms))
        previous_end_ms = raw_end_ms

    return result


class FasterWhisperTranscriber:
    def __init__(
        self,
        model_size: str = "small",
        model_dir: str = "/models/whisper",
        *,
        factory: Callable[..., Any] | None = None,
    ) -> None:
        if model_size != "small":
            raise ValueError("only the small ASR model is supported")
        self.model_size = model_size
        self.model_dir = model_dir
        self.device = "cpu"
        self.compute_type = "int8"
        self.vad_filter = True
        self.version = asr_version(
            self.model_size,
            self.device,
            self.compute_type,
            self.vad_filter,
        )
        self._factory = factory or _create_whisper_model
        self._model: Any | None = None
        self._model_lock = threading.Lock()

    def transcribe(
        self, audio_path: Path
    ) -> tuple[list[TranscriptSegment], str]:
        model = self._get_model()
        try:
            raw_segments, info = model.transcribe(
                str(audio_path), **_transcribe_options(self.vad_filter)
            )
            segments = normalize_whisper_segments(raw_segments)
        except Exception:
            logger.error("ASR transcription failed")
            raise AsrError("asr_transcription_failed", "语音识别失败") from None

        if not segments:
            raise AsrError("empty_transcript", "未识别到可用语音")
        try:
            raw_language = getattr(info, "language", None)
        except Exception:
            raw_language = None
        language = _normalize_language(raw_language)
        return segments, language

    def _get_model(self) -> Any:
        if self._model is not None:
            return self._model
        with self._model_lock:
            if self._model is not None:
                return self._model
            try:
                self._model = self._factory(
                    model_size_or_path=ASR_MODEL_REPO,
                    device=self.device,
                    compute_type=self.compute_type,
                    download_root=self.model_dir,
                    revision=ASR_MODEL_REVISION,
                    local_files_only=False,
                    device_index=0,
                    cpu_threads=0,
                    num_workers=1,
                )
            except Exception:
                logger.error("ASR model initialization failed")
                raise AsrError(
                    "asr_model_unavailable", "语音识别模型加载失败"
                ) from None
            return self._model


def _transcribe_options(vad_filter: bool) -> dict[str, Any]:
    return {
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
        "vad_filter": vad_filter,
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


def _seconds_to_milliseconds(seconds: Any) -> int | None:
    try:
        value = Decimal(str(seconds))
        if not value.is_finite():
            return None
        return int(
            (value * Decimal(1000)).quantize(
                Decimal(1), rounding=ROUND_HALF_UP
            )
        )
    except (InvalidOperation, TypeError, ValueError):
        return None


def _normalize_language(language: Any) -> str:
    if not isinstance(language, str):
        raise AsrError(
            "asr_invalid_language", "语音识别返回了无效语言"
        ) from None
    canonical = language.lower()
    if not _LANGUAGE_CODE.fullmatch(canonical):
        raise AsrError(
            "asr_invalid_language", "语音识别返回了无效语言"
        ) from None
    return canonical


def _create_whisper_model(**kwargs: Any) -> Any:
    from faster_whisper import WhisperModel

    return WhisperModel(**kwargs)


_default_transcriber: FasterWhisperTranscriber | None = None
_default_transcriber_pid: int | None = None
_default_transcriber_lock = threading.Lock()


def get_default_transcriber(
    *,
    settings: Settings | None = None,
    factory: Callable[..., Any] | None = None,
) -> FasterWhisperTranscriber:
    global _default_transcriber, _default_transcriber_pid

    process_id = os.getpid()
    if (
        _default_transcriber is not None
        and _default_transcriber_pid == process_id
    ):
        return _default_transcriber
    with _default_transcriber_lock:
        if (
            _default_transcriber is not None
            and _default_transcriber_pid == process_id
        ):
            return _default_transcriber
        asr_settings = settings or get_settings()
        _default_transcriber = FasterWhisperTranscriber(
            model_size=asr_settings.asr_model_size,
            model_dir=asr_settings.asr_model_dir,
            factory=factory,
        )
        _default_transcriber_pid = process_id
        return _default_transcriber


def _clear_default_transcriber_after_fork() -> None:
    global _default_transcriber, _default_transcriber_pid, _default_transcriber_lock

    _default_transcriber = None
    _default_transcriber_pid = None
    _default_transcriber_lock = threading.Lock()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_clear_default_transcriber_after_fork)
