from __future__ import annotations

import asyncio
import inspect
import ipaddress
import socket
from collections.abc import Awaitable, Callable, Iterable
from urllib.parse import urlsplit


class UnsafeMediaUrl(ValueError):
    """Raised when a media URL cannot be fetched without SSRF risk."""


ResolvedAddresses = Iterable[str]
ResolverResult = ResolvedAddresses | Awaitable[ResolvedAddresses]
Resolver = Callable[[str], ResolverResult]


async def _resolve_public_addresses(hostname: str) -> list[str]:
    loop = asyncio.get_running_loop()
    answers = await loop.getaddrinfo(
        hostname,
        443,
        type=socket.SOCK_STREAM,
        proto=socket.IPPROTO_TCP,
    )
    return list({answer[4][0] for answer in answers})


async def validate_x_media_url(
    url: str,
    *,
    resolver: Resolver | None = None,
) -> None:
    try:
        parsed = urlsplit(url)
        port = parsed.port
        username = parsed.username
        password = parsed.password
    except (TypeError, ValueError) as error:
        raise UnsafeMediaUrl("media URL is not allowed") from error

    if (
        parsed.scheme != "https"
        or parsed.hostname != "video.twimg.com"
        or port not in (None, 443)
        or username is not None
        or password is not None
        or parsed.fragment
    ):
        raise UnsafeMediaUrl("media URL is not allowed")

    resolve = resolver or _resolve_public_addresses
    try:
        result = resolve(parsed.hostname)
        raw_addresses = await result if inspect.isawaitable(result) else result
        addresses = list(raw_addresses)
    except Exception as error:
        raise UnsafeMediaUrl("media host could not be safely resolved") from error

    if not addresses:
        raise UnsafeMediaUrl("media host could not be safely resolved")

    for raw_address in addresses:
        try:
            address = ipaddress.ip_address(raw_address)
        except ValueError as error:
            raise UnsafeMediaUrl("media host could not be safely resolved") from error
        if (
            address.is_loopback
            or address.is_private
            or address.is_link_local
            or address.is_multicast
            or address.is_reserved
            or address.is_unspecified
        ):
            raise UnsafeMediaUrl("media host resolved to a disallowed address")

