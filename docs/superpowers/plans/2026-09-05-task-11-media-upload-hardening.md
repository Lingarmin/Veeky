# Task 11 Media Upload Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make X media uploads survive serialization, ambiguous completion, lost contexts, and stalled I/O without reopening the prior security issues.

**Architecture:** The background authenticates an offscreen Port and sends only JSON configuration and control messages. The offscreen document creates its own authenticated HTTP client from that configuration, streams media directly to the API, and reports session lifecycle changes so the background can recover abandoned sessions. Every network and Port boundary has an explicit timeout.

**Tech Stack:** TypeScript, Chrome Manifest V3 runtime/offscreen APIs, OPFS, Fetch, Vitest fake timers, Vite.

---

### Task 1: JSON-safe offscreen bootstrap

**Files:**
- Modify: `extension/src/shared/types.ts`
- Modify: `extension/src/background.ts`
- Modify: `extension/src/offscreen/index.ts`
- Test: `extension/tests/background.test.ts`
- Test: `extension/tests/offscreen.test.ts`

- [x] **Step 1: Write the failing tests**

Add a Port fake that JSON-serializes messages. Assert bootstrap sends only the API base URL and installation identity as strings, then complete a production-path upload without any `Uint8Array` crossing the Port.

- [x] **Step 2: Run tests to verify RED**

Run `pnpm exec vitest run tests/background.test.ts tests/offscreen.test.ts` and confirm the old `MEDIA_API_REQUEST` binary proxy fails serialization.

- [x] **Step 3: Implement the minimal transport**

Load identity in the background, send a `MEDIA_UPLOAD_CONFIG` handshake after validating the offscreen sender, and construct `createApi(baseUrl, staticIdentityStore)` in offscreen. Keep START and lifecycle messages on the Port.

- [x] **Step 4: Run tests to verify GREEN**

Run `pnpm exec vitest run tests/background.test.ts tests/offscreen.test.ts` and require zero failures.

### Task 2: Ambiguous completion recovery

**Files:**
- Modify: `extension/src/offscreen/index.ts`
- Test: `extension/tests/offscreen.test.ts`

- [x] **Step 1: Write the failing tests**

Cover a lost completion response followed by complete/consumed status, a retryable uploading status with bounded completion retries, confirmed exhaustion that cancels, and successful completion followed by OPFS disposal failure.

- [x] **Step 2: Run tests to verify RED**

Run the focused offscreen tests and confirm premature cancellation and cleanup-error failures.

- [x] **Step 3: Implement the minimal recovery loop**

On completion failure, query session status. Treat complete/consumed as success, otherwise retry completion up to the fixed attempt limit. Cancel only when completion remains unconfirmed. Track successful completion so later OPFS cleanup errors do not cancel or fail the job.

- [x] **Step 4: Run tests to verify GREEN**

Run the focused offscreen tests and require zero failures.

### Task 3: Persist and recover active sessions

**Files:**
- Modify: `extension/src/shared/types.ts`
- Modify: `extension/src/background.ts`
- Modify: `extension/src/offscreen/index.ts`
- Test: `extension/tests/background.test.ts`
- Test: `extension/tests/offscreen.test.ts`

- [x] **Step 1: Write the failing tests**

Assert `SESSION_CREATED` persists job, session, and content identity; normal completion/cancellation clears it; confirmed context loss cancels an orphan after restart; and a normal Port reconnect does not cancel the live session.

- [x] **Step 2: Run tests to verify RED**

Run background and offscreen tests and confirm lifecycle persistence is missing.

- [x] **Step 3: Implement lifecycle persistence**

Store the active upload in `chrome.storage.local`. Reconcile it only after the offscreen handshake/reconnect grace period proves the context is gone. Use the background API for best-effort orphan cancellation, then clear the record.

- [x] **Step 4: Run tests to verify GREEN**

Run focused tests and require zero failures.

### Task 4: Bound all waits

**Files:**
- Modify: `extension/src/sidepanel/api.ts`
- Modify: `extension/src/background.ts`
- Modify: `extension/src/offscreen/index.ts`
- Test: `extension/tests/identity.test.ts`
- Test: `extension/tests/background.test.ts`
- Test: `extension/tests/offscreen.test.ts`

- [x] **Step 1: Write the failing tests**

With fake timers, cover API request timeout, media fetch timeout, stream stall timeout with abort, Port handshake timeout, and overall upload timeout that cancels the active session and releases the global slot.

- [x] **Step 2: Run tests to verify RED**

Run the three focused suites and confirm each unbounded operation fails its new timeout assertion.

- [x] **Step 3: Implement bounded operations**

Use `AbortController` for API and media fetches, race individual stream reads against a stall timer, retain the existing Port connection deadline, and enforce a five-hour overall upload deadline. Cleanup must cancel the session and release the slot on timeout.

- [x] **Step 4: Run tests to verify GREEN**

Run the focused suites and require zero failures.

### Task 5: Verify and commit

**Files:**
- Verify all modified files above.

- [x] **Step 1: Run full verification**

Run `pnpm test`, `pnpm typecheck`, `pnpm build`, and `git diff --check`.

- [x] **Step 2: Inspect production output**

Confirm `dist/offscreen.html` loads the expected bundle, the offscreen bundle contains no `chrome.storage` access, and no Port message includes binary media data.

- [x] **Step 3: Review the diff**

Check each review requirement against code and tests; fix any Critical or Important finding and repeat verification.

- [x] **Step 4: Commit**

Commit the verified change with a focused Task 11 hardening message and report the commit SHA.
