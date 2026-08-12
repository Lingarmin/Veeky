from __future__ import annotations

import json

import httpx
import pytest

from app.services.llm import (
    DeepSeekClient,
    KimiClient,
    KimiProviderError,
    normalize_chat_completions_url,
    normalize_provider_config,
)
from app.services.translation import TranslationSegment
from app.services.translation import (
    KimiTranslationProvider,
    LlmTranslationProvider,
    kimi_translation_version,
    provider_translation_version,
)
from app.services.analysis import AnalysisSegment, KimiAnalysisProvider


def test_normalizes_kimi_base_and_completion_urls():
    assert normalize_chat_completions_url("https://api.example.com/v1") == (
        "https://api.example.com/v1/chat/completions"
    )
    assert normalize_chat_completions_url(
        "https://api.example.com/v1/chat/completions/"
    ) == "https://api.example.com/v1/chat/completions"


def test_deepseek_client_uses_deepseek_defaults():
    client = DeepSeekClient("https://api.deepseek.com/v1", "secret-key")
    assert client.provider == "deepseek"
    assert client.model == "deepseek-chat"


def test_normalizes_known_deepseek_model_names_to_api_casing():
    config = normalize_provider_config(
        "deepseek",
        "https://api.deepseek.com/v1",
        "secret-key",
        "DeepSeek-V4-Flash",
    )

    assert config.model == "deepseek-v4-flash"


@pytest.mark.asyncio
async def test_kimi_client_returns_json_content():
    request_body = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        request_body.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "choices": [
                    {"message": {"content": '{"ok": true}'}}
                ]
            },
        )

    client = KimiClient(
        "https://api.example.com/v1",
        "secret-key",
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )

    result = await client.complete_json([{"role": "user", "content": "ping"}])

    assert result == {"ok": True}
    assert request_body["model"] == "kimi-k2.5"
    assert request_body["response_format"] == {"type": "json_object"}
    assert request_body["thinking"] == {"type": "disabled"}


@pytest.mark.asyncio
async def test_llm_client_retries_a_transient_timeout():
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise httpx.ReadTimeout("upstream timed out", request=request)
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "OK"}}]},
        )

    client = KimiClient(
        "https://api.example.com/v1",
        "secret-key",
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        max_attempts=2,
        retry_delay_seconds=0,
    )

    assert await client.complete([{"role": "user", "content": "ping"}]) == "OK"
    assert calls == 2


def test_llm_client_uses_a_timeout_that_covers_long_json_requests():
    client = KimiClient("https://api.example.com/v1", "secret-key")

    assert client.timeout_seconds == 180


@pytest.mark.asyncio
async def test_llm_client_accepts_content_parts_from_compatible_gateway():
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": [{"type": "text", "text": "OK"}]}}]},
        )

    client = KimiClient(
        "https://api.example.com/v1",
        "secret-key",
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    assert await client.complete([{"role": "user", "content": "ping"}]) == "OK"


@pytest.mark.asyncio
async def test_llm_client_uses_reasoning_content_when_gateway_leaves_content_empty():
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "", "reasoning_content": '{"ok": true}'}}]},
        )

    client = KimiClient(
        "https://api.example.com/v1",
        "secret-key",
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    assert await client.complete_json([{"role": "user", "content": "ping"}]) == {"ok": True}


@pytest.mark.asyncio
async def test_kimi_client_redacts_key_and_maps_auth_failure():
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="invalid secret-key")

    client = KimiClient(
        "https://api.example.com/v1",
        "secret-key",
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )

    with pytest.raises(KimiProviderError) as error:
        await client.complete([{"role": "user", "content": "ping"}])

    assert error.value.code == "llm_authentication_failed"
    assert "secret-key" not in str(error.value)


@pytest.mark.asyncio
async def test_kimi_client_includes_sanitized_provider_rejection_detail():
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={"error": {"message": "context length exceeded", "type": "invalid_request_error"}},
        )

    client = KimiClient(
        "https://api.example.com/v1",
        "secret-key",
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )

    with pytest.raises(KimiProviderError) as error:
        await client.complete([{"role": "user", "content": "ping"}])

    assert error.value.code == "llm_request_rejected"
    assert "context length exceeded" in str(error.value)
    assert "secret-key" not in str(error.value)


@pytest.mark.asyncio
async def test_kimi_client_honors_retry_after_when_rate_limited(monkeypatch):
    calls = 0
    sleeps = []

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(
                429,
                headers={"Retry-After": "7"},
                json={"error": {"message": "rate limit"}},
            )
        return httpx.Response(200, json={"choices": [{"message": {"content": "OK"}}]})

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr("app.services.llm.asyncio.sleep", fake_sleep)
    client = KimiClient(
        "https://api.example.com/v1",
        "secret-key",
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        max_attempts=2,
        retry_delay_seconds=0,
    )

    assert await client.complete([{"role": "user", "content": "ping"}]) == "OK"
    assert calls == 2
    assert sleeps == [7.0]


@pytest.mark.asyncio
async def test_kimi_client_maps_insufficient_balance_without_retrying_or_exposing_account_ids():
    calls = 0

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            429,
            json={
                "error": {
                    "message": (
                        "Your account org-private <ak-private> is suspended due to "
                        "insufficient balance, please recharge your account"
                    )
                }
            },
        )

    client = KimiClient(
        "https://api.example.com/v1",
        "secret-key",
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )

    with pytest.raises(KimiProviderError) as error:
        await client.complete([{"role": "user", "content": "ping"}])

    assert error.value.code == "llm_quota_exhausted"
    assert "余额不足" in str(error.value)
    assert "org-private" not in str(error.value)
    assert "ak-private" not in str(error.value)
    assert calls == 1


@pytest.mark.asyncio
async def test_kimi_client_falls_back_when_gateway_rejects_json_format():
    response_formats = []

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        response_formats.append(body.get("response_format"))
        if len(response_formats) == 1:
            return httpx.Response(400, json={"error": {"message": "unsupported response_format"}})
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"ok": true}'}}]})

    client = KimiClient(
        "https://api.example.com/v1",
        "secret-key",
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )

    assert await client.complete_json([{"role": "user", "content": "ping"}]) == {"ok": True}
    assert response_formats == [{"type": "json_object"}, None]


@pytest.mark.asyncio
async def test_llm_client_extracts_json_from_markdown_and_leading_text():
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": 'Here is the result:\n```json\n{"ok": true}\n```'
                        }
                    }
                ]
            },
        )

    client = DeepSeekClient(
        "https://api.example.com/v1",
        "secret-key",
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )

    assert await client.complete_json([{"role": "user", "content": "ping"}]) == {"ok": True}


@pytest.mark.asyncio
async def test_kimi_translation_provider_preserves_segment_order():
    calls = []

    class FakeClient:
        name = "kimi"
        async def complete_json(self, messages):
            calls.append(messages)
            return {"translations": [{"segment_id": "two", "text": "二"}, {"segment_id": "one", "text": "一"}]}

    provider = KimiTranslationProvider(FakeClient())
    translated = await provider.translate(
        [
            TranslationSegment("one", 0, 1000, "One"),
            TranslationSegment("two", 1000, 1000, "Two"),
        ],
        "en",
        "zh-Hans",
    )

    assert [item.text for item in translated] == ["一", "二"]
    assert calls


def test_kimi_translation_uses_larger_parallel_batches_for_long_videos():
    class FakeClient:
        provider = "kimi"
        model = "kimi-k2.5"
        url = "https://api.example.com/v1/chat/completions"

    provider = KimiTranslationProvider(FakeClient())

    assert provider.max_batch_chars == 3000
    assert provider.max_concurrency == 3


@pytest.mark.asyncio
async def test_llm_translation_splits_a_batch_when_the_model_omits_segments():
    class IncompleteThenCompleteClient:
        provider = "kimi"
        model = "kimi-k2.5"
        url = "https://api.example.com/v1/chat/completions"

        def __init__(self):
            self.calls = 0

        async def complete_json(self, messages):
            self.calls += 1
            request = json.loads(messages[-1]["content"])
            items = request["segments"]
            if len(items) > 1:
                return {"translations": [{"segment_id": items[0]["segment_id"], "text": "只返回一段"}]}
            return {"translations": [{"segment_id": items[0]["segment_id"], "text": f"ZH:{items[0]['text']}"}]}

    client = IncompleteThenCompleteClient()
    provider = KimiTranslationProvider(client, max_batch_chars=100)

    translated = await provider.translate(
        [
            TranslationSegment("one", 0, 1000, "One"),
            TranslationSegment("two", 1000, 1000, "Two"),
        ],
        "en",
        "zh-Hans",
    )

    assert [item.text for item in translated] == ["ZH:One", "ZH:Two"]
    assert client.calls == 3


@pytest.mark.asyncio
async def test_llm_translation_maps_a_singleton_without_segment_id():
    class SingletonClient:
        provider = "deepseek"
        model = "deepseek-v4-flash"
        url = "https://api.example.com/v1/chat/completions"

        async def complete_json(self, _messages):
            return {"translations": [{"text": "只有这一段译文"}]}

    provider = LlmTranslationProvider(SingletonClient())
    translated = await provider.translate(
        [TranslationSegment("one", 0, 1000, "Only this segment")],
        "en",
        "zh-Hans",
    )

    assert translated[0].segment_id == "one"
    assert translated[0].text == "只有这一段译文"


@pytest.mark.asyncio
async def test_llm_translation_accepts_common_translation_field_alias():
    class AliasClient:
        provider = "deepseek"
        model = "deepseek-v4-flash"
        url = "https://api.example.com/v1/chat/completions"

        async def complete_json(self, _messages):
            return {"translations": [{"translation": "别名译文"}]}

    provider = LlmTranslationProvider(AliasClient())
    translated = await provider.translate(
        [TranslationSegment("one", 0, 1000, "Only this segment")],
        "en",
        "zh-Hans",
    )

    assert translated[0].text == "别名译文"


def test_kimi_translation_cache_version_includes_endpoint():
    first = KimiTranslationProvider(KimiClient("https://one.example/v1", "key"))
    second = KimiTranslationProvider(KimiClient("https://two.example/v1", "key"))

    assert first.version != second.version
    assert len(first.version) <= 80
    assert first.version == kimi_translation_version("https://one.example/v1/chat/completions")
    assert provider_translation_version("https://one.example/v1/chat/completions", provider="deepseek", version="deepseek-chat") != first.version


@pytest.mark.asyncio
async def test_kimi_analysis_provider_sends_timestamped_transcript():
    class FakeClient:
        async def complete_json(self, messages):
            assert "one" in messages[-1]["content"]
            return {
                "one_line_summary": "总结",
                "summary_points": ["一", "二", "三"],
                "chapters": [{"start_ms": 0, "end_ms": 1000, "title": "开头", "summary": "介绍"}],
                "highlights": [],
            }

    provider = KimiAnalysisProvider(FakeClient())
    result = await provider.analyze([AnalysisSegment("one", 0, 1000, "One", "一")], "zh-Hans")

    assert result["one_line_summary"] == "总结"


@pytest.mark.asyncio
async def test_analysis_prompt_requires_complementary_titles_and_summaries():
    captured = []

    class FakeClient:
        provider = "deepseek"
        model = "deepseek-v4-flash"

        async def complete_json(self, messages):
            captured.extend(messages)
            return {
                "one_line_summary": "总结",
                "summary_points": ["一", "二", "三"],
                "chapters": [
                    {
                        "start_ms": 0,
                        "end_ms": 1000,
                        "title": "设计方向",
                        "summary": "作者演示了如何从参考界面整理情绪板。",
                    }
                ],
                "highlights": [],
            }

    provider = KimiAnalysisProvider(FakeClient())
    await provider.analyze(
        [AnalysisSegment("one", 0, 1000, "Collect references", "收集参考")],
        "zh-Hans",
    )

    system_prompt = captured[0]["content"]
    assert "title names the topic" in system_prompt
    assert "summary adds specific actions, evidence, or conclusions" in system_prompt
    assert "must not repeat" in system_prompt


@pytest.mark.asyncio
async def test_kimi_analysis_provider_splits_long_transcripts_before_requesting_model():
    calls = []

    class FakeClient:
        provider = "kimi"
        model = "kimi-k2.5"

        async def complete_json(self, messages):
            calls.append(json.loads(messages[-1]["content"]))
            return {
                "one_line_summary": "分段总结",
                "summary_points": ["一", "二", "三"],
                "chapters": [
                    {
                        "start_ms": 0,
                        "end_ms": 1000,
                        "title": "片段主题",
                        "summary": "概括当前字幕窗口的具体内容",
                    }
                ],
                "highlights": [],
            }

    provider = KimiAnalysisProvider(FakeClient(), max_input_chars=240)
    segments = [
        AnalysisSegment(str(index), index * 1000, 1000, "这是一段较长的字幕文本" * 3)
        for index in range(4)
    ]

    result = await provider.analyze(segments, "zh-Hans")

    assert result["one_line_summary"]
    assert len(calls) >= 2
    assert all(len(json.dumps(call, ensure_ascii=False)) <= 240 for call in calls)
