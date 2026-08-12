# Installation security and quota decision

Date: 2026-08-12

## Decision

Veeky assigns each extension installation a random UUID and a 256-bit bearer token. The extension keeps both values in `chrome.storage.local`. The API stores only the token SHA-256 hash and requires the installation identity on every protected request. Analysis jobs, cache reuse, history, status, and results are scoped to that installation.

The user's LLM API Key remains in extension-local storage. The API encrypts a submitted Key with AES-256-GCM and stores it only while the asynchronous task needs it. The job ID is authenticated as associated data, so ciphertext from one task cannot be moved to another. Provider name, API URL, and model remain as non-secret metadata. Success, failure, and dispatch errors clear the credential fields immediately; Celery Beat removes expired ciphertext every 10 minutes.

Redis provides rolling request limits and a five-second installation-scoped analysis creation lock. The database remains the source of truth for active jobs. `yt-dlp` reads metadata without downloading media and supplies the duration used for the four-hour limit.

## Reasons

Anonymous installation credentials add ownership checks without introducing accounts or sign-in. Hash-only token storage limits damage if the installation table is exposed. PostgreSQL-backed encrypted credentials survive normal API and Worker restarts while still having a short lifetime. Redis is a suitable shared coordination layer for atomic counters and short locks across multiple API processes.

YouTube caption timestamps are not a reliable video duration. Captions may end early or omit sections, so the API uses metadata and fails explicitly when it cannot read the real duration.

## Rejected alternatives

User accounts would support cross-device history recovery, but they add authentication, account recovery, and privacy work outside the current product scope.

Keeping temporary credentials only in Redis would reduce database exposure, but task recovery would depend on Redis persistence and eviction behavior. Encrypted PostgreSQL storage is more predictable for queued work in the current deployment.

Storing plaintext API Keys in job JSON was rejected because database readers and backups could recover them. Using subtitle duration as a fallback was rejected because it could allow videos longer than four hours.

## Operations and rollback

Each deployment must provide the same `LLM_CREDENTIAL_ENCRYPTION_KEY` to API, Worker, and scheduler processes. The key must not enter Git. Rotating it invalidates outstanding encrypted credentials; affected users can retry because the extension resubmits its local Key.

If Redis is unavailable, protected quota paths fail closed with `quota_service_unavailable`. Operators should restore Redis rather than bypass the controls. The analysis creation lock expires after five seconds, while the database active-job query prevents the lock from becoming the capacity record.

A rollback may stop the scheduler and disable new task creation, but it must not restore plaintext credential storage or remove ownership filters. Database downgrade cannot reconstruct API Keys removed by migration `0004`.
