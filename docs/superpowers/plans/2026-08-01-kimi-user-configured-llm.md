# User-configured Kimi LLM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each extension user configure a Kimi-compatible API URL and key, test connectivity, and use that provider for subtitle translation and video summaries.

**Architecture:** The side panel stores the two-field LLM configuration in `chrome.storage.local` and sends a validated snapshot to the API when creating an analysis. The API stores that snapshot on the analysis job so Celery retries use the same provider, while result records contain only model metadata. A shared Kimi OpenAI-compatible client powers both batched translation and structured summary generation.

**Tech Stack:** FastAPI, Pydantic, SQLAlchemy/Alembic, Celery, httpx, React, TypeScript, Vitest.

---

### Task 1: Add the provider contract and backend configuration validation

**Files:**
- Create: `api/app/services/llm.py`
- Modify: `api/app/services/analysis.py`
- Modify: `api/app/services/translation.py`
- Test: `api/tests/test_llm.py`

- [ ] **Step 1: Write failing tests** for URL normalization, successful JSON extraction, authentication errors, Kimi translation batches, and Kimi summary requests.
- [ ] **Step 2: Run `cd api && ./.venv/bin/pytest tests/test_llm.py -q` and confirm the new provider imports or behavior fail.
- [ ] **Step 3: Implement a shared `KimiClient`, `KimiTranslationProvider`, and `KimiAnalysisProvider` using `/v1/chat/completions`, Bearer auth, JSON-only prompts, bounded retries, and redacted error messages.
- [ ] **Step 4: Run the focused tests and confirm they pass.

### Task 2: Persist per-job LLM configuration and expose API endpoints

**Files:**
- Modify: `api/app/db/models.py`
- Create: `api/alembic/versions/0003_analysis_job_llm_config.py`
- Modify: `api/app/api/analyses.py`
- Modify: `api/app/core/settings.py`
- Modify: `api/tests/test_analyses_api.py`
- Modify: `api/tests/test_models.py`
- Modify: `api/tests/test_settings.py`

- [ ] **Step 1: Add failing API tests** proving missing config is rejected, valid config is stored on the job, cache keys differ by provider fingerprint, and `/v1/llm/test` maps provider failures to safe response codes.
- [ ] **Step 2: Run the focused API/model tests and confirm failure.
- [ ] **Step 3: Add the JSON `llm_config` job column and migration, request/response models, validation, test endpoint, and cache fingerprint logic. Never include the key in result responses or error text.
- [ ] **Step 4: Run the focused API/model tests and confirm they pass.

### Task 3: Make Celery build Kimi services from the job snapshot

**Files:**
- Modify: `api/app/workers/tasks.py`
- Modify: `api/tests/test_tasks.py`
- Modify: `api/.env.example`
- Modify: `README.md`

- [ ] **Step 1: Add a failing pipeline test** showing a job snapshot selects the Kimi providers and that translation and summary failures retain their existing status codes.
- [ ] **Step 2: Run the focused task test and confirm failure.
- [ ] **Step 3: Build provider instances from `AnalysisJob.llm_config` at execution time, preserve injected fake providers in existing tests, and remove the old server-side analysis-provider requirement from the default pipeline.
- [ ] **Step 4: Run all API tests and confirm they pass.

### Task 4: Add extension storage, connectivity API, and analysis gating

**Files:**
- Modify: `extension/src/shared/types.ts`
- Create: `extension/src/sidepanel/llm.ts`
- Modify: `extension/src/sidepanel/api.ts`
- Modify: `extension/src/sidepanel/store.ts`
- Modify: `extension/src/sidepanel/App.tsx`
- Modify: `extension/src/sidepanel/styles.css`
- Modify: `extension/tests/App.test.tsx`
- Create: `extension/tests/llm.test.ts`

- [ ] **Step 1: Add failing tests** for local config persistence, settings rendering, connectivity testing, and blocking analysis until URL and key are configured.
- [ ] **Step 2: Run the focused extension tests and confirm failure.
- [ ] **Step 3: Implement local storage helpers, API methods, a settings view with masked key and test button, a missing-config banner, and analysis request propagation.
- [ ] **Step 4: Run all extension tests, typecheck, and build.

### Task 5: Verify the integrated change

**Files:**
- Modify: `README.md` if operational instructions need correction.

- [ ] **Step 1: Run `cd api && ./.venv/bin/pytest tests -q`.
- [ ] **Step 2: Run `cd extension && pnpm test && pnpm typecheck && pnpm build`.
- [ ] **Step 3: Run `git diff --check` and inspect that no API key appears in tracked files or test output.
- [ ] **Step 4: Restart API and Worker only after the code and tests pass, then report that real Kimi connectivity still requires the user to enter their own key in the plugin.
