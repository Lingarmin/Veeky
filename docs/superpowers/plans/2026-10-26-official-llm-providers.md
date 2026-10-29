# Official LLM Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox syntax for tracking. Do not commit/push; preserve the existing isolated worktree.

**Goal:** Restrict all LLM calls to five official providers while preserving user history and preventing relay-key migration.

**Architecture:** A backend official-provider registry resolves fixed endpoints and capabilities. A dedicated pinned HTTPS transport enforces the destination at connect time. The extension presents a matching official-only catalog, per-provider keys and safe legacy-config handling.

**Tech Stack:** Python/FastAPI/httpx/pytest; TypeScript/React/Chrome MV3/Vitest.

## Baseline

Worktree: `.worktrees/x-video-subtitle-support`, branch `codex/x-video-subtitle-support`.
Before changes: backend selected tests 134 passed; extension 280 passed; TypeScript passed.

## Task 1 — Backend official providers and protected transport

Files: create `api/app/services/llm_providers.py`, `api/app/services/llm_security.py`, and `api/tests/test_llm_security.py`; modify `api/app/services/llm.py`, `api/app/api/analyses.py`, and relevant tests. Only change workers/translation/analysis if integration requires it. Preserve historical endpoint hashing.

- [x] Add failing tests for provider-aware URL normalization, all five complete endpoints, cross-provider URL rejection, localhost/HTTP/private IP, redirect, DNS rebinding, mixed DNS answers, and non-leaking errors.
- [x] Run `.venv/bin/pytest tests/test_llm.py tests/test_llm_security.py -q` in `api`; verify expected RED, then implement.
- [x] Use a fixed registry, not frontend URLs, for transport destinations. Constructor validation must reject stale relay credentials before any outbound request.

```python
@pytest.mark.parametrize("url", ["http://api.moonshot.cn/v1", "https://relay.example/v1", "https://api.deepseek.com/v1"])
def test_kimi_rejects_nonofficial_destination(url):
    with pytest.raises(ValueError):
        normalize_provider_config("kimi", url, "dummy-key")
```

- [x] Adapt provider payload fields; use JSON connectivity probe with a small token budget, explicit success object validation and clear errors. Preserve legacy JSON parsing/fallback only within the selected official provider.
- [x] Test protected HTTPX transport through a deterministic resolver plus inner MockTransport; inspect pinned IP, original Host/SNI, no redirect/proxy and all endpoint invariants without real network or Key.
- [x] Update API/worker regression fixtures from fake relay endpoints to provider-matching official endpoints, not by adding a production bypass.
- [x] Run backend suite excluding only genuinely external integration prerequisites; report skips and limitations.
- [x] Complete independent spec review then quality review; resolve findings before task 2.

## Task 2 — Official-only extension settings and safe migration

Files: `extension/src/sidepanel/llm.ts`, `extension/src/sidepanel/App.tsx`, `extension/src/sidepanel/store.ts`, `extension/tests/llm.test.ts`, `extension/tests/App.test.tsx`, and relevant frontend fixtures. Do not alter manifest permissions or unrelated UI.

- [x] Write failing tests for five options, read-only URL, per-provider key isolation, configuration validity and old relay-key quarantine.

```ts
expect(isLlmConfigured({provider: "kimi", apiUrl: "https://relay.example/v1", apiKey: "relay-only-key", model: "kimi-k2.5"})).toBe(false);
expect(defaultLlmConfig("glm").apiUrl).toBe("https://open.bigmodel.cn/api/paas/v4");
```

- [x] Verify RED with `pnpm test tests/llm.test.ts tests/App.test.tsx`; implement catalog and read-only official address.
- [x] On loading relay config, do not persist deletions: return official address with empty runtime key plus explanatory state/message. A new explicit user save replaces that provider's stored config. Block test/start until new official credentials supplied.
- [x] Add configurable model ID/default, short cost disclaimer and actual-connectivity wording; keep existing simple layout. Persist the explicitly saved provider selection so reopening uses that provider, without copying credentials between providers. Guard asynchronous provider switching/testing from stale configuration state.
- [x] Run `pnpm test && pnpm typecheck && pnpm build`; complete independent spec review then quality review and fix findings.

## Task 3 — Integration verification and handoff

Files: update `README.md`, this plan and `docs/internal-test-cases.md`; generated extension bundle only after tests. Keep primary checkout source unchanged.

- [x] Document official-only setup, legacy relay behavior, supported defaults, unverified live-Key limitation and no-history-deletion guarantee.
- [x] Re-run full unit suites, typecheck, build and relevant browser/E2E checks available in environment. Do not read actual .env or user keys, call paid providers or mutate running user jobs.
- [x] Confirm diff contains no unintended manifest/database/history changes and no credentials.
- [x] Final independent security/code review. Fix significant findings, then rerun affected/full tests.
- [x] Record exact outputs, skipped prerequisites and which built bundle user should reload. Do not restart/delete user services or alter loaded browser extension without necessity/confirmation.

## Execution notes

No real provider API keys are available to the test run. Passing mock/provider-contract tests must never be described as completed real-provider integration.

2026-10-26 backend initial independent verification: 635 passed, 9 skipped (two PostgreSQL migration tests and seven media-concurrency tests require Docker). Spec review identified JSON fallback thinking controls, strict probe parsing, and Chinese invalid-config guidance for follow-up before task completion.

2026-10-26 backend spec re-review passed after the three findings were fixed. Independent focused verification: 306 passed. Independent full backend verification: 670 passed, 9 skipped in 21.36s; the same Docker prerequisites remain unavailable. Backend quality review is in progress.

Backend quality review found unbounded preliminary DNS and missing validated-address failover. Both were reproduced with failing tests and fixed. DNS shares the connect budget; failover only follows connection-establishment failures, never read/write/protocol failures. Independent security suite: 177 passed. Quality re-review approved with no remaining Critical/Important findings. Task 1 complete; Task 2 begins.

Independent full backend run after transport fixes: 683 passed, 9 Docker-dependent skips in 21.17s. Existing headless-shell browser could not load the MV3 service worker, so the matching Playwright Chromium was installed in the test cache. A fresh temporary-profile, all-HTTP-blocked smoke check successfully loaded the extension service worker in Chromium 151.0.7922.34. No installed user extension or running service was changed. Full E2E waits for network-isolated test fixtures in Task 3.

Task 2 implementation is complete. Independent frontend verification: 344 tests passed across 7 files; TypeScript check exited 0. Spec review is in progress; browser checks remain deferred until Task 3 installs network-isolated fixtures.

Task 2 spec review found a missing notice for malformed top-level LLM storage. The follow-up preserved raw data on load, quarantined runtime credentials, and clarified that only explicit save resets an unintelligible LLM container. No additional secret backup was introduced. Implementer RED: 8 failed/51 passed; final full frontend: 352 passed, typecheck/build passed. Independent spec re-review and quality review both approved; each independently ran 128 focused tests. Task 2 complete.

Task 3 integration spec review approved all four documentation/browser-test files. It independently ran the native Chromium suite: 9 passed, 0 skipped, 11.9s. Primary final verification: backend 683 passed, 9 Docker-dependent PostgreSQL skips in 26.19s; frontend 352 tests/7 files passed in 4.64s; typecheck passed; build passed in 963ms; native Chromium 9 passed, 0 skipped in 10.1s. Both command chains exited 0. `git diff --check` passed; a scoped credential-pattern scan of all 26 changed/new source, test and documentation files reported no potential credential files. No manifest, identity implementation or database migration changes. Main checkout still has only the preexisting untracked audit report. Final independent whole-diff security/quality review is in progress.

Final independent whole-diff security/quality review approved this first remediation with no actionable Critical, Important or Minor findings. Reviewer independently verified 209 backend LLM/security/translation tests, 128 frontend configuration/App/store tests and 9 native Chromium E2E tests (0 skipped, 11.5s); diff check passed. No implementation changes were required after the primary final suites. Task 3 complete. This is not a full-product security or store-readiness approval; real-provider calls and the nine Docker-dependent tests remain unverified.

Handoff: preserve branch `codex/x-video-subtitle-support` and its worktree without committing, pushing, merging or cleanup. Built extension: `/Users/gamine/Documents/Codex/2026-07-24/youtube-youtube-vibecoding-2/.worktrees/x-video-subtitle-support/extension/dist`. API and Worker have not been restarted; the user's installed extension has not been reloaded. Both backend deployment and extension reload are needed to activate this implementation. No user history, results or installation identity have been deleted; no database migrations were added or executed.
