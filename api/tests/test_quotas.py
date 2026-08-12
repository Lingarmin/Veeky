from __future__ import annotations

import math

import pytest

from app.security.quotas import (
    InstallationLockUnavailable,
    QuotaServiceUnavailable,
    RateLimitExceeded,
    RedisQuotaLimiter,
)


class FakeRedis:
    def __init__(self):
        self.entries: dict[str, dict[str, int]] = {}
        self.fail = False

    async def eval(self, _script, _num_keys, key, cutoff, now, member, limit, _ttl):
        if self.fail:
            raise ConnectionError("redis unavailable")
        entries = self.entries.setdefault(key, {})
        for old_member, score in list(entries.items()):
            if score <= int(cutoff):
                del entries[old_member]
        if len(entries) >= int(limit):
            return [0, min(entries.values())]
        entries[str(member)] = int(now)
        return [1, int(now)]


class FakeLockRedis:
    def __init__(self):
        self.values = {}

    async def set(self, key, value, *, nx, px):
        assert nx is True
        assert px == 5000
        if key in self.values:
            return None
        self.values[key] = value
        return True

    async def eval(self, _script, _num_keys, key, owner):
        if self.values.get(key) != owner:
            return 0
        del self.values[key]
        return 1


@pytest.mark.asyncio
async def test_write_quota_allows_twenty_requests_and_rejects_twenty_first():
    now = [1_000.0]
    limiter = RedisQuotaLimiter(FakeRedis(), clock=lambda: now[0])

    for _ in range(20):
        await limiter.enforce("installation-a", "write", 20)

    with pytest.raises(RateLimitExceeded) as caught:
        await limiter.enforce("installation-a", "write", 20)

    assert caught.value.retry_after == 60


@pytest.mark.asyncio
async def test_read_quota_allows_one_hundred_twenty_requests():
    limiter = RedisQuotaLimiter(FakeRedis(), clock=lambda: 2_000.0)

    for _ in range(120):
        await limiter.enforce("installation-a", "read", 120)

    with pytest.raises(RateLimitExceeded):
        await limiter.enforce("installation-a", "read", 120)


@pytest.mark.asyncio
async def test_quota_counters_are_independent_and_return_remaining_retry_time():
    now = [3_000.0]
    limiter = RedisQuotaLimiter(FakeRedis(), clock=lambda: now[0])
    await limiter.enforce("installation-a", "write", 1)
    now[0] += 25

    with pytest.raises(RateLimitExceeded) as caught:
        await limiter.enforce("installation-a", "write", 1)
    await limiter.enforce("installation-b", "write", 1)

    assert caught.value.retry_after == math.ceil(35)


@pytest.mark.asyncio
async def test_quota_fails_closed_when_redis_is_unavailable():
    redis = FakeRedis()
    redis.fail = True
    limiter = RedisQuotaLimiter(redis, clock=lambda: 4_000.0)

    with pytest.raises(QuotaServiceUnavailable):
        await limiter.enforce("installation-a", "write", 20)


@pytest.mark.asyncio
async def test_installation_create_lock_is_owned_and_released():
    redis = FakeLockRedis()
    first = RedisQuotaLimiter(redis)
    second = RedisQuotaLimiter(redis)

    async with first.installation_create_lock("installation-a"):
        with pytest.raises(InstallationLockUnavailable):
            async with second.installation_create_lock("installation-a"):
                pass

    async with second.installation_create_lock("installation-a"):
        pass
