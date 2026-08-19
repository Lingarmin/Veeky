# Veeky installation security and quotas implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate every Veeky installation's jobs and history, protect temporary LLM credentials, and enforce request, concurrency, and four-hour video limits.

**Architecture:** The extension owns a random installation ID and bearer token in `chrome.storage.local`. FastAPI authenticates the token hash, binds jobs to the installation, and uses Redis for request counters and create-job locks. PostgreSQL stores only AES-GCM encrypted LLM credentials until the Worker reaches a terminal state. A metadata-only `yt-dlp` service supplies the real video duration.

**Tech Stack:** Chrome Extension Manifest V3, React, TypeScript, FastAPI, Pydantic, SQLAlchemy, Alembic, PostgreSQL, Redis, Celery, `cryptography`, `yt-dlp`, pytest, Vitest.

---

## File map

New backend modules have one responsibility each:

- `api/app/security/installations.py`: installation token hashing, registration, and authentication dependency.
- `api/app/security/credentials.py`: AES-GCM encryption and decryption for job credentials.
- `api/app/security/quotas.py`: Redis request counters and per-installation create lock.
- `api/app/services/video_metadata.py`: metadata-only YouTube duration lookup.
- `api/alembic/versions/0004_installation_security.py`: schema and legacy migration.
- `extension/src/sidepanel/identity.ts`: browser installation identity generation and persistence.

Existing orchestration remains in `api/app/api/analyses.py` and `api/app/workers/tasks.py`; only authentication, ownership, quota, duration, and credential calls are wired into those entrypoints.

## Task 1: Add security settings and dependencies

**Files:**
- Modify: `api/pyproject.toml`
- Modify: `api/app/core/settings.py`
- Modify: `api/.env.example`
- Modify: `docker-compose.yml`
- Test: `api/tests/test_settings.py`

- [ ] **Step 1: Write failing settings tests**

Add tests that construct production and development settings and assert these defaults and validation rules:

```python
def test_security_quota_defaults():
    settings = Settings(llm_credential_encryption_key=VALID_TEST_KEY)
    assert settings.llm_credential_ttl_seconds == 3600
    assert settings.write_rate_limit_per_minute == 20
    assert settings.read_rate_limit_per_minute == 120
    assert settings.max_active_jobs_per_installation == 1
    assert settings.max_video_duration_seconds == 14_400


def test_production_requires_credential_encryption_key():
    with pytest.raises(ValidationError):
        Settings(environment="production", llm_credential_encryption_key=None)
```

Use a base64-encoded 32-byte test key as `VALID_TEST_KEY`.

- [ ] **Step 2: Verify the tests fail**

Run: `cd api && .venv/bin/python -m pytest tests/test_settings.py -q`

Expected: failures because the new settings fields do not exist.

- [ ] **Step 3: Add dependencies and settings**

Add `cryptography>=45,<46` and `yt-dlp>=2026.7,<2027` to `api/pyproject.toml`. Add typed positive integer settings and `SecretStr | None` for `llm_credential_encryption_key`. Validate that production has a base64 value decoding to exactly 32 bytes.

Add the documented defaults to `api/.env.example`. Pass the encryption key and quota values into both API and Worker containers through their existing `env_file`; do not hard-code a real key in Compose.

- [ ] **Step 4: Verify the settings tests pass**

Run: `cd api && .venv/bin/pip install -e '.[dev]' && .venv/bin/python -m pytest tests/test_settings.py -q`

Expected: all settings tests pass.

- [ ] **Step 5: Commit**

```bash
git add api/pyproject.toml api/app/core/settings.py api/.env.example docker-compose.yml api/tests/test_settings.py
git commit -m "feat(api): add security and quota settings"
```

## Task 2: Add installation ownership schema

**Files:**
- Modify: `api/app/db/models.py`
- Create: `api/alembic/versions/0004_installation_security.py`
- Test: `api/tests/test_models.py`

- [ ] **Step 1: Write failing model tests**

Add tests that create two installations and jobs, then assert the relationship and credential fields:

```python
installation = Installation(id="11111111-1111-4111-8111-111111111111", token_hash="a" * 64)
job = AnalysisJob(
    installation=installation,
    video_id="aircAruvnKk",
    source_language="en",
    target_language="zh-Hans",
    transcript_version="sha256:abc",
    cache_key="owner:cache",
    llm_config={"provider": "kimi", "api_url": "https://api.moonshot.cn/v1", "model": "kimi-k2.5"},
    llm_credential_ciphertext="encrypted",
    llm_credential_expires_at=utc_now(),
)
session.add(job)
await session.commit()
assert job.installation_id == installation.id
assert job.installation.jobs == [job]
```

Also assert `llm_config` contains no `api_key` field.

- [ ] **Step 2: Verify the tests fail**

Run: `cd api && .venv/bin/python -m pytest tests/test_models.py -q`

Expected: import or attribute failure for `Installation`.

- [ ] **Step 3: Implement models and migration**

Add `Installation` with UUID string primary key, unique 64-character `token_hash`, `created_at`, and `last_seen_at`. Add non-null indexed `installation_id` to `AnalysisJob`, plus nullable ciphertext and expiry columns.

Migration `0004_installation_security` must:

1. Create `installations`.
2. Insert a fixed legacy installation row.
3. Add nullable ownership and credential columns.
4. Assign existing jobs to the legacy installation.
5. Remove `api_key` from existing PostgreSQL JSON with `llm_config - 'api_key'`.
6. Make `installation_id` non-null and add its foreign key and index.

The downgrade may restore nullable ownership before dropping the new columns and table; it must not attempt to reconstruct deleted plaintext keys.

- [ ] **Step 4: Verify models and migration metadata**

Run: `cd api && .venv/bin/python -m pytest tests/test_models.py -q`

Expected: all model tests pass.

Run: `docker compose run --rm api alembic upgrade head`

Expected: migration completes without error against the local PostgreSQL volume.

- [ ] **Step 5: Commit**

```bash
git add api/app/db/models.py api/alembic/versions/0004_installation_security.py api/tests/test_models.py
git commit -m "feat(api): add installation-owned analysis jobs"
```

## Task 3: Implement registration and authentication

**Files:**
- Create: `api/app/security/__init__.py`
- Create: `api/app/security/installations.py`
- Modify: `api/app/api/analyses.py`
- Test: `api/tests/test_installations.py`
- Modify: `api/tests/test_analyses_api.py`

- [ ] **Step 1: Write failing authentication tests**

Cover idempotent registration, hash-only persistence, mismatched token rejection, missing bearer token, and valid authentication:

```python
response = await client.post(
    "/v1/installations/register",
    json={"installationId": INSTALLATION_ID, "installationToken": INSTALLATION_TOKEN},
)
assert response.status_code == 201

async with factory() as session:
    row = await session.get(Installation, INSTALLATION_ID)
    assert row.token_hash == hashlib.sha256(INSTALLATION_TOKEN.encode()).hexdigest()
    assert INSTALLATION_TOKEN not in str(row.__dict__)

unauthorized = await client.get("/v1/analyses/history")
assert unauthorized.status_code == 401
assert unauthorized.json()["detail"]["code"] == "installation_auth_required"
```

Update the shared API test fixture with a helper that registers an installation and returns its authorization headers. Existing protected endpoint tests must use those headers.

- [ ] **Step 2: Verify the tests fail**

Run: `cd api && .venv/bin/python -m pytest tests/test_installations.py tests/test_analyses_api.py -q`

Expected: registration returns 404 and protected endpoints do not yet require auth.

- [ ] **Step 3: Implement registration and auth dependency**

Implement:

```python
def hash_installation_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


async def require_installation(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(HTTPBearer(auto_error=False))],
    installation_id: Annotated[str | None, Header(alias="X-Veeky-Installation-Id")],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Installation:
    # Validate UUID, load row, compare hashes with hmac.compare_digest,
    # update last_seen_at, and return a uniform 401 on failure.
```

Register with a Pydantic request model and return HTTP 201 for a new row or 200 for an existing matching row. Protect all `/v1/llm`, `/v1/videos`, and `/v1/analyses` endpoints. Leave `/health` public.

- [ ] **Step 4: Verify authentication tests pass**

Run: `cd api && .venv/bin/python -m pytest tests/test_installations.py tests/test_analyses_api.py -q`

Expected: all authentication and existing API tests pass.

- [ ] **Step 5: Commit**

```bash
git add api/app/security api/app/api/analyses.py api/tests/test_installations.py api/tests/test_analyses_api.py
git commit -m "feat(api): authenticate extension installations"
```

## Task 4: Add extension installation identity and authenticated requests

**Files:**
- Create: `extension/src/sidepanel/identity.ts`
- Create: `extension/tests/identity.test.ts`
- Modify: `extension/src/sidepanel/api.ts`
- Modify: `extension/src/sidepanel/App.tsx`
- Modify: `extension/tests/App.test.tsx`
- Modify: `extension/tests/llm.test.ts`

- [ ] **Step 1: Write failing identity and API tests**

Test stable storage and authorization headers:

```typescript
const first = await browserInstallationIdentityStore.loadOrCreate();
const second = await browserInstallationIdentityStore.loadOrCreate();
expect(second).toEqual(first);
expect(first.installationId).toMatch(/^[0-9a-f-]{36}$/);
expect(first.installationToken.length).toBeGreaterThanOrEqual(43);
```

Mock `fetch` and assert each request contains `Authorization: Bearer <token>` and `X-Veeky-Installation-Id`. Assert an initial 401 `installation_auth_required` causes one registration call and one retry, while a second 401 is surfaced.

- [ ] **Step 2: Verify the extension tests fail**

Run: `pnpm --dir extension test -- identity.test.ts App.test.tsx`

Expected: missing identity module and missing authorization headers.

- [ ] **Step 3: Implement identity storage and API bootstrap**

Generate the UUID with `crypto.randomUUID()` and generate 32 random token bytes with `crypto.getRandomValues`, encoded as base64url. Store both under `veeky.installationIdentity.v1` in `chrome.storage.local`.

Change `createApi` to accept an `InstallationIdentityStore`. Make its request helper load the identity, attach both headers, register on the specific 401 code, and retry exactly once. `App` waits for API identity bootstrap as part of its existing initial load, without adding visible onboarding.

- [ ] **Step 4: Verify extension tests and type checking**

Run: `pnpm --dir extension test -- identity.test.ts App.test.tsx llm.test.ts`

Expected: selected tests pass.

Run: `pnpm --dir extension typecheck`

Expected: no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add extension/src/sidepanel/identity.ts extension/src/sidepanel/api.ts extension/src/sidepanel/App.tsx extension/tests/identity.test.ts extension/tests/App.test.tsx extension/tests/llm.test.ts
git commit -m "feat(extension): authenticate each installation"
```

## Task 5: Enforce job ownership and private history

**Files:**
- Modify: `api/app/api/analyses.py`
- Modify: `api/app/db/models.py`
- Modify: `api/tests/test_analyses_api.py`

- [ ] **Step 1: Write failing two-installation tests**

Create installation A and B, create and complete one job for each, then assert:

```python
history_a = await client.get("/v1/analyses/history", headers=headers_a)
assert [item["jobId"] for item in history_a.json()["items"]] == [job_a]

for path in (f"/v1/analyses/{job_b}", f"/v1/analyses/{job_b}/result"):
    hidden = await client.get(path, headers=headers_a)
    assert hidden.status_code == 404
    assert hidden.json()["detail"]["code"] == "analysis_not_found"
```

Also assert identical analysis input from A and B produces different jobs, while repeated input within A reuses A's job.

- [ ] **Step 2: Verify isolation tests fail**

Run: `cd api && .venv/bin/python -m pytest tests/test_analyses_api.py -k 'installation or ownership or history' -q`

Expected: histories contain both jobs or cross-installation reads succeed.

- [ ] **Step 3: Apply ownership filters**

Include `installation.id` in `analysis_cache_key`. Set `installation_id` on every new job. Filter existing cache lookup, concurrency recovery, history, status, and result by the authenticated installation.

Use one helper for private lookup:

```python
async def _owned_job(session: AsyncSession, job_id: str, installation_id: str) -> AnalysisJob:
    job = await session.scalar(
        select(AnalysisJob).where(
            AnalysisJob.id == job_id,
            AnalysisJob.installation_id == installation_id,
        )
    )
    if job is None:
        raise _api_error(404, "analysis_not_found", "没有找到这个分析任务")
    return job
```

- [ ] **Step 4: Verify all API tests pass**

Run: `cd api && .venv/bin/python -m pytest tests/test_analyses_api.py -q`

Expected: all API tests pass, including two-installation isolation.

- [ ] **Step 5: Commit**

```bash
git add api/app/api/analyses.py api/app/db/models.py api/tests/test_analyses_api.py
git commit -m "feat(api): isolate analysis history and results"
```

## Task 6: Encrypt temporary LLM credentials

**Files:**
- Create: `api/app/security/credentials.py`
- Create: `api/tests/test_credentials.py`
- Modify: `api/app/api/analyses.py`
- Modify: `api/app/workers/tasks.py`
- Modify: `api/tests/test_analyses_api.py`
- Modify: `api/tests/test_tasks.py`

- [ ] **Step 1: Write failing encryption and lifecycle tests**

Test AES-GCM round trips, wrong job associated data, missing key, and database lifecycle:

```python
cipher = JobCredentialCipher(VALID_TEST_KEY)
encrypted = cipher.encrypt("job-1", "sk-private-value")
assert "sk-private-value" not in encrypted
assert cipher.decrypt("job-1", encrypted) == "sk-private-value"
with pytest.raises(InvalidTag):
    cipher.decrypt("job-2", encrypted)
```

Create a job through the API and query it directly. Assert `llm_config` has no `api_key`, ciphertext does not contain the key, and expiry is set. Run success, handled failure, and dispatch failure paths and assert ciphertext and expiry become `None`.

- [ ] **Step 2: Verify credential tests fail**

Run: `cd api && .venv/bin/python -m pytest tests/test_credentials.py tests/test_tasks.py tests/test_analyses_api.py -k 'credential or api_key or dispatch_failure' -q`

Expected: missing cipher module or plaintext key remains in `llm_config`.

- [ ] **Step 3: Implement encrypted credential storage**

Use `cryptography.hazmat.primitives.ciphers.aead.AESGCM`. Encode a version byte, 12-byte random nonce, and ciphertext as base64url. Bind the job ID as associated data.

Split `_llm_snapshot` into public provider metadata and credential encryption. Generate the job UUID before encryption so the job ID can be associated data. On requeue, replace the ciphertext and expiry.

Worker flow:

1. Claim the job.
2. Reject missing or expired ciphertext as `llm_credentials_expired`.
3. Decrypt into a local variable.
4. Merge it into an in-memory provider config.
5. Clear local references after provider construction.
6. Clear database ciphertext and expiry in every terminal update.

Dispatch errors must clear credentials in the API transaction before returning.

- [ ] **Step 4: Add expired credential cleanup task**

Add a Celery task `clear_expired_llm_credentials` that updates rows whose expiry is in the past and ciphertext is non-null. Configure Celery beat to run it every ten minutes. The task clears secrets only; it does not change job status because a running Worker may still hold the decrypted key in memory.

- [ ] **Step 5: Verify credential and Worker tests pass**

Run: `cd api && .venv/bin/python -m pytest tests/test_credentials.py tests/test_tasks.py tests/test_analyses_api.py -q`

Expected: all selected tests pass and no assertion can find the test key in persisted job fields.

- [ ] **Step 6: Commit**

```bash
git add api/app/security/credentials.py api/app/api/analyses.py api/app/workers/tasks.py api/tests/test_credentials.py api/tests/test_analyses_api.py api/tests/test_tasks.py
git commit -m "feat(api): protect temporary LLM credentials"
```

## Task 7: Add Redis request limits

**Files:**
- Create: `api/app/security/quotas.py`
- Create: `api/tests/test_quotas.py`
- Modify: `api/app/api/analyses.py`
- Modify: `api/app/main.py`
- Modify: `api/tests/test_analyses_api.py`

- [ ] **Step 1: Write failing quota boundary tests**

Use an injectable fake Redis client and controlled clock. Assert request 20 succeeds and request 21 in the write class returns 429. Assert request 120 succeeds and request 121 in the read class returns 429. Verify another installation has an independent counter and `Retry-After` is present.

Also assert a Redis exception returns:

```python
assert response.status_code == 503
assert response.json()["detail"]["code"] == "quota_service_unavailable"
```

- [ ] **Step 2: Verify quota tests fail**

Run: `cd api && .venv/bin/python -m pytest tests/test_quotas.py -q`

Expected: quota dependency or limiter is missing.

- [ ] **Step 3: Implement atomic rolling-window limits**

Implement a Redis sorted-set Lua script that removes entries older than 60 seconds, counts remaining entries, inserts a unique request member if under limit, and returns the oldest timestamp when blocked. Set a 61-second expiry on the key.

Expose `enforce_write_quota` and `enforce_read_quota` FastAPI dependencies. Keys must contain only the installation UUID and class, never the bearer token. Map Redis errors to the fail-closed 503 response.

Apply write quota to LLM test, video inspect, and analysis create. Apply read quota to history, status, and result. Add a separate low IP-based registration limiter in the registration handler.

- [ ] **Step 4: Verify quota and API tests pass**

Run: `cd api && .venv/bin/python -m pytest tests/test_quotas.py tests/test_analyses_api.py -q`

Expected: exact boundaries, independent installation counters, and `Retry-After` pass.

- [ ] **Step 5: Commit**

```bash
git add api/app/security/quotas.py api/app/api/analyses.py api/app/main.py api/tests/test_quotas.py api/tests/test_analyses_api.py
git commit -m "feat(api): enforce per-installation request limits"
```

## Task 8: Enforce one active job per installation

**Files:**
- Modify: `api/app/security/quotas.py`
- Modify: `api/app/api/analyses.py`
- Modify: `api/tests/test_analyses_api.py`

- [ ] **Step 1: Write failing concurrency tests**

Test one active job, same-job reuse, terminal release, and simultaneous create calls:

```python
first, second = await asyncio.gather(
    client.post("/v1/analyses", json=payload_a, headers=headers),
    client.post("/v1/analyses", json=payload_b, headers=headers),
)
assert sorted([first.status_code, second.status_code]) == [202, 429]
blocked = first if first.status_code == 429 else second
assert blocked.json()["detail"]["code"] == "analysis_concurrency_limit"
```

Assert another installation may create its own active job.

- [ ] **Step 2: Verify concurrency tests fail**

Run: `cd api && .venv/bin/python -m pytest tests/test_analyses_api.py -k 'concurrency_limit or active_job' -q`

Expected: both different jobs are created.

- [ ] **Step 3: Implement installation create lock and active query**

Use Redis `SET key value NX PX 5000` with a random owner value. Release via a compare-and-delete Lua script. While holding the lock:

1. Resolve same-cache-key reuse first.
2. Count jobs for the installation in active statuses.
3. Reject a different job when count is at the configured maximum.
4. Commit the new or resumed job before releasing the lock.

Return `429 analysis_concurrency_limit` with `已有视频正在分析，请等待完成后再试。`

- [ ] **Step 4: Verify concurrency and regression tests**

Run: `cd api && .venv/bin/python -m pytest tests/test_analyses_api.py -q`

Expected: all API tests pass and simultaneous requests produce one job.

- [ ] **Step 5: Commit**

```bash
git add api/app/security/quotas.py api/app/api/analyses.py api/tests/test_analyses_api.py
git commit -m "feat(api): limit concurrent installation jobs"
```

## Task 9: Enforce real four-hour video duration

**Files:**
- Create: `api/app/services/video_metadata.py`
- Create: `api/tests/test_video_metadata.py`
- Modify: `api/app/api/analyses.py`
- Modify: `api/tests/test_analyses_api.py`
- Modify: `api/pyproject.toml`

- [ ] **Step 1: Write failing metadata and boundary tests**

Inject a fake metadata extractor and assert:

```python
assert service.duration_ms("aircAruvnKk") == 14_400_000

too_long = await client.post(
    "/v1/videos/inspect",
    json={"url": "https://www.youtube.com/watch?v=aircAruvnKk"},
    headers=headers,
)
assert too_long.status_code == 422
assert too_long.json()["detail"] == {
    "code": "video_too_long",
    "message": "此视频时长过长，无法分析。",
}
```

Test exactly 14,400 seconds is allowed, 14,401 seconds is rejected, analysis create rechecks the duration, and metadata failure never falls back to subtitle duration.

- [ ] **Step 2: Verify duration tests fail**

Run: `cd api && .venv/bin/python -m pytest tests/test_video_metadata.py tests/test_analyses_api.py -k 'duration or too_long or metadata' -q`

Expected: metadata service is missing or long video is accepted.

- [ ] **Step 3: Implement metadata-only extraction**

Wrap `yt_dlp.YoutubeDL.extract_info(url, download=False)` with quiet, no-playlist, socket timeout, and proxy options. Validate a numeric positive `duration`, convert to milliseconds, and map lookup failures to `video_metadata_unavailable`.

Add `get_video_metadata_service`. Inspect checks metadata before fetching captions. Create checks it again before persisting or dispatching a job. Store the real duration on `Video` and return it from inspection.

- [ ] **Step 4: Verify duration and API tests pass**

Run: `cd api && .venv/bin/python -m pytest tests/test_video_metadata.py tests/test_analyses_api.py -q`

Expected: the four-hour boundary and metadata failure tests pass.

- [ ] **Step 5: Commit**

```bash
git add api/app/services/video_metadata.py api/app/api/analyses.py api/tests/test_video_metadata.py api/tests/test_analyses_api.py api/pyproject.toml
git commit -m "feat(api): reject videos longer than four hours"
```

## Task 10: Add frontend errors and retry behavior

**Files:**
- Modify: `extension/src/sidepanel/App.tsx`
- Modify: `extension/src/sidepanel/api.ts`
- Modify: `extension/tests/App.test.tsx`
- Modify: `extension/tests-e2e/sidepanel.spec.ts`

- [ ] **Step 1: Write failing UI tests**

Add parameterized assertions for:

```typescript
[
  ["video_too_long", "此视频时长过长，无法分析。"],
  ["analysis_concurrency_limit", "已有视频正在分析，请等待完成后再试。"],
  ["rate_limit_exceeded", "操作过于频繁，请稍后再试。"],
  ["llm_credentials_expired", "任务凭据已过期，请点击重试。"],
  ["quota_service_unavailable", "服务暂时繁忙，请稍后再试。"],
  ["installation_auth_required", "插件身份验证失败，请刷新后重试。"],
]
```

Test that clicking retry after `llm_credentials_expired` calls `createAnalysis` with the locally loaded LLM config and does not show the settings form when the local key still exists.

- [ ] **Step 2: Verify UI tests fail**

Run: `pnpm --dir extension test -- App.test.tsx`

Expected: new codes map to the generic analysis error or retry does not resubmit.

- [ ] **Step 3: Implement messages and automatic key resubmission**

Extend the existing error-code mapper with the approved Chinese messages. Treat `llm_credentials_expired` as a retryable failed task. The retry button uses the same `reanalyze` request path and the browser-local `llmConfig`; it opens settings only if the local key is missing.

Respect `Retry-After` in `ApiError` so the UI may preserve it for later countdown work, but do not add a countdown in this scope.

- [ ] **Step 4: Verify frontend tests and build**

Run: `pnpm --dir extension test && pnpm --dir extension typecheck && pnpm --dir extension build`

Expected: all unit tests pass, type checking succeeds, and Vite produces `extension/dist`.

- [ ] **Step 5: Commit**

```bash
git add extension/src/sidepanel/App.tsx extension/src/sidepanel/api.ts extension/tests/App.test.tsx extension/tests-e2e/sidepanel.spec.ts
git commit -m "feat(extension): explain security and quota failures"
```

## Task 11: Update documentation and deployment configuration

**Files:**
- Modify: `README.md`
- Modify: `api/.env.example`
- Modify: `docker-compose.yml`
- Create: `docs/superpowers/decisions/2026-08-12-installation-security.md`

- [ ] **Step 1: Update operating instructions**

Document generation of a development encryption key:

```bash
openssl rand -base64 32
```

Explain that the value belongs in `api/.env` as `LLM_CREDENTIAL_ENCRYPTION_KEY`, never in Git. Document identity loss after extension uninstall, quota values, four-hour limit, encrypted credential cleanup, Redis dependency, and extension reload after build.

- [ ] **Step 2: Add the decision record**

Record why the implementation uses anonymous installation credentials, hash-only server identity storage, PostgreSQL encrypted job credentials, Redis limits, and `yt-dlp` metadata. Include rollback guidance and the rejected account and Redis-only credential alternatives.

- [ ] **Step 3: Check documentation for secrets and stale claims**

Run:

```bash
rg -n '明文写入|MVP 会把 API Key|LLM_CREDENTIAL_ENCRYPTION_KEY=' README.md api/.env.example docs/superpowers
```

Expected: no stale plaintext-storage claim and no real encryption key value.

- [ ] **Step 4: Commit**

```bash
git add README.md api/.env.example docker-compose.yml docs/superpowers/decisions/2026-08-12-installation-security.md
git commit -m "docs: explain installation security controls"
```

## Task 12: Full verification and manual security regression

**Files:**
- Modify if required by failures: files already listed in Tasks 1 through 11

- [ ] **Step 1: Run backend tests**

Run: `cd api && .venv/bin/python -m pytest -q`

Expected: all backend tests pass.

- [ ] **Step 2: Run frontend checks**

Run: `pnpm --dir extension test && pnpm --dir extension typecheck && pnpm --dir extension build`

Expected: all extension tests pass, type checking succeeds, and production build succeeds.

- [ ] **Step 3: Run static secret and diff checks**

Run:

```bash
git diff --check
git grep -n -I -E 'sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}' -- . ':!api/tests' ':!extension/tests'
git status --short
```

Expected: no whitespace errors, no production secret patterns, and only intended changes.

- [ ] **Step 4: Run the local service stack**

Run: `docker compose up -d --build`

Expected: API, Worker, PostgreSQL, Redis, and LibreTranslate become healthy. `curl http://127.0.0.1:8000/health` returns `{"status":"ok"}`.

- [ ] **Step 5: Perform two-profile Chrome regression**

Load the rebuilt extension into two separate Chrome profiles. Confirm each profile registers a different installation identity, profile A cannot see profile B history, cross-profile job IDs return 404, a second active video is blocked, a video over four hours shows the approved message, and normal analysis still completes.

Inspect the database after one success and one failure:

```sql
SELECT id, llm_config, llm_credential_ciphertext, llm_credential_expires_at
FROM analysis_jobs
ORDER BY created_at DESC
LIMIT 5;
```

Expected: provider metadata remains, no `api_key` property exists, and terminal rows have null credential fields.

- [ ] **Step 6: Commit any verification fixes**

If verification required code changes, rerun the affected focused test before the full suites, then commit only those fixes:

```bash
git add <files changed by the verified fix>
git commit -m "fix: address security regression findings"
```

If no fixes were required, do not create an empty commit.
