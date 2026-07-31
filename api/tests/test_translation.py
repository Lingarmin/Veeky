from __future__ import annotations

import pytest

from app.services.translation import (
    CachedTranslationService,
    LibreTranslateProvider,
    TranslationProviderError,
    TranslationSegment,
)


class FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = str(self._payload)

    def json(self):
        return self._payload


class FakeHttpClient:
    def __init__(self, responses=None):
        self.responses = list(responses or [])
        self.requests = []

    async def post(self, url, json, timeout):
        self.requests.append({"url": url, "json": json, "timeout": timeout})
        if self.responses:
            response = self.responses.pop(0)
            if isinstance(response, Exception):
                raise response
            return response
        return FakeResponse(200, {"translatedText": [f"ZH:{text}" for text in json["q"]]})


class MemoryCache:
    def __init__(self):
        self.values = {}

    async def get(self, key):
        return self.values.get(key)

    async def put(self, key, value):
        self.values[key] = value


def segments(*texts):
    return [
        TranslationSegment(str(index), index * 1000, 900, text)
        for index, text in enumerate(texts)
    ]


@pytest.mark.asyncio
async def test_batches_without_splitting_segments_and_preserves_ids():
    client = FakeHttpClient()
    provider = LibreTranslateProvider("http://translate:5000", client=client, max_batch_chars=10)

    result = await provider.translate(segments("123456", "abcdef", "xy"), "en", "zh")

    assert [request["json"]["q"] for request in client.requests] == [["123456"], ["abcdef", "xy"]]
    assert [item.segment_id for item in result] == ["0", "1", "2"]
    assert [item.text for item in result] == ["ZH:123456", "ZH:abcdef", "ZH:xy"]
    assert result[1].start_ms == 1000


@pytest.mark.asyncio
async def test_retries_network_and_server_errors_at_most_three_times():
    import httpx

    client = FakeHttpClient(
        [
            httpx.ConnectError("offline"),
            FakeResponse(503, {"error": "busy"}),
            FakeResponse(200, {"translatedText": ["你好"]}),
        ]
    )
    sleeps = []

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    provider = LibreTranslateProvider(
        "http://translate:5000", client=client, sleep=fake_sleep, max_attempts=3
    )
    result = await provider.translate(segments("Hello"), "en", "zh")

    assert result[0].text == "你好"
    assert len(client.requests) == 3
    assert sleeps == [0.25, 0.5]


@pytest.mark.asyncio
async def test_client_error_is_not_retried():
    client = FakeHttpClient([FakeResponse(400, {"error": "bad language"})])
    provider = LibreTranslateProvider("http://translate:5000", client=client)

    with pytest.raises(TranslationProviderError) as error:
        await provider.translate(segments("Hello"), "en", "xx")

    assert error.value.code == "translation_rejected"
    assert len(client.requests) == 1


@pytest.mark.asyncio
async def test_missing_translated_segment_fails_the_batch():
    client = FakeHttpClient([FakeResponse(200, {"translatedText": ["只有一段"]})])
    provider = LibreTranslateProvider("http://translate:5000", client=client)

    with pytest.raises(TranslationProviderError) as error:
        await provider.translate(segments("One", "Two"), "en", "zh")

    assert error.value.code == "translation_response_mismatch"


@pytest.mark.asyncio
async def test_cache_hit_does_not_call_provider():
    client = FakeHttpClient()
    provider = LibreTranslateProvider("http://translate:5000", client=client)
    cache = MemoryCache()
    service = CachedTranslationService(provider, cache)
    source = segments("Hello")

    first = await service.translate("track-1", source, "en", "zh", "sha256:abc")
    second = await service.translate("track-1", source, "en", "zh", "sha256:abc")

    assert second == first
    assert len(client.requests) == 1
