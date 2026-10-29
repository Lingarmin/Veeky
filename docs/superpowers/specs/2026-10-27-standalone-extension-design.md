# Veeky standalone extension design

## Goal

Make Veeky usable after installing the Chrome extension and configuring a supported official LLM API key, without requiring a Veeky server, domain, or Docker installation. Keep the existing application and preserve its YouTube/X product behavior where the browser platform permits it.

## Approved product scope

- YouTube: inspect the currently selected or pasted video, determine whether a readable caption track exists, retrieve its timestamped transcript in the browser, and use the configured LLM for translation, overview, chapters, and highlights.
- X: support videos in public posts and videos available through the user's current signed-in browser session. Obtain the media from the browser and run local speech recognition using Whisper small on CPU; do not send raw audio to a Veeky server or an ASR vendor.
- Retain supported official LLM providers (Kimi, DeepSeek, Tencent Hunyuan, Qwen, and GLM). The extension calls their fixed official API origins directly. Provider usage is billed against the user's account.
- Keep completed history on-device in IndexedDB. List completed records only, open an existing completed analysis automatically for an already-analyzed video, and add a distinct history entry for each explicit reanalysis.
- Preserve the four-hour maximum. Reject longer videos with the user-facing message that the video is too long to analyze.
- Keep translated timestamp navigation and the X in-page subtitle overlay.
- Provide an optional old-backend history import. It must be user-initiated, limited to completed records available to the current installation identity, idempotent, and non-destructive. Do not shut down or delete old data during migration.

## Architecture

The Chrome extension is the product runtime. `sidepanel` provides the UI; the extension service worker coordinates tab discovery, active-video messaging, permissions, and task lifecycle; an extension-owned offscreen document performs long-lived media and inference work when supported. All durable task state and completed analyses are written locally. Closing the browser interrupts work; a checkpoint is saved and the user can explicitly resume after reopening. The side panel can close without deleting a task.

Use a local analysis service behind the existing UI-facing analysis interface so components do not know whether a task is queued, running, or recovered. The service persists only non-secret task metadata, checkpoints, transcripts, and results. The LLM key is passed only to a trusted extension context for the duration of a direct provider request. Key storage defaults to session-only; users may explicitly choose “remember on this device.” Keys are not synchronized, copied into task rows, results, exports, logs, or page-world messages. Restrict Chrome storage areas to trusted extension contexts.

For YouTube, read caption track metadata from the active watch-page player state through a narrowly scoped, one-shot main-world extraction, then fetch only the selected caption track from YouTube in an extension context. Do not inject or expose the LLM key in the page world. Clearly report when captions are absent, unavailable, or unreadable; this scope does not add YouTube ASR.

For X, retain the existing page-context media detection and route identity logic, but replace upload-to-backend with local media acquisition and decoding. Feed bounded audio windows to a browser-compatible Whisper small ONNX model through a bundled JavaScript/WASM runtime, with model weights downloaded as data after user initiation and cached locally. Translation starts only after transcription segments have been checkpointed. Never silently substitute a smaller model, cloud ASR, or remote Veeky service.

## Storage and data model

- IndexedDB database versioned independently from Chrome key storage.
- `analyses`: one immutable row per completed run; includes video identity, title, duration, source/target languages, timestamps, transcript, overview, chapters, highlights, model and completion metadata. Does not include API keys.
- `tasks`: a resumable task row with explicit stage/state, progress, timestamps, source references, and failure code. Does not include API keys or signed media URLs.
- `transcriptChunks` (or equivalent): durable bounded checkpoints keyed by task and sequence; retain only the local data needed to resume. Expiring signed media URLs and fetched media bytes are excluded from persistent task records.
- A configured local storage limit and cleanup action must be defined before release. Do not silently delete completed history as part of migration or upgrade.
- Reanalysis creates a new record. Automatic lookup selects the most recently completed record for the normalized platform/content/media identity.

## Security and permissions

- Fixed provider registry maps provider IDs to one official HTTPS origin; no arbitrary relay URLs.
- Extension-only fetches carry API keys. Never pass secrets to a content script, `window.postMessage`, page DOM, or YouTube/X requests.
- Deny redirects for LLM requests and validate the destination against the selected provider before sending credentials.
- Add only the provider and model-file hosts required by selected features; avoid wildcard all-site access.
- Local history is installation/profile-local and is not synced. Page content remains on-device except for the transcript text sent to the user-selected LLM provider.
- Keep existing sensitive content permissions scoped to YouTube, X, and media hosts. Remove backend localhost and self-hosted server permissions from the standalone package.

## Error handling and runtime limits

- Model download, local transcription, LLM translation, and LLM summary have separate visible progress and failure states.
- Default to one active analysis at a time. Keep bounded transcript batches and audio windows, enforce the four-hour limit, abort requests/tasks when cancelled, and checkpoint successful units before advancing.
- Retry only recoverable requests; never repeat already checkpointed provider work without a deliberate retry decision. On restart, explain that resuming may make new billable provider requests.
- Verify CPU Whisper small latency, memory, audio decoding, model download, and Chrome Web Store MV3 packaging before representing X as generally ready. Do not claim real-time behavior unless measured.

## Migration and rollout

1. Implement local YouTube captions, direct LLM processing, and local history while preserving the current backend for an explicit import path.
2. Implement and benchmark X local decode + Whisper small before enabling the feature by default.
3. Add an idempotent installation-scoped history importer; verify imported record counts and sample content without logging transcript bodies.
4. Remove normal-flow backend dependencies, backend URL injection, server host permissions, and deployment instructions from the standalone build. Retain any migration-only compatibility behind an explicit user action and a clear warning that the old service must be temporarily reachable.

## Acceptance criteria

1. A clean extension install can configure an official key and analyze a YouTube video with browser-readable captions while the Veeky API/Docker services are stopped.
2. YouTube caption availability is checked before analysis; timestamped original and translated segments are displayed.
3. Translation, summary, chapters, and highlights call only the selected official provider origin and are validated before persistence.
4. X local Whisper small CPU inference works on supported media, returns timestamps, and displays accurate download/transcription/translation progress; if local decoding or performance is unsuitable, show a specific limitation rather than falling back to a server.
5. Completed history is local, completed-only, survives extension/browser restarts, opens automatically for known videos, and reanalysis adds a new row.
6. Browser closure stops work without losing completed checkpoints; restart offers explicit resume. Closing only the side panel does not clear persisted task data.
7. Keys are absent from IndexedDB, task/history exports, task messages, logs, and page contexts. Session-only and remembered-device behavior are independently tested.
8. Four-hour boundary and over-limit message are verified.
9. Existing backend data remains untouched until a user completes and verifies optional migration.
10. The production package has no runtime Veeky server/domain dependency, no localhost backend permission, and no remotely hosted executable JavaScript/WASM.

## Out of scope

- Veeky-hosted API keys, proxy services, shared quotas, or server-side billing.
- YouTube speech recognition when captions are unavailable.
- Remote/cloud X ASR, a smaller silent fallback model, or a promise of real-time CPU transcription.
- Automatic destructive deletion of old server data or automatic backend retirement.
