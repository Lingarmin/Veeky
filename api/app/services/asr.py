from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Iterable
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any

from app.sources.base import TranscriptSegment


logger = logging.getLogger(__name__)


class AsrError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def asr_version(
    model_size: str, device: str, compute_type: str, vad_filter: bool
) -> str:
    return (
        f"faster-whisper:model={model_size};device={device};"
        f"compute_type={compute_type};vad_filter={str(vad_filter).lower()};"
        "timestamps=segment"
    )


def normalize_whisper_segments(
    raw_segments: Iterable[Any],
) -> list[TranscriptSegment]:
    result: list[TranscriptSegment] = []
    previous_end_ms = 0

    for raw_segment in raw_segments:
        text = str(raw_segment.text).strip()
        if not text:
            continue

        raw_start_ms = max(0, _seconds_to_milliseconds(raw_segment.start))
        raw_end_ms = max(0, _seconds_to_milliseconds(raw_segment.end))
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
                str(audio_path), vad_filter=self.vad_filter
            )
            segments = normalize_whisper_segments(raw_segments)
            language = str(info.language)
        except Exception as error:
            logger.error("ASR transcription failed")
            raise AsrError("asr_transcription_failed", "语音识别失败") from error

        if not segments:
            raise AsrError("empty_transcript", "未识别到可用语音")
        return segments, language

    def _get_model(self) -> Any:
        if self._model is not None:
            return self._model
        with self._model_lock:
            if self._model is not None:
                return self._model
            try:
                self._model = self._factory(
                    model_size_or_path=self.model_size,
                    device=self.device,
                    compute_type=self.compute_type,
                    download_root=self.model_dir,
                )
            except Exception as error:
                logger.error("ASR model initialization failed")
                raise AsrError(
                    "asr_model_unavailable", "语音识别模型加载失败"
                ) from error
            return self._model


def _seconds_to_milliseconds(seconds: Any) -> int:
    return int(
        (Decimal(str(seconds)) * Decimal(1000)).quantize(
            Decimal(1), rounding=ROUND_HALF_UP
        )
    )


def _create_whisper_model(**kwargs: Any) -> Any:
    from faster_whisper import WhisperModel

    return WhisperModel(**kwargs)
