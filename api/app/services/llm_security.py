"""SSRF-safe, direct HTTPS transport for the fixed official LLM registry."""
from __future__ import annotations

import asyncio
import inspect
import ipaddress
import socket
from collections.abc import Awaitable, Callable, Iterable

import httpx

from app.services.llm_providers import LLM_PROVIDERS, official_completion_url


Resolver = Callable[[str], Iterable[str] | Awaitable[Iterable[str]]]
IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address


class UnsafeLlmDestination(ValueError):
    """A destination cannot safely receive provider credentials."""


async def _resolve_addresses(hostname: str) -> list[str]:
    answers = await asyncio.get_running_loop().getaddrinfo(
        hostname, 443, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP,
    )
    return list(dict.fromkeys(answer[4][0] for answer in answers))


async def validate_llm_addresses(hostname: str, *, resolver: Resolver | None = None) -> tuple[IPAddress, ...]:
    try:
        result = (resolver or _resolve_addresses)(hostname)
        raw_addresses = list(await result if inspect.isawaitable(result) else result)
        if not raw_addresses:
            raise ValueError("empty DNS answer")
        addresses = []
        for raw in raw_addresses:
            if not isinstance(raw, str) or "%" in raw:
                raise ValueError("invalid DNS address")
            address = ipaddress.ip_address(raw)
            if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
                address = address.ipv4_mapped
            if (
                not address.is_global or address.is_multicast or address.is_reserved
                or address.is_loopback or address.is_link_local or address.is_unspecified
                or (isinstance(address, ipaddress.IPv6Address) and (
                    address.is_site_local or address.sixtofour is not None or address.teredo is not None
                ))
            ):
                raise ValueError("non-public DNS answer")
            if address not in addresses:
                addresses.append(address)
        return tuple(addresses)
    except (TimeoutError, httpx.ConnectTimeout):
        raise httpx.ConnectTimeout("LLM destination resolution timed out") from None
    except Exception:
        # Resolver errors can contain configuration/credential material.
        raise UnsafeLlmDestination("LLM destination could not be safely resolved") from None


class PinnedLlmTransport(httpx.AsyncBaseTransport):
    def __init__(
        self, provider: str, *, resolver: Resolver | None = None,
        inner_transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._endpoint = LLM_PROVIDERS[provider].endpoint
        self._provider = provider
        self._resolver = resolver
        self._inner_transport = inner_transport or httpx.AsyncHTTPTransport(
            verify=True, trust_env=False, retries=0,
        )

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        try:
            endpoint = official_completion_url(self._provider, str(request.url))
        except ValueError:
            raise UnsafeLlmDestination("LLM destination cannot be safely requested") from None
        if str(request.url) != endpoint or endpoint != self._endpoint:
            raise UnsafeLlmDestination("LLM destination cannot be safely requested")
        # DNS and address attempts share the configured connection budget.
        # Validate the complete answer set before any address receives a request.
        timeouts = dict(request.extensions.get("timeout", {}))
        connect_timeout = timeouts.get("connect")
        loop = asyncio.get_running_loop()
        deadline = None if connect_timeout is None else loop.time() + connect_timeout
        try:
            addresses = await asyncio.wait_for(
                validate_llm_addresses(request.url.host, resolver=self._resolver),
                timeout=connect_timeout,
            )
        except TimeoutError:
            raise httpx.ConnectTimeout("LLM destination resolution timed out", request=request) from None
        headers = request.headers.copy()
        headers["Host"] = request.url.host
        for index, address in enumerate(addresses):
            extensions = dict(request.extensions)
            extensions["sni_hostname"] = request.url.host
            if deadline is not None:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    raise httpx.ConnectTimeout("LLM connection budget exhausted", request=request)
                # Reserve a share for each remaining candidate, including when
                # the first (often IPv6) address times out instead of refusing.
                extensions["timeout"] = {
                    **timeouts, "connect": remaining / (len(addresses) - index),
                }
            pinned_request = httpx.Request(
                method=request.method,
                url=request.url.copy_with(host=address.compressed),
                headers=headers, stream=request.stream, extensions=extensions,
            )
            try:
                response = await self._inner_transport.handle_async_request(pinned_request)
            except (httpx.ConnectError, httpx.ConnectTimeout):
                # These failures occur before HTTP request transmission. Never
                # replay on read/write/protocol errors or upstream responses.
                if index + 1 == len(addresses):
                    raise
                continue
            if 300 <= response.status_code < 400:
                await response.aclose()
                raise UnsafeLlmDestination("LLM redirect cannot be safely followed")
            return response

    async def aclose(self) -> None:
        await self._inner_transport.aclose()


def build_llm_http_client(
    provider: str, *, resolver: Resolver | None = None,
    inner_transport: httpx.AsyncBaseTransport | None = None,
) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=PinnedLlmTransport(provider, resolver=resolver, inner_transport=inner_transport),
        trust_env=False, follow_redirects=False,
    )
