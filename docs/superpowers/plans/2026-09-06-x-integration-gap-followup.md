# X Integration Gap Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep X media processing within the per-job temporary-storage limit, synchronize fallback session state across extension reconnects, and reject malformed direct-media ports with a stable API error.

**Architecture:** Keep quota enforcement at the worker boundaries that create files, using an injectable size probe so tests can model GiB-scale usage with tiny fixtures. Extend the private extension Port protocol with an acknowledged session-clear message so offscreen candidate retries cannot race background persistence. Keep URL validation centralized in `_validate_direct_media_url`.

**Tech Stack:** Python 3, FastAPI, pytest, TypeScript, Chrome extension Ports, Vitest, pnpm

---

### Task 1: Direct-media URL port validation

**Files:**
- Modify: `api/tests/test_analyses_api.py`
- Modify: `api/app/api/analyses.py`

- [ ] Add malformed-port cases `abc` and `99999` to the direct-media URL API regression test.
- [ ] Run `./.venv/bin/pytest tests/test_analyses_api.py -q -k explicit_ports` from `api/` and confirm the new cases fail with an uncaught `ValueError`.
- [ ] Read `parsed.port` inside the existing `try` block and validate the captured value afterward.
- [ ] Re-run the focused test and confirm all port cases return `422 invalid_media_url`.

### Task 2: HLS temporary-storage quota

**Files:**
- Modify: `api/tests/test_x_pipeline.py`
- Modify: `api/app/workers/tasks.py`

- [ ] Add focused tests that inject a job-usage probe and simulate near-limit reconstruction and mux output without allocating large files.
- [ ] Run the new tests and confirm reconstruction or mux exceeds the modeled budget without raising `media_too_large`.
- [ ] Thread the quota and usage probe through HLS splitting and muxing, checking projected and observed job-directory usage at each file-producing boundary.
- [ ] Remove the assembled HLS input before muxing once split tracks are complete, and preserve cleanup of all split and partial mux files on failure.
- [ ] Re-run the focused worker tests and confirm overflow produces `media_too_large` with no temporary artifacts left.

### Task 3: Candidate fallback session synchronization

**Files:**
- Modify: `extension/src/shared/types.ts`
- Modify: `extension/src/offscreen/index.ts`
- Modify: `extension/src/background.ts`
- Modify: `extension/tests/offscreen.test.ts`
- Modify: `extension/tests/background.test.ts`

- [ ] Add protocol and integration tests for candidate 1 creating a session, failing, disconnecting and reconnecting the Port, then candidate 2 succeeding.
- [ ] Run the focused Vitest tests and confirm candidate 2 starts before background persistence is cleared or is rejected as mismatched context.
- [ ] Add `MEDIA_SESSION_CLEARED` and its acknowledgement to the private Port message contract.
- [ ] On candidate failure, cancel the created session best-effort, send the clear message, and await background acknowledgement before trying the next candidate.
- [ ] Make background clear persisted state only when the job and session match, acknowledge the clear, and keep reconnect reconciliation consistent.
- [ ] Re-run focused extension tests and confirm fallback succeeds through reconnect.

### Task 4: Final verification and commit

**Files:**
- Verify all modified files above.

- [ ] Run `./.venv/bin/pytest tests -q` from `api/`.
- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm build`, and `pnpm test:e2e` from `extension/`.
- [ ] Run `git diff --check`, inspect `git diff`, and verify the worktree contains only scoped changes.
- [ ] Commit with a focused message and report the full commit SHA.
