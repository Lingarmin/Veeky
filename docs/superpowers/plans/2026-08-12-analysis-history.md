# Analysis History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-backed, completed-only analysis history to the Chrome side panel, including direct result reopening, automatic current-video restoration, pagination, and non-destructive reanalysis.

**Architecture:** PostgreSQL remains the source of truth. FastAPI exposes a read-only paginated history endpoint and accepts an explicit `force` flag that creates a new job cache key; the React side panel adds a history view and resolves startup state in the order unfinished task, latest completed result, normal selection flow.

**Tech Stack:** FastAPI, SQLAlchemy async ORM, Pydantic, PostgreSQL/SQLite tests, React 19, TypeScript, Vitest Testing Library, Playwright, Chrome Manifest V3.

---

## File Map

- Modify `api/app/api/analyses.py`: history schemas/query and forced analysis creation.
- Modify `api/tests/test_analyses_api.py`: API behavior and data exposure regression tests.
- Modify `extension/src/shared/types.ts`: history contracts and `force` create option.
- Modify `extension/src/sidepanel/api.ts`: history request client.
- Modify `extension/src/sidepanel/App.tsx`: history navigation, startup restoration, pagination, and reanalysis.
- Modify `extension/src/sidepanel/styles.css`: history list and result navigation styling.
- Modify `extension/tests/App.test.tsx`: component behavior tests.
- Modify `extension/tests-e2e/sidepanel.spec.ts`: critical extension history flow.

### Task 1: History API

**Files:**
- Modify: `api/app/api/analyses.py`
- Test: `api/tests/test_analyses_api.py`

- [ ] **Step 1: Write failing endpoint tests**

Add fixtures that store videos, completed jobs with results, completed jobs without results, queued jobs, and failed jobs. Assert `GET /v1/analyses/history`:

```python
response = await client.get("/v1/analyses/history", params={"limit": 2, "offset": 0})
assert response.status_code == 200
assert [item["jobId"] for item in response.json()["items"]] == [newest.id, older.id]
assert response.json()["hasMore"] is True
assert "llmConfig" not in response.json()["items"][0]
assert "apiKey" not in str(response.json())
```

Add separate assertions for `videoId` filtering, page two, excluding non-completed/missing-result jobs, and `limit`/`offset` validation.

- [ ] **Step 2: Verify the tests fail for the missing route**

Run: `cd api && .venv/bin/pytest tests/test_analyses_api.py -k history -v`

Expected: FAIL because `/v1/analyses/history` is not implemented.

- [ ] **Step 3: Add response models and the static history route**

Define before `/{job_id}`:

```python
class AnalysisHistoryItemResponse(ApiModel):
    job_id: str
    video_id: str
    video_title: str
    duration_ms: int
    source_language: str
    target_language: str
    completed_at: datetime
    model_name: str
    model_version: str

class AnalysisHistoryResponse(ApiModel):
    items: list[AnalysisHistoryItemResponse]
    has_more: bool
```

Query `AnalysisJob` joined to `Video` and `AnalysisResult`, filter completed jobs with non-null `completed_at`, apply optional `videoId`, order by `completed_at DESC, id DESC`, and fetch `limit + 1` rows.

- [ ] **Step 4: Verify history tests pass**

Run: `cd api && .venv/bin/pytest tests/test_analyses_api.py -k history -v`

Expected: all history tests PASS.

### Task 2: Forced Reanalysis API

**Files:**
- Modify: `api/app/api/analyses.py`
- Test: `api/tests/test_analyses_api.py`

- [ ] **Step 1: Write failing force behavior tests**

Create one completed analysis, then submit the same request with and without force:

```python
cached = await client.post("/v1/analyses", json={**payload, "force": False})
forced = await client.post("/v1/analyses", json={**payload, "force": True})
assert cached.json()["jobId"] == completed.id
assert forced.json()["jobId"] != completed.id
```

Reload the original result and assert its summary is unchanged. Assert two explicit `force=true` calls return two distinct job IDs.

- [ ] **Step 2: Verify force tests fail**

Run: `cd api && .venv/bin/pytest tests/test_analyses_api.py -k force -v`

Expected: FAIL because the request has no `force` behavior.

- [ ] **Step 3: Implement minimal forced cache-key versioning**

Add `force: bool = False` to `AnalysisCreateRequest`. Build the standard cache key first; when forced, append a UUID run token before the cache lookup. Keep transcript inspection and caches unchanged, while ensuring each forced request inserts and dispatches a new analysis job.

- [ ] **Step 4: Verify API regression suite**

Run: `cd api && .venv/bin/pytest tests/test_analyses_api.py -v`

Expected: all tests PASS.

### Task 3: Extension API Contracts

**Files:**
- Modify: `extension/src/shared/types.ts`
- Modify: `extension/src/sidepanel/api.ts`
- Test: `extension/tests/App.test.tsx`

- [ ] **Step 1: Extend the fake API and write a failing history render test**

The test fake returns:

```typescript
getHistory: vi.fn().mockResolvedValue({
  items: [{
    jobId: "job-history",
    videoId: "aircAruvnKk",
    videoTitle: "Neural networks",
    durationMs: 754000,
    sourceLanguage: "en",
    targetLanguage: "zh-Hans",
    completedAt: "2026-08-11T09:40:00Z",
    modelName: "deepseek",
    modelVersion: "deepseek-v4-flash",
  }],
  hasMore: false,
}),
```

Assert the history button loads and displays the title, `视频时长 12:34`, and a formatted completion time.

- [ ] **Step 2: Verify the component test fails**

Run: `cd extension && pnpm test -- --run tests/App.test.tsx`

Expected: FAIL because history contracts and UI do not exist.

- [ ] **Step 3: Add typed client contracts**

Add `AnalysisHistoryItem` and `AnalysisHistoryResponse`; add `force?: boolean` to create input. Add:

```typescript
getHistory(input: { videoId?: string; limit?: number; offset?: number }) {
  const query = new URLSearchParams();
  // append only supplied filters
  return request<AnalysisHistoryResponse>(`/v1/analyses/history?${query}`);
}
```

- [ ] **Step 4: Run typecheck to expose remaining UI work**

Run: `cd extension && pnpm typecheck`

Expected: type errors only where test fakes or `App` have not yet adopted `getHistory`.

### Task 4: History List and Existing Result Navigation

**Files:**
- Modify: `extension/src/sidepanel/App.tsx`
- Modify: `extension/src/sidepanel/styles.css`
- Test: `extension/tests/App.test.tsx`

- [ ] **Step 1: Add failing navigation and pagination tests**

Cover the history icon, completed item fields, empty state, retry after initial error, “加载更多”, preserving already loaded rows on pagination failure, direct result opening without `inspectVideo`/`createAnalysis`, and returning from a history result to the list.

- [ ] **Step 2: Verify the new tests fail for the intended missing behavior**

Run: `cd extension && pnpm test -- --run tests/App.test.tsx`

Expected: FAIL on missing history controls and views.

- [ ] **Step 3: Implement the history view**

Add a `history` phase, 20-row paging state, a Lucide `History` toolbar icon, unframed rows with stable title/meta layout, loading/error/empty states, and direct `getResult(jobId)` navigation. Track whether a result came from history so its back button returns to the retained list.

- [ ] **Step 4: Verify list and navigation tests pass**

Run: `cd extension && pnpm test -- --run tests/App.test.tsx`

Expected: history list tests PASS.

### Task 5: Startup Restoration and Reanalysis

**Files:**
- Modify: `extension/src/sidepanel/App.tsx`
- Test: `extension/tests/App.test.tsx`

- [ ] **Step 1: Add failing startup priority tests**

Cover these branches:

```text
registered unfinished job -> resume it without history lookup winning
no unfinished job + current video history -> newest completed result
registered failed job + current video history -> completed result fallback
no history -> existing video selection flow
```

Assert auto-open and history clicks do not call transcript inspection or analysis creation.

- [ ] **Step 2: Add a failing reanalysis test**

Store a valid current LLM config, open a historical result, click “重新分析”, and assert:

```typescript
expect(api.createAnalysis).toHaveBeenCalledWith(expect.objectContaining({
  videoId: "aircAruvnKk",
  force: true,
}));
```

- [ ] **Step 3: Verify tests fail**

Run: `cd extension && pnpm test -- --run tests/App.test.tsx`

Expected: FAIL because startup restoration and force reanalysis are absent.

- [ ] **Step 4: Implement priority resolution and reanalysis**

On initialization, recover an unfinished registered job first. Otherwise request the newest completed record filtered by current `videoId`; fetch its result when present, otherwise continue through the existing selection flow. If a registered job resolves to failed, query and open the latest completed result before showing the failure. Reanalysis uses the displayed result metadata, current LLM settings, `force: true`, and the normal job registration/polling path.

- [ ] **Step 5: Verify component regression tests**

Run: `cd extension && pnpm test -- --run tests/App.test.tsx`

Expected: all component tests PASS.

### Task 6: End-to-End Coverage and Full Verification

**Files:**
- Modify: `extension/tests-e2e/sidepanel.spec.ts`

- [ ] **Step 1: Add a mocked history route to the extension browser test**

Intercept the local API for a completed history item and result. Assert a same-video side panel opens the stored result and its timestamp still seeks the existing player without reloading the page.

- [ ] **Step 2: Run extension verification**

Run:

```bash
cd extension
pnpm test -- --run
pnpm typecheck
pnpm build
```

Expected: all Vitest tests PASS, TypeScript exits 0, and Vite build exits 0.

- [ ] **Step 3: Run API verification**

Run: `cd api && .venv/bin/pytest`

Expected: all API tests PASS.

- [ ] **Step 4: Rebuild and health-check local services**

Run:

```bash
docker compose up -d --build api worker
docker compose ps
curl -fsS http://127.0.0.1:8000/health
```

Expected: API and worker are running; health endpoint returns a successful response.

- [ ] **Step 5: Review the acceptance criteria and diff**

Check that only completed jobs appear, old results remain immutable, current-video history auto-opens, paging is usable, secrets are absent, and existing transcript/seek/settings behavior remains covered. Do not commit unless the user explicitly requests it.
