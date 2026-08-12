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
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def source_segments():
    return [
        AnalysisSegment("one", 0, 1000, "Pixels", "像素"),
        AnalysisSegment("two", 1000, 1000, "Weights", "权重"),
    ]


def valid_payload():
    return {
        "one_line_summary": "视频解释了神经网络的基本结构。",
        "summary_points": ["输入层保存像素", "权重决定连接强度", "偏置影响激活结果"],
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


def kimi_alias_payload():
    return {
        "one_line_summary": "视频展示了如何用 AI 工具制作网站。",
        "summary_points": ["设计页面", "生成素材", "发布网站"],
        "chapters": [
            {"title": "介绍", "start_ms": 0, "end_ms": 1200},
            {"title": "制作过程", "start_ms": 1200, "end_ms": 2000},
        ],
        "highlights": [
            {"description": "展示网站生成效果", "timestamp_ms": 1000},
        ],
    }


def string_timestamp_alias_payload():
    payload = valid_payload()
    payload["highlights"] = [
        {
            "timestamp": "1000",
            "description": "展示网站生成效果",
        }
    ]
    return payload


def text_highlight_alias_payload():
    payload = valid_payload()
    payload["highlights"] = [
        {
            "text": "先确认问题，再拆分解决方案",
            "start_ms": 1000,
            "end_ms": 2000,
        }
    ]
    return payload


def quote_highlight_alias_payload():
    payload = valid_payload()
    payload["highlights"] = [
        {
            "quote": "先确认问题，再拆分解决方案",
            "start_ms": 1000,
            "end_ms": 2000,
        }
    ]
    return payload


def chapter_start_end_seconds_payload():
    payload = valid_payload()
    payload["chapters"] = [
        {
            "start": 0,
            "end": 1.2,
            "title": "基础结构",
            "summary": "从像素到权重",
        }
    ]
    return payload


def highlight_start_without_end_payload():
    payload = valid_payload()
    payload["highlights"] = [
        {
            "start_ms": 1000,
            "title": "权重",
            "summary": "权重决定连接强度",
            "original_excerpt": "Weights",
            "translated_excerpt": "权重",
        }
    ]
    return payload


def highlight_start_end_seconds_payload():
    payload = valid_payload()
    payload["highlights"] = [
        {
            "start": 1,
            "end": 2,
            "title": "权重",
            "summary": "权重决定连接强度",
            "original_excerpt": "Weights",
            "translated_excerpt": "权重",
        }
    ]
    return payload


def highlight_clock_timestamp_payload():
    payload = valid_payload()
    payload["highlights"] = [
        {
            "timestamp": "1:24",
            "description": "展示设计系统",
        }
    ]
    return payload


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
async def test_accepts_kimi_timestamp_and_description_aliases():
    provider = FakeProvider([kimi_alias_payload()])

    result = await StructuredAnalysisService(provider).analyze(
        source_segments(), "zh-Hans", duration_ms=2000
    )

    assert result.chapters[0].summary == "介绍"
    assert result.highlights[0].start_ms == 1000
    assert result.highlights[0].end_ms == 2000
    assert result.highlights[0].summary == "展示网站生成效果"


@pytest.mark.asyncio
async def test_accepts_string_timestamp_alias_from_kimi_gateway():
    provider = FakeProvider([string_timestamp_alias_payload()])

    result = await StructuredAnalysisService(provider).analyze(
        source_segments(), "zh-Hans", duration_ms=2000
    )

    assert result.highlights[0].start_ms == 1000
    assert result.highlights[0].end_ms == 2000


@pytest.mark.asyncio
async def test_accepts_text_highlight_alias_from_kimi_gateway():
    provider = FakeProvider([text_highlight_alias_payload()])

    result = await StructuredAnalysisService(provider).analyze(
        source_segments(), "zh-Hans", duration_ms=2000
    )

    highlight = result.highlights[0]
    assert highlight.title == "先确认问题，再拆分解决方案"
    assert highlight.summary == "先确认问题，再拆分解决方案"
    assert highlight.original_excerpt == "先确认问题，再拆分解决方案"
    assert highlight.translated_excerpt == "先确认问题，再拆分解决方案"


@pytest.mark.asyncio
async def test_accepts_quote_highlight_alias_from_kimi_gateway():
    provider = FakeProvider([quote_highlight_alias_payload()])

    result = await StructuredAnalysisService(provider).analyze(
        source_segments(), "zh-Hans", duration_ms=2000
    )

    highlight = result.highlights[0]
    assert highlight.title == "先确认问题，再拆分解决方案"
    assert highlight.summary == "先确认问题，再拆分解决方案"
    assert highlight.original_excerpt == "先确认问题，再拆分解决方案"
    assert highlight.translated_excerpt == "先确认问题，再拆分解决方案"


@pytest.mark.asyncio
async def test_accepts_chapter_start_end_seconds_aliases_from_deepseek():
    provider = FakeProvider([chapter_start_end_seconds_payload()])

    result = await StructuredAnalysisService(provider).analyze(
        source_segments(), "zh-Hans", duration_ms=2000
    )

    assert result.chapters[0].start_ms == 0
    assert result.chapters[0].end_ms == 1200


@pytest.mark.asyncio
async def test_defaults_missing_highlight_end_to_a_short_window():
    provider = FakeProvider([highlight_start_without_end_payload()])

    result = await StructuredAnalysisService(provider).analyze(
        source_segments(), "zh-Hans", duration_ms=2000
    )

    assert result.highlights[0].start_ms == 1000
    assert result.highlights[0].end_ms == 2000


@pytest.mark.asyncio
async def test_accepts_highlight_start_end_seconds_aliases_from_deepseek():
    provider = FakeProvider([highlight_start_end_seconds_payload()])

    result = await StructuredAnalysisService(provider).analyze(
        source_segments(), "zh-Hans", duration_ms=2000
    )

    assert result.highlights[0].start_ms == 1000
    assert result.highlights[0].end_ms == 2000


@pytest.mark.asyncio
async def test_accepts_clock_formatted_highlight_timestamp():
    provider = FakeProvider([highlight_clock_timestamp_payload()])

    result = await StructuredAnalysisService(provider).analyze(
        source_segments(), "zh-Hans", duration_ms=100000
    )

    assert result.highlights[0].start_ms == 84000
    assert result.highlights[0].end_ms == 85000


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


@pytest.mark.asyncio
async def test_retries_when_chapter_title_repeats_summary_after_normalization():
    repeated = valid_payload()
    repeated["chapters"][0]["summary"] = " 基础结构。 "
    provider = FakeProvider([repeated, valid_payload()])

    result = await StructuredAnalysisService(provider).analyze(
        source_segments(), "zh-Hans", duration_ms=2000
    )

    assert result.chapters[0].summary == "从像素到权重"
    assert provider.calls == 2


@pytest.mark.asyncio
async def test_retries_when_highlight_title_repeats_summary_after_normalization():
    repeated = valid_payload()
    repeated["highlights"][0]["summary"] = " 权重。 "
    provider = FakeProvider([repeated, valid_payload()])

    result = await StructuredAnalysisService(provider).analyze(
        source_segments(), "zh-Hans", duration_ms=2000
    )

    assert result.highlights[0].summary == "权重决定连接强度"
    assert provider.calls == 2


@pytest.mark.asyncio
async def test_retries_temporary_provider_failures():
    provider = FakeProvider(
        [
            AnalysisGenerationError("analysis_unavailable", "offline"),
            AnalysisGenerationError("analysis_unavailable", "busy"),
            valid_payload(),
        ]
    )

    result = await StructuredAnalysisService(provider).analyze(
        source_segments(), "zh-Hans", duration_ms=2000
    )

    assert result.one_line_summary.startswith("视频解释")
    assert provider.calls == 3


@pytest.mark.asyncio
async def test_rejects_highlight_without_excerpts():
    invalid = valid_payload()
    invalid["highlights"][0].pop("original_excerpt")
    provider = FakeProvider([invalid, invalid, invalid])

    with pytest.raises(AnalysisGenerationError) as error:
        await StructuredAnalysisService(provider).analyze(
            source_segments(), "zh-Hans", duration_ms=2000
        )

    assert error.value.code == "analysis_invalid_response"
