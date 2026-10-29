from __future__ import annotations

import asyncio
import json
import ssl

import httpx
import pytest

from app.services.llm import LlmProviderError, OpenAICompatibleClient, normalize_provider_config


PROVIDERS = [
    ("kimi", "https://api.moonshot.cn/v1", "kimi-k2.5"),
    ("deepseek", "https://api.deepseek.com/v1", "deepseek-chat"),
    ("hunyuan", "https://tokenhub.tencentmaas.com/v1", "hy3"),
    ("qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"),
    ("glm", "https://open.bigmodel.cn/api/paas/v4", "glm-4.7-flash"),
]


@pytest.mark.parametrize("provider,base,model", PROVIDERS)
@pytest.mark.parametrize("url_form", ["origin", "base", "completion", "slash", "443"])
def test_config_uses_selected_official_endpoint(provider, base, model, url_form):
    origin = "/".join(base.split("/")[:3])
    supplied = {
        "origin": origin,
        "base": base,
        "completion": base + "/chat/completions",
        "slash": base + "/chat/completions/",
        "443": base.replace(origin, origin + ":443"),
    }[url_form]
    config = normalize_provider_config(provider, supplied, "test-secret")
    assert config.api_url == base + "/chat/completions"
    assert config.model == model


@pytest.mark.parametrize("url", [
    "https://relay.example/v1", "http://api.moonshot.cn/v1",
    "http://127.0.0.1/v1", "https://127.0.0.1/v1", "https://localhost/v1",
    "https://10.0.0.1/v1", "https://169.254.169.254/latest/meta-data",
    "https://[::1]/v1", "https://[::ffff:127.0.0.1]/v1",
    "https://api.moonshot.cn:8443/v1", "https://api.moonshot.cn:80/v1",
    "https://user:pass@api.moonshot.cn/v1", "https://@api.moonshot.cn/v1",
    "https://api.moonshot.cn/v1?key=test-secret", "https://api.moonshot.cn/v1?",
    "https://api.moonshot.cn/v1#fragment", "https://api.moonshot.cn/v1#",
    "https://api.moonshot.cn/other", "https://api.moonshot.cn/v1/../v1",
    "https://api.moonshot.cn//v1", "https://api.moonshot.cn/%76%31",
    "https://api.moonshot.cn.evil.test/v1", "https://api.moonshot.cn./v1",
    "https://api.deepseek.com/v1", "https://api.moonshot.cn\\@evil.test/v1",
    "https://api.moonshot.cn/v1\n", " https://api.moonshot.cn/v1",
    "https://api.moonshot.cn:/v1", "https://api.moonshot.cn:0443/v1",
    "https://[api.moonshot.cn/v1", "https://", "not-a-url", "",
])
def test_config_rejects_destinations_outside_selected_official_provider(url):
    with pytest.raises(ValueError, match="官方"):
        normalize_provider_config("kimi", url, "test-secret")


def test_retired_hunyuan_endpoint_is_not_silently_migrated():
    with pytest.raises(ValueError, match="官方"):
        normalize_provider_config("hunyuan", "https://api.hunyuan.cloud.tencent.com/v1", "old-secret")


@pytest.mark.parametrize("provider,base,_model", PROVIDERS)
def test_official_provider_allows_user_model_ids(provider, base, _model):
    assert normalize_provider_config(provider, base, "secret", "custom-model-2027").model == "custom-model-2027"


def completion_response(content='{"ok":true}', status=200):
    return httpx.Response(status, json={"choices": [{"message": {"role": "assistant", "content": content}, "finish_reason": "stop"}]})


@pytest.mark.asyncio
@pytest.mark.parametrize("addresses", [
    [], ["127.0.0.1"], ["10.1.2.3"], ["169.254.169.254"], ["0.0.0.0"],
    ["224.0.0.1"], ["100.64.0.1"], ["192.0.2.1"], ["::1"], ["fc00::1"],
    ["fe80::1"], ["ff02::1"], ["::ffff:127.0.0.1"], ["::ffff:10.0.0.1"],
    ["8.8.8.8", "127.0.0.1"], ["2606:4700:4700::1111", "::1"], ["invalid"],
    ["fec0::1"], ["100:0:0:1::1"], ["64:ff9b::a00:1"], ["2002:a00:1::1"],
    ["2002::a00:1"], ["2606:4700:4700::1111%en0"],
])
async def test_dns_rejects_every_nonpublic_answer_before_sending(addresses):
    sent = []
    client = OpenAICompatibleClient(
        PROVIDERS[0][1], "secret", resolver=lambda _: addresses,
        inner_transport=httpx.MockTransport(lambda req: sent.append(req) or completion_response()),
    )
    with pytest.raises(LlmProviderError, match="safely"):
        await client.complete_json([{"role": "user", "content": "JSON please"}])
    assert sent == []


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,base,_model", PROVIDERS)
@pytest.mark.parametrize("ip,connected", [
    ("8.8.8.8", "8.8.8.8"),
    ("2606:4700:4700::1111", "2606:4700:4700::1111"),
    ("::ffff:8.8.8.8", "8.8.8.8"),
])
async def test_connection_is_pinned_with_official_host_and_sni(provider, base, _model, ip, connected):
    seen = []
    async def handler(request):
        seen.append(request)
        return completion_response()
    client = OpenAICompatibleClient(base, "secret", provider=provider,
        resolver=lambda _: [ip], inner_transport=httpx.MockTransport(handler))
    assert await client.complete_json([{"role": "user", "content": "JSON please"}]) == {"ok": True}
    request = seen[0]
    host = httpx.URL(base).host
    assert request.url.host == connected
    assert request.url.scheme == "https"
    assert request.url.path == httpx.URL(base).path + "/chat/completions"
    assert request.headers["host"] == host
    assert request.extensions["sni_hostname"] == host
    assert request.headers["authorization"] == "Bearer secret"


@pytest.mark.asyncio
async def test_dns_resolution_is_cancelled_within_the_connect_budget():
    cancelled = False
    sent = []

    async def resolver(_):
        nonlocal cancelled
        try:
            await asyncio.sleep(0.060)
        except asyncio.CancelledError:
            cancelled = True
            raise
        return ["8.8.8.8"]

    client = OpenAICompatibleClient(PROVIDERS[0][1], "secret-key", resolver=resolver,
        inner_transport=httpx.MockTransport(lambda request: sent.append(request) or completion_response()),
        timeout_seconds=0.005, max_attempts=1)
    with pytest.raises(LlmProviderError) as error:
        await asyncio.wait_for(client.complete([]), timeout=0.5)
    assert error.value.code == "llm_unavailable"
    assert "secret-key" not in str(error.value)
    assert cancelled
    assert not sent


@pytest.mark.asyncio
async def test_resolver_timeout_is_reported_as_sanitized_unavailable():
    async def resolver(_):
        raise TimeoutError("secret-key in resolver timeout")

    client = OpenAICompatibleClient(PROVIDERS[0][1], "secret-key", resolver=resolver,
        inner_transport=httpx.MockTransport(lambda _: pytest.fail("must not send")),
        max_attempts=1)
    with pytest.raises(LlmProviderError) as error:
        await client.complete([])
    assert error.value.code == "llm_unavailable"
    assert "secret-key" not in str(error.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [httpx.ConnectError, httpx.ConnectTimeout])
@pytest.mark.parametrize("addresses", [
    ["2606:4700:4700::1111", "8.8.8.8"],
    ["8.8.8.8", "2606:4700:4700::1111"],
])
async def test_connect_failure_tries_the_next_validated_address(failure, addresses):
    sent = []
    resolutions = []

    def handler(request):
        sent.append(request)
        if len(sent) == 1:
            raise failure("first address unavailable", request=request)
        return completion_response()

    client = OpenAICompatibleClient(PROVIDERS[0][1], "secret",
        resolver=lambda host: resolutions.append(host) or addresses,
        inner_transport=httpx.MockTransport(handler), max_attempts=1)
    assert await client.complete_json([]) == {"ok": True}
    assert [request.url.host for request in sent] == addresses
    assert resolutions == ["api.moonshot.cn"]
    for request in sent:
        assert request.url.scheme == "https"
        assert request.url.path == "/v1/chat/completions"
        assert request.headers["host"] == "api.moonshot.cn"
        assert request.extensions["sni_hostname"] == "api.moonshot.cn"
        assert request.headers["authorization"] == "Bearer secret"


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [
    httpx.ReadError, httpx.ReadTimeout, httpx.WriteError, httpx.WriteTimeout, httpx.RemoteProtocolError,
])
async def test_address_failover_never_replays_a_potentially_sent_request(failure):
    sent = []

    def handler(request):
        sent.append(request)
        raise failure("secret-key after connection", request=request)

    client = OpenAICompatibleClient(PROVIDERS[0][1], "secret-key",
        resolver=lambda _: ["8.8.8.8", "2606:4700:4700::1111"],
        inner_transport=httpx.MockTransport(handler), max_attempts=1)
    with pytest.raises(LlmProviderError) as error:
        await client.complete([])
    assert error.value.code == "llm_unavailable"
    assert "secret-key" not in str(error.value)
    assert len(sent) == 1


@pytest.mark.asyncio
async def test_dns_and_failover_share_connect_budget_without_changing_other_timeouts():
    from app.services.llm_security import build_llm_http_client
    budgets = []

    async def resolver(_):
        await asyncio.sleep(0.010)
        return ["2606:4700:4700::1111", "8.8.8.8"]

    async def handler(request):
        budgets.append(dict(request.extensions["timeout"]))
        if len(budgets) == 1:
            await asyncio.sleep(0.020)
            raise httpx.ConnectError("first address unavailable", request=request)
        return completion_response()

    async with build_llm_http_client("kimi", resolver=resolver, inner_transport=httpx.MockTransport(handler)) as client:
        response = await client.post(PROVIDERS[0][1] + "/chat/completions", json={},
            timeout=httpx.Timeout(connect=0.2, read=2, write=3, pool=4))
    assert response.status_code == 200
    assert len(budgets) == 2
    assert 0 < budgets[0]["connect"] < 0.1
    assert 0 < budgets[1]["connect"] < 0.17
    for budget in budgets:
        assert {key: value for key, value in budget.items() if key != "connect"} == {
            "read": 2, "write": 3, "pool": 4,
        }


@pytest.mark.asyncio
async def test_failover_does_not_apply_connect_budget_to_response_reading():
    from app.services.llm_security import build_llm_http_client

    async def handler(request):
        await asyncio.sleep(0.020)
        return completion_response()

    async with build_llm_http_client("kimi", resolver=lambda _: ["8.8.8.8"],
            inner_transport=httpx.MockTransport(handler)) as client:
        response = await client.post(PROVIDERS[0][1] + "/chat/completions", json={},
            timeout=httpx.Timeout(connect=0.005, read=1, write=1, pool=1))
    assert response.status_code == 200


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
async def test_redirects_never_receive_credentials(status):
    sent = []
    def handler(request):
        sent.append(request)
        return httpx.Response(status, headers={"location": "http://169.254.169.254/secret"})
    client = OpenAICompatibleClient(PROVIDERS[0][1], "secret", resolver=lambda _: ["8.8.8.8"],
        inner_transport=httpx.MockTransport(handler))
    with pytest.raises(LlmProviderError) as error:
        await client.complete([{"role": "user", "content": "hello"}])
    assert error.value.code == "llm_unsafe_destination"
    assert len(sent) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("first_result", ["timeout", "server_error"])
async def test_retry_revalidates_dns_and_blocks_rebinding(first_result):
    answers = iter([["8.8.8.8"], ["127.0.0.1"]])
    sent = []
    def handler(request):
        sent.append(request)
        if first_result == "timeout":
            raise httpx.ReadTimeout("temporary", request=request)
        return httpx.Response(503)
    client = OpenAICompatibleClient(PROVIDERS[0][1], "secret", resolver=lambda _: next(answers),
        inner_transport=httpx.MockTransport(handler), retry_delay_seconds=0)
    with pytest.raises(LlmProviderError) as error:
        await client.complete([{"role": "user", "content": "hello"}])
    assert error.value.code == "llm_unsafe_destination"
    assert len(sent) == 1


@pytest.mark.asyncio
async def test_dns_exception_cannot_leak_key():
    def resolver(_):
        raise RuntimeError("secret-key in a resolver exception")
    client = OpenAICompatibleClient(PROVIDERS[0][1], "secret-key", resolver=resolver,
        inner_transport=httpx.MockTransport(lambda _: pytest.fail("must not send")))
    with pytest.raises(LlmProviderError) as error:
        await client.complete([])
    assert "secret-key" not in str(error.value)


@pytest.mark.asyncio
async def test_network_exception_cannot_leak_key():
    def handler(request):
        raise httpx.ConnectError("secret-key in transport exception", request=request)
    client = OpenAICompatibleClient(PROVIDERS[0][1], "secret-key", resolver=lambda _: ["8.8.8.8"],
        inner_transport=httpx.MockTransport(handler), max_attempts=1)
    with pytest.raises(LlmProviderError) as error:
        await client.complete([])
    assert "secret-key" not in str(error.value)


@pytest.mark.asyncio
async def test_protected_factory_disables_proxy_redirects_and_verifies_tls(monkeypatch):
    from app.services.llm_security import build_llm_http_client
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:8080")
    monkeypatch.setenv("SSL_CERT_FILE", "/does/not/exist.pem")
    async with build_llm_http_client("kimi") as client:
        assert client.follow_redirects is False
        assert client.trust_env is False
        transport = client._transport._inner_transport
        assert isinstance(transport, httpx.AsyncHTTPTransport)
        assert transport._pool._ssl_context.verify_mode == ssl.CERT_REQUIRED
        assert transport._pool._ssl_context.check_hostname is True
        assert not client._mounts


@pytest.mark.parametrize("provider,base,_model", PROVIDERS)
def test_relay_config_is_rejected_by_worker_factory(provider, base, _model):
    from app.workers.tasks import build_llm_services
    with pytest.raises(ValueError, match="官方"):
        build_llm_services({"provider": provider, "api_url": "https://relay.example/v1", "api_key": "old-secret"})


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,base,model", PROVIDERS)
async def test_provider_specific_json_payload(provider, base, model):
    payloads = []
    def handler(request):
        payloads.append(json.loads(request.content))
        return completion_response()
    client = OpenAICompatibleClient(base, "secret", provider=provider,
        resolver=lambda _: ["8.8.8.8"], inner_transport=httpx.MockTransport(handler))
    await client.complete_json([{"role": "user", "content": "JSON please"}])
    payload = payloads[0]
    assert payload["model"] == model
    assert payload["response_format"] == {"type": "json_object"}
    if provider in {"kimi", "glm", "hunyuan"}:
        assert payload["thinking"] == {"type": "disabled"}
    else:
        assert "thinking" not in payload
    if provider == "qwen":
        assert payload["enable_thinking"] is False
    else:
        assert "enable_thinking" not in payload


@pytest.mark.asyncio
async def test_newer_glm_model_does_not_get_unsupported_thinking_disable():
    payloads = []
    client = OpenAICompatibleClient(PROVIDERS[4][1], "secret", provider="glm", model="glm-5.3",
        resolver=lambda _: ["8.8.8.8"], inner_transport=httpx.MockTransport(
            lambda req: payloads.append(json.loads(req.content)) or completion_response()))
    await client.complete_json([{"role": "user", "content": "JSON please"}])
    assert "thinking" not in payloads[0]


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,base,_model", PROVIDERS)
@pytest.mark.parametrize("message", [
    "response_format is not supported",
    "unsupported response_format; keep thinking disabled",
])
async def test_json_format_fallback_preserves_provider_thinking_controls(provider, base, _model, message):
    payloads = []

    def handler(request):
        payloads.append(json.loads(request.content))
        if len(payloads) == 1:
            return httpx.Response(400, json={"error": {"message": message}})
        return completion_response()

    client = OpenAICompatibleClient(base, "secret", provider=provider,
        resolver=lambda _: ["8.8.8.8"], inner_transport=httpx.MockTransport(handler))
    await client.test_connection()

    assert len(payloads) == 2
    expected = {key: value for key, value in payloads[0].items() if key != "response_format"}
    assert payloads[1] == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,base,parameter", [
    ("kimi", PROVIDERS[0][1], "thinking"),
    ("hunyuan", PROVIDERS[2][1], "thinking"),
    ("qwen", PROVIDERS[3][1], "enable_thinking"),
    ("glm", PROVIDERS[4][1], "thinking"),
])
async def test_json_fallback_removes_only_explicitly_unsupported_thinking(provider, base, parameter):
    payloads = []

    def handler(request):
        payloads.append(json.loads(request.content))
        if len(payloads) == 1:
            return httpx.Response(422, json={"error": {
                "code": "unsupported_parameter", "param": parameter, "message": "This model does not support this parameter",
            }})
        return completion_response()

    client = OpenAICompatibleClient(base, "secret", provider=provider,
        resolver=lambda _: ["8.8.8.8"], inner_transport=httpx.MockTransport(handler))
    await client.test_connection()

    assert len(payloads) == 2
    expected = {key: value for key, value in payloads[0].items() if key != parameter}
    assert payloads[1] == expected


@pytest.mark.asyncio
async def test_json_fallback_can_remove_separately_rejected_optional_fields():
    payloads = []

    def handler(request):
        payloads.append(json.loads(request.content))
        if len(payloads) <= 2:
            parameter = ["response_format", "thinking"][len(payloads) - 1]
            return httpx.Response(400, json={"error": {"message": f"unsupported {parameter}"}})
        return completion_response()

    client = OpenAICompatibleClient(PROVIDERS[0][1], "secret",
        resolver=lambda _: ["8.8.8.8"], inner_transport=httpx.MockTransport(handler))
    await client.test_connection()

    assert len(payloads) == 3
    assert "response_format" not in payloads[1]
    assert payloads[1]["thinking"] == {"type": "disabled"}
    assert "thinking" not in payloads[2]
    assert "response_format" not in payloads[2]


@pytest.mark.asyncio
@pytest.mark.parametrize("message", ["invalid messages", "unsupported model option", "enable_thinking must be false"])
async def test_json_fallback_does_not_retry_unrelated_request_rejections(message):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(400, json={"error": {"message": message}})

    client = OpenAICompatibleClient(PROVIDERS[0][1], "secret",
        resolver=lambda _: ["8.8.8.8"], inner_transport=httpx.MockTransport(handler))
    with pytest.raises(LlmProviderError) as error:
        await client.test_connection()
    assert error.value.code == "llm_request_rejected"
    assert len(requests) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,base,_model", PROVIDERS)
async def test_connection_probe_requests_and_validates_small_json_object(provider, base, _model):
    payloads = []
    client = OpenAICompatibleClient(base, "secret", provider=provider,
        resolver=lambda _: ["8.8.8.8"], inner_transport=httpx.MockTransport(
            lambda req: payloads.append(json.loads(req.content)) or completion_response()))
    await client.test_connection()
    assert payloads[0]["response_format"] == {"type": "json_object"}
    assert 0 < payloads[0]["max_tokens"] <= 256
    assert "json" in json.dumps(payloads[0]["messages"]).lower()
    assert "ok" in json.dumps(payloads[0]["messages"]).lower()


@pytest.mark.asyncio
@pytest.mark.parametrize("content", [
    "OK", '{"ok":false}', '{"ok":1}', '{"ok":"true"}', '{}', '[]',
    'Here is the result: {"ok":true}', '{"ok":true} trailing junk',
    '```json\n{"ok":true}\n```', '{"ok":true}{"ok":false}',
    '[{"ok":true}]', '{"ok":true,"extra":NaN}',
])
async def test_connection_probe_rejects_non_success_objects(content):
    client = OpenAICompatibleClient(PROVIDERS[0][1], "secret", resolver=lambda _: ["8.8.8.8"],
        inner_transport=httpx.MockTransport(lambda _: completion_response(content)))
    with pytest.raises(LlmProviderError) as error:
        await client.test_connection()
    assert error.value.code == "llm_invalid_response"


@pytest.mark.asyncio
async def test_connection_probe_accepts_json_surrounded_only_by_whitespace():
    client = OpenAICompatibleClient(PROVIDERS[0][1], "secret", resolver=lambda _: ["8.8.8.8"],
        inner_transport=httpx.MockTransport(lambda _: completion_response(' \n {"ok":true} \t ')))
    await client.test_connection()


@pytest.mark.asyncio
@pytest.mark.parametrize("status,code", [(401, "llm_authentication_failed"), (403, "llm_authentication_failed"), (404, "llm_model_unavailable")])
async def test_probe_reports_auth_and_model_errors_without_keys(status, code):
    client = OpenAICompatibleClient(PROVIDERS[0][1], "secret", resolver=lambda _: ["8.8.8.8"],
        inner_transport=httpx.MockTransport(lambda _: httpx.Response(status, json={"error": {"code": "model_not_found", "message": "bad secret"}})))
    with pytest.raises(LlmProviderError) as error:
        await client.test_connection()
    assert error.value.code == code
    assert "secret" not in str(error.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("error_body", [
    {"code": "model_not_found", "message": "unknown secret"},
    {"code": "InvalidParameter", "message": "model does not exist: secret"},
])
async def test_model_rejection_does_not_retry_as_format_fallback(error_body):
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(400, json={"error": error_body})
    client = OpenAICompatibleClient(PROVIDERS[0][1], "secret", resolver=lambda _: ["8.8.8.8"],
        inner_transport=httpx.MockTransport(handler))
    with pytest.raises(LlmProviderError) as error:
        await client.test_connection()
    assert error.value.code == "llm_model_unavailable"
    assert len(requests) == 1
    assert "secret" not in str(error.value)
