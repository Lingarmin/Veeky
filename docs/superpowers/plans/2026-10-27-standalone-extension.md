# Veeky Standalone Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use task-by-task implementation with the repository's test-first workflow. Keep the old backend available only for explicit migration until imported data is verified.

**Goal:** Deliver a Chrome extension that runs without a Veeky server/domain, calls only the user's configured official LLM provider, stores completed results locally, and performs X video ASR locally with CPU Whisper small.

**Architecture:** Keep UI and platform adapters separate from a local analysis engine. Use an IndexedDB repository for analyses, checkpoints, and transcript chunks; a trusted extension-context key broker for provider requests; page-scoped adapters for YouTube captions and X media discovery; and a bundled browser-compatible ASR runtime with local model data. The previous API remains an opt-in, read-only history migration source until migration verification.

**Tech Stack:** TypeScript, React, Chrome MV3 APIs, IndexedDB, Vitest, Playwright, Transformers.js, ONNX Runtime Web/WASM, ONNX Whisper small assets.

---

## Scope and file map

- `extension/src/sidepanel/App.tsx`: UI state and screens; route actions through local analysis and local history interfaces.
- `extension/src/sidepanel/api.ts`: retain only as optional legacy import adapter; never instantiate it for normal analysis.
- `extension/src/sidepanel/llm.ts`: provider registry, selected config, session/device key policy, and trusted storage access.
- New `extension/src/local/analysis.ts`: local orchestration for inspection, analysis, progress, checkpoints, cancellation, and resume.
- New `extension/src/local/repository.ts`: versioned IndexedDB schema and typed CRUD for tasks, completed analyses, and transcript chunks.
- New `extension/src/local/llm-client.ts`: fixed-origin official provider calls, request schema, response parsing, error mapping, retry policy, and redirects disabled.
- New `extension/src/local/prompts.ts`: provider-neutral translation, overview, chapters, and highlights prompts/contracts.
- New `extension/src/local/youtube-captions.ts`: typed caption track/segment validation and parsing helpers.
- `extension/src/background.ts`, `extension/src/shared/types.ts`, and `extension/src/sidepanel/browser.ts`: active tab, current video identity, one-shot tab-scoped extraction and task event bridge.
- `extension/src/offscreen/index.ts` and `extension/offscreen.html`: local X audio acquisition/decode/ASR orchestration, progress events, bounded work, cancellation, and resume hooks.
- New `extension/src/local/x-asr.ts`: Transformers.js pipeline initialization, local model download/cache, CPU selection, and timestamp conversion.
- `extension/manifest.json`, `extension/vite.config.ts`, `extension/package.json`, and `extension/build/`: standalone permissions and bundled MV3-safe runtime assets.
- `extension/tests/`, `extension/tests-e2e/`, and docs: test local behavior and document migration/setup/privacy.

## Task 1: Establish local repository contracts

1. Add failing tests for a versioned repository: create an interrupted task, save a completed transcript chunk, reopen repository, and read the checkpoint; ensure analysis rows never accept a key field; list only completed analyses, sorted newest first; duplicate import keys are idempotent; reanalysis uses a new record ID.
2. Run `pnpm --dir extension test -- repository.test.ts` and confirm failures are about missing repository operations.
3. Implement `extension/src/local/repository.ts` with narrow methods: `createTask`, `updateTask`, `saveChunk`, `getChunks`, `completeAnalysis`, `getCompletedHistory`, `findLatestCompleted`, and `importCompletedIfAbsent`.
4. Keep provider credentials out of all exported repository record types; add runtime validation to reject unknown secret-bearing fields.
5. Re-run the repository test and `pnpm --dir extension typecheck`.

## Task 2: Move key handling to trusted extension storage

1. Add failing tests for session-only default, explicit remember-on-device, provider switching, key exclusion from serialized analysis data, malformed legacy values being quarantined, and trusted-only storage access configuration.
2. Run `pnpm --dir extension test -- llm.test.ts` and verify the new cases fail before implementation.
3. Update `extension/src/sidepanel/llm.ts` with an explicit persistence preference. Session-only values go to `chrome.storage.session`; opted-in values go to `chrome.storage.local`. Restrict both areas to trusted extension contexts on startup. Keep provider origins fixed and models editable.
4. Update the settings UI in `extension/src/sidepanel/App.tsx` with clear session/device-copy choice and a note that transcript text is sent to the selected LLM provider.
5. Run LLM and App tests, typecheck, and inspect emitted manifest/storage code for accidental page-context secret access.

## Task 3: Implement direct official LLM client and local result generation

1. Add failing tests for provider-origin allowlisting, redirect denial, no credential-bearing URL, API-key redaction in errors, provider response parsing, batch/segment identity preservation, invalid JSON contracts, retryable 429/5xx, and non-retryable auth errors.
2. Run `pnpm --dir extension test -- llm-client.test.ts` to establish expected failures.
3. Implement `extension/src/local/llm-client.ts` using `fetch` only from trusted extension context. Resolve provider ID to the immutable official base URL and append the official chat completion path. Set `credentials: "omit"`, `redirect: "error"`, bounded timeout, and only the selected provider key in Authorization.
4. Port compatible prompt/validation semantics from `api/app/services/llm.py`, `api/app/services/llm_providers.py`, and `api/app/workers/tasks.py` into `prompts.ts` and pure validation helpers. Preserve provider-specific optional JSON/thinking parameters only where supported; never weaken structured-result validation.
5. Implement bounded transcript translation batches and stable segment IDs. Save each successful batch checkpoint before submitting the next.
6. Run direct-client, prompt-contract, translation, and analysis validation tests.

## Task 4: Read YouTube captions in the active browser

1. Add failing tests for URL/video identity parsing, no caption tracks, generated/manual track metadata, caption language selection, malformed JSON3/XML response, timestamp normalization, and segment ID stability.
2. Run `pnpm --dir extension test -- youtube-captions.test.ts` and establish expected failures.
3. Add a one-shot request/response protocol in `shared/types.ts`, `browser.ts`, and `background.ts`. Restrict sender to extension UI and target tab URL to YouTube; use a main-world function only to read caption track metadata from the player. Do not include API credentials in this protocol.
4. Fetch the selected track through the extension fetch context using the track URL and parse supported YouTube caption formats into validated `{id,startMs,durationMs,original,translated:null}` segments.
5. Enforce the 4-hour maximum and expose explicit `ready`, `captions_unavailable`, `video_too_long`, and `video_metadata_unavailable` states before starting LLM work.
6. Test active-tab and pasted-link flows, manual/generated captions, failed requests, 4-hour boundary, and no backend availability.

## Task 5: Connect the local YouTube analysis flow and local completed history

1. Add failing App tests for configure-key guidance, caption inspection before analysis, progress phases, translation failure retaining original transcript, completed history auto-open, completed-only history, and reanalysis adding a separate record.
2. Run focused App tests and confirm expected failures.
3. Implement `extension/src/local/analysis.ts` and a typed dependency interface. Pipeline order: inspect captions → validate duration → create local task → translate batches/checkpoints → generate overview/chapter/highlight → validate time ranges/text distinction → atomically persist completed result.
4. Replace normal-flow `api.inspect/createAnalysis/getStatus/getResult/getHistory` usage in `App.tsx` with local engine/repository calls while leaving explicit history import as a separate optional action.
5. Preserve in-page timestamp seeking and result display, but persist latest completed content identity for automatic result lookup.
6. Run focused App, repository, LLM, typecheck and build tests. In a fresh browser profile, deny all network by default except YouTube and mocked official provider; verify analysis succeeds with the old Veeky backend unavailable.

## Task 6: Replace backend X upload/ASR with local CPU Whisper small

1. Add failing tests around media candidate selection, four-hour duration rejection, media URL origin validation, bounded fetch/cancel, model download progress/cache, CPU pipeline configuration, timestamp conversion, partial checkpoint recovery, and missing audio track.
2. Run focused offscreen and ASR tests to establish expected failures.
3. Add a compatible local Whisper small ONNX model package and pin exact runtime/model revisions. Bundle all executable JS/WASM required by MV3; model weights are data and may be fetched only after explicit user action from a documented host. Add model-download UI/progress and cache integrity/versioning.
4. Refactor the offscreen pipeline to consume locally fetched X media and bounded audio windows; do not call `createMediaSession`, `uploadPart`, or Veeky endpoints. Preserve URL and route-epoch checks; validate that media comes from the expected X media host.
5. Convert speech segments into timestamped transcript rows; checkpoint each completed window. Use CPU-only settings with the Whisper small model identity fixed in product configuration. Expose distinct model download, local transcription, translation, and summary states.
6. Test stream interruption, expired URL recovery via re-open/re-play, memory/resource failure mapping, side panel close/reopen, browser restart resume prompt, in-page overlay, and no raw audio network egress except the already-authenticated media fetch.
7. Run a real manual benchmark on a supported machine for representative short/medium videos. Record machine, model artifact, download size, processing time, and peak memory in internal test docs. Do not call the feature real-time unless measured accordingly.

## Task 7: Add safe optional migration and standalone package

1. Add failing tests proving migration is opt-in, only uses current installation identity, imports completed results only, is idempotent, and never deletes source records.
2. Implement a read-only importer using the legacy API adapter. Request small pages and validate every result before import; never persist the installation token in IndexedDB. Ask for confirmation before sending local history data to the old backend and show only counts/status, not transcript bodies, in migration logs.
3. Remove localhost host permissions and mandatory backend origin injection from the standalone package. Add only fixed official provider origins and model-data host(s) required by the pinned model. Keep X/YouTube permissions as narrow as current behavior allows.
4. Update `extension/vite.config.ts`, `extension/build/`, `README.md`, `docs/production-deployment.md`, and user-facing privacy copy to explain install → official key → use, provider billing, local history, local X ASR model download, permission rationale, and unsupported caption limitations.
5. Build a release package and inspect the manifest, bundle strings, CSP, and network requests to ensure no Veeky API origin, localhost permission, server URL, remote executable JS/WASM, or API key appears.
6. Test clean install, import opt-in, cancellation/retry, no-backend YouTube workflow, no-backend X workflow, history retention, and official provider request routing.

## Final verification

- Run `pnpm --dir extension test` and `pnpm --dir extension typecheck`.
- Run `pnpm --dir extension build` and `pnpm --dir extension test:e2e` with deny-by-default network routing and explicit mocks.
- Run the API test suite only to verify optional history-import compatibility remains read-only; do not make the old API a release dependency.
- Check `git diff --check`, inspect `git status --short`, compare standalone package manifest/permissions against the spec, and verify no existing data volumes, API env file, installation profile, or old history was changed.
- Report separately the automated test result, actual manual ASR benchmark, migration status, and any unsupported X playback cases.
