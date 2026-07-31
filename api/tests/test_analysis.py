from __future__ import annotations

import pytest

from app.services.analysis import (
    AnalysisGenerationError,
    AnalysisSegment,
    StructuredAnalysisService,
)


class FakeProvider:
    name = "fake"
    version = "test-1"

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = 0

    async def analyze(self, segments, target_language):
        self.calls += 1
        return self.responses.pop(0)


def source_segments():
    return [
        AnalysisSegment("one", 0, 1000, "Pixels", "像素"),
        AnalysisSegment("two", 1000, 1000, "Weights", "权重"),
    ]


def valid_payload():
    return {
        "one_line_summary": "视频解释了神经网络的基本结构。",
        "summary_points": ["输入层保存像素", "权重决定连接强度"],
        "chapters": [
            {"start_ms": 0, "end_ms": 2000, "title": "基础结构", "summary": "从像素到权重"}
        ],
        "highlights": [
            {
                "start_ms": 1000,
                "end_ms": 2000,
                "title": "权重",
                "summary": "权重决定连接强度",
                "original_excerpt": "Weights",
                "translated_excerpt": "权重",
            }
        ],
    }


@pytest.mark.asyncio
async def test_validates_and_records_provider_metadata():
    provider = FakeProvider([valid_payload()])
    result = await StructuredAnalysisService(provider).analyze(
        source_segments(), "zh-Hans", duration_ms=2000
    )

    assert result.one_line_summary.startswith("视频解释")
    assert result.model_name == "fake"
    assert result.model_version == "test-1"
    assert result.generated_at.tzinfo is not None


@pytest.mark.asyncio
async def test_retries_invalid_structure_then_accepts_valid_response():
    provider = FakeProvider([{"summary_points": []}, valid_payload()])
    result = await StructuredAnalysisService(provider, max_attempts=3).analyze(
        source_segments(), "zh-Hans", duration_ms=2000
    )

    assert result.chapters[0].title == "基础结构"
    assert provider.calls == 2


@pytest.mark.asyncio
async def test_rejects_out_of_range_timestamps_after_retries():
    payload = valid_payload()
    payload["chapters"][0]["end_ms"] = 3000
    provider = FakeProvider([payload, payload, payload])

    with pytest.raises(AnalysisGenerationError) as error:
        await StructuredAnalysisService(provider, max_attempts=3).analyze(
            source_segments(), "zh-Hans", duration_ms=2000
        )

    assert error.value.code == "analysis_invalid_response"
    assert provider.calls == 3


@pytest.mark.asyncio
async def test_deduplicates_identical_highlights():
    payload = valid_payload()
    payload["highlights"].append(dict(payload["highlights"][0]))
    provider = FakeProvider([payload])

    result = await StructuredAnalysisService(provider).analyze(
        source_segments(), "zh-Hans", duration_ms=2000
    )

    assert len(result.highlights) == 1
