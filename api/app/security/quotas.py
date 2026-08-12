from __future__ import annotations

import math
import time
import uuid
from collections.abc import Callable
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import Protocol

import redis.asyncio as redis
from fastapi import Depends

from app.core.settings import Settings, get_settings


_WINDOW_MILLISECONDS = 60_000
_RATE_LIMIT_SCRIPT = """
local key = KEYS[1]
local cutoff = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local member = ARGV[3]
local limit = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
local count = redis.call('ZCARD', key)
if count >= limit then
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    redis.call('PEXPIRE', key, ttl)
    return {0, tonumber(oldest[2])}
end

redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, ttl)
return {1, now}
"""
_LOCK_RELEASE_SCRIPT = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
"""


class AsyncRedis(Protocol):
    async def eval(self, script: str, numkeys: int, *keys_and_args): ...

    async def set(self, key: str, value: str, *, nx: bool, px: int): ...


class RateLimitExceeded(RuntimeError):
    def __init__(self, retry_after: int):
        super().__init__("rate limit exceeded")
        self.retry_after = retry_after


class QuotaServiceUnavailable(RuntimeError):
    pass


class InstallationLockUnavailable(RuntimeError):
    pass


class RedisQuotaLimiter:
    def __init__(
        self,
        client: AsyncRedis,
        *,
        clock: Callable[[], float] = time.time,
    ):
        self.client = client
        self.clock = clock

    async def enforce(self, subject: str, request_class: str, limit: int) -> None:
        now_ms = int(self.clock() * 1000)
        key = f"veeky:quota:{request_class}:{subject}"
        member = f"{now_ms}:{uuid.uuid4().hex}"
        try:
            allowed, oldest_ms = await self.client.eval(
                _RATE_LIMIT_SCRIPT,
                1,
                key,
                now_ms - _WINDOW_MILLISECONDS,
                now_ms,
                member,
                limit,
                _WINDOW_MILLISECONDS + 1000,
            )
        except Exception as error:
            raise QuotaServiceUnavailable("quota storage unavailable") from error
        if int(allowed) == 1:
            return
        retry_ms = int(oldest_ms) + _WINDOW_MILLISECONDS - now_ms
        raise RateLimitExceeded(max(1, math.ceil(retry_ms / 1000)))

    @asynccontextmanager
    async def installation_create_lock(self, installation_id: str):
        key = f"veeky:lock:analysis-create:{installation_id}"
        owner = uuid.uuid4().hex
        try:
            acquired = await self.client.set(key, owner, nx=True, px=5000)
        except Exception as error:
            raise QuotaServiceUnavailable("quota storage unavailable") from error
        if not acquired:
            raise InstallationLockUnavailable("analysis creation is already locked")
        try:
            yield
        finally:
            try:
                await self.client.eval(_LOCK_RELEASE_SCRIPT, 1, key, owner)
            except Exception as error:
                raise QuotaServiceUnavailable("quota storage unavailable") from error


@lru_cache
def _limiter_for_url(redis_url: str) -> RedisQuotaLimiter:
    return RedisQuotaLimiter(redis.from_url(redis_url, decode_responses=True))


def get_quota_limiter(
    settings: Settings = Depends(get_settings),
) -> RedisQuotaLimiter:
    return _limiter_for_url(settings.redis_url)
