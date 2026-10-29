"""Resolve the network peer without trusting client-supplied forwarding headers."""

from __future__ import annotations

import hashlib
import ipaddress

from fastapi import HTTPException, Request

from app.core.settings import Settings


def client_quota_subject(request: Request, settings: Settings) -> str:
    def address(value):
        parsed = ipaddress.ip_address(value)
        return getattr(parsed, "ipv4_mapped", None) or parsed

    try:
        peer = address(request.client.host if request.client else "")
    except ValueError as error:
        raise HTTPException(
            503,
            detail={
                "code": "client_address_unavailable",
                "message": "无法确认请求来源，请稍后重试。",
            },
        ) from error
    networks = [ipaddress.ip_network(value) for value in settings.trusted_proxy_cidrs]

    def trusted(ip):
        return any(ip in network for network in networks)

    if trusted(peer):
        forwarded = request.headers.get("x-forwarded-for", "")
        if not forwarded or len(forwarded) > 2048:
            raise HTTPException(
                400,
                detail={
                    "code": "invalid_forwarded_address",
                    "message": "代理未提供有效客户端地址。",
                },
            )
        try:
            chain = [address(value.strip()) for value in forwarded.split(",")]
        except ValueError as error:
            raise HTTPException(
                400,
                detail={
                    "code": "invalid_forwarded_address",
                    "message": "代理客户端地址无效。",
                },
            ) from error
        for candidate in reversed(chain):
            if not trusted(peer):
                break
            peer = candidate
    # Rotating privacy addresses in one IPv6 subnet must not reset quotas.
    identity = (
        str(ipaddress.ip_network(f"{peer}/64", strict=False))
        if peer.version == 6
        else str(peer)
    )
    return hashlib.sha256(f"veeky:network:v1:{identity}".encode()).hexdigest()
