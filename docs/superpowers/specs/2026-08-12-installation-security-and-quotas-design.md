# Veeky installation security and quota design

Date: 2026-08-12
Status: approved for implementation planning

## Goal

Give every Veeky installation an independent anonymous identity, isolate its analysis history and jobs, prevent cross-installation reads, stop storing readable LLM API keys in the database, and add production-oriented request, concurrency, and video-duration limits.

This change does not add user accounts or cross-device history recovery. Uninstalling Veeky, clearing extension storage, or moving to another browser loses access to the previous anonymous identity and its history.

## Acceptance criteria

- A new extension installation creates its own anonymous identity without user interaction.
- Two installations cannot see each other's history.
- A request using installation A's credential cannot read installation B's job status or result. The API returns `404 analysis_not_found` without revealing whether the job exists.
- The database never stores a readable LLM API key.
- An encrypted temporary LLM credential is removed when a task succeeds or fails. Expired credentials left by an interrupted Worker are also removed.
- Retrying a failed task automatically resubmits the API key stored in the extension. The user does not need to type it again.
- Write operations allow 20 requests per installation per rolling minute.
- Polling and other read operations allow 120 requests per installation per rolling minute.
- One installation can have at most one active analysis job.
- Videos up to and including four hours can be analyzed.
- A video longer than four hours is not queued. The extension displays: `此视频时长过长，无法分析。`
- Existing caption inspection, translation, summary, history, reanalysis, and timestamp seeking continue to work.

## Chosen approach

Use an anonymous installation credential on every API request, store only its hash on the server, and bind every analysis job to the authenticated installation. Redis enforces request limits. The database holds an encrypted LLM configuration only while an asynchronous job needs it.

This approach fits the current extension without adding account management. Keeping the encrypted job credential in PostgreSQL also preserves queued work across API and Worker restarts. A Redis-only credential store would reduce database exposure, but it would make restart, expiry, and retry behavior more fragile at this stage.

## Installation identity

### Extension state

On first use, the extension creates:

- `installationId`: a random UUID used as a stable public identifier.
- `installationToken`: at least 256 bits of cryptographically secure random data.

Both values live in `chrome.storage.local`. They are never written into source code, logs, history items, or analysis results. The extension creates the API client only after loading this identity and sends the token through the `Authorization: Bearer <token>` header.

### Registration

The extension calls `POST /v1/installations/register` with its `installationId` and token when the server does not recognize the installation. Registration is idempotent for the same ID and token.

The server stores:

- installation UUID
- SHA-256 token hash
- created timestamp
- last-seen timestamp

The original token is not stored. A reused installation ID with a different token is rejected. General API endpoints require a valid installation credential.

The health endpoint remains unauthenticated for service monitoring.

### Authentication failures

- Missing or invalid credentials return `401 installation_auth_required`.
- A missing local identity is regenerated automatically before a request.
- A server that no longer recognizes the installation triggers one automatic registration attempt, then retries the original request once.
- Authentication retry loops are prohibited.

## Job ownership and history isolation

`AnalysisJob` gains a non-null `installation_id` foreign key. Its cache key includes the installation ID so cached analysis jobs are private to that installation.

All job queries include both `job_id` and the authenticated `installation_id`:

- analysis creation and cache reuse
- history listing and video filtering
- job status
- job result
- reanalysis

A cross-installation status or result request returns the same 404 response as a nonexistent job. Completed transcripts and translation cache rows may remain shared internal data, but no endpoint exposes them without first authorizing the owning analysis job.

Existing local MVP jobs are assigned to a migration-only legacy installation. New installations cannot read them. This avoids guessing which future user owns old development data.

## LLM API key lifecycle

### Stored fields

The job keeps non-secret provider metadata in `llm_config`:

- provider
- normalized API URL
- model

The API key is encrypted separately with an authenticated encryption algorithm. The encrypted payload includes a nonce and authentication tag and is bound to the job ID as associated data. A server-only `LLM_CREDENTIAL_ENCRYPTION_KEY` supplies the encryption key and must come from environment configuration or a production secret manager.

The schema adds:

- `llm_credential_ciphertext`, nullable
- `llm_credential_expires_at`, nullable

The plaintext key exists only in process memory while the API encrypts it or the Worker calls the configured provider. It must not appear in logs, exceptions, API responses, Celery arguments, cache keys, or telemetry.

### Retention and cleanup

- The API sets a bounded expiry when it creates or requeues a job.
- The Worker decrypts the credential immediately before building the LLM client.
- Success and every handled failure clear the encrypted credential and expiry in the same final job update.
- Dispatch failures clear the credential before returning an error.
- A periodic cleanup task clears expired encrypted credentials from interrupted jobs.
- A Worker that finds a missing or expired credential fails the job with `llm_credentials_expired`. The UI prompts the user to retry. Retrying automatically sends the locally stored key.

Provider metadata remains after completion so history results can select the correct translation cache without retaining the key.

## Request limits

Redis stores short-lived counters keyed by installation ID and request class. The check and increment are atomic. Limits use a rolling 60-second window and return `Retry-After` when rejected.

### Write class: 20 requests per minute

- `POST /v1/llm/test`
- `POST /v1/videos/inspect`
- `POST /v1/analyses`

Registration has a separate conservative IP-based limit so unauthenticated clients cannot flood installation rows.

### Read class: 120 requests per minute

- `GET /v1/analyses/history`
- `GET /v1/analyses/{job_id}`
- `GET /v1/analyses/{job_id}/result`

The existing two-second status polling stays below the read limit. A rejected request returns `429 rate_limit_exceeded` with a Chinese retry message.

If Redis is unavailable, production requests fail closed with `503 quota_service_unavailable`; development may use an in-process limiter for tests only. This avoids silently removing abuse controls during a Redis outage.

## Concurrent analysis limit

Before creating or requeuing work, the API acquires a short Redis lock for the installation and queries its active jobs. Active statuses are:

- `queued`
- `fetching_transcript`
- `analyzing`
- `translating`

An existing request for the same cache key may return or resume that same job. A request that would create a different active job returns `429 analysis_concurrency_limit`.

The lock prevents two simultaneous create requests from both passing the check. The database query remains the source of truth, so an expired Redis lock does not permanently consume capacity. Completed and failed jobs do not count against the limit.

## Video duration limit

The current implementation estimates video duration from the last subtitle segment, which can undercount long intros, outros, and caption gaps. The API will use `yt-dlp` metadata extraction to read the real YouTube duration without downloading video or audio.

The metadata service:

- accepts a validated YouTube video ID
- requests metadata only
- uses the configured YouTube proxy when present
- returns duration in milliseconds
- applies bounded timeout and retry behavior

Both caption inspection and analysis creation verify the duration. The hard limit is `14,400,000` milliseconds. A longer video returns `422 video_too_long` and no job is created. The extension maps that code to `此视频时长过长，无法分析。`

If YouTube metadata cannot be read, the API returns a specific metadata error instead of falling back to subtitle duration and accidentally bypassing the limit.

## Error handling and user experience

Identity registration, token use, key encryption, and credential cleanup are invisible during normal use. Existing settings continue to store the user's provider configuration locally.

New user-facing errors are:

- `video_too_long`: `此视频时长过长，无法分析。`
- `analysis_concurrency_limit`: `已有视频正在分析，请等待完成后再试。`
- `rate_limit_exceeded`: `操作过于频繁，请稍后再试。`
- `llm_credentials_expired`: `任务凭据已过期，请点击重试。`
- `installation_auth_required`: the extension silently repairs registration once, then displays `插件身份验证失败，请刷新后重试。`
- `quota_service_unavailable`: `服务暂时繁忙，请稍后再试。`

No new settings controls are required.

## Data model and configuration

The migration adds an `installations` table and job ownership and credential fields. It also updates the analysis cache uniqueness rule to include ownership through the generated cache key.

New configuration values include:

- `LLM_CREDENTIAL_ENCRYPTION_KEY`
- `LLM_CREDENTIAL_TTL_SECONDS`
- `WRITE_RATE_LIMIT_PER_MINUTE=20`
- `READ_RATE_LIMIT_PER_MINUTE=120`
- `MAX_ACTIVE_JOBS_PER_INSTALLATION=1`
- `MAX_VIDEO_DURATION_SECONDS=14400`

Production startup must fail if the encryption key is missing or invalid. Development and tests use an explicit local-only key.

## Impact and risks

Expected code areas:

- SQLAlchemy models and Alembic migration
- installation authentication dependency and registration endpoint
- Redis rate limiter and installation lock
- analysis ownership filters and cache key generation
- encrypted credential service and Worker cleanup
- YouTube metadata service and duration validation
- extension identity store, authenticated API client, and error messages
- API, Worker, extension, migration, and security regression tests
- README and environment examples

Primary risks are migration correctness, accidental cross-installation cache reuse, credentials surviving terminal states, Redis race conditions, and `yt-dlp` failures from hosted IP addresses. Tests must cover each path.

`manifest.json` permissions do not need to change. The extension must still be manually reloaded after rebuilding because the service worker and side panel bundle are cached by Chrome.

## Test strategy

Backend tests cover:

- idempotent registration and token hash storage
- missing, invalid, and mismatched credentials
- history, status, and result isolation between two installations
- cache reuse only within one installation
- encrypted credential persistence with no plaintext database occurrence
- cleanup after success, handled failure, dispatch failure, and expiry
- automatic retry payload from the extension
- exact rate-limit boundaries and `Retry-After`
- concurrent create requests with one winner
- active-job release after success and failure
- real-duration boundary at four hours and rejection above it
- metadata failure behavior

Extension tests cover identity generation, registration retry, authorization headers, retained local LLM configuration, error messages, and the existing analysis and history flows.

Full regression runs include all existing backend and extension tests, type checking, production build, and a manual two-profile Chrome test.

## Rollback

Application code can be rolled back while retaining the added nullable credential columns and installation table. Jobs created after this migration depend on installation ownership, so a full database downgrade requires deleting those jobs or mapping them to the legacy installation first.

Rate limits and duration limits are configurable and can be adjusted without another schema migration. Disabling authentication in production is not an acceptable rollback because it would restore cross-user access.
