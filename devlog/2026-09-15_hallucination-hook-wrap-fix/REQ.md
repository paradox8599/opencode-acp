# REQ - Wrap the SDK Language Model in the `language` Hook

- Task ID: `2026-09-15_hallucination-hook-wrap-fix`
- Home Repo: `opencode-acp`
- Created: 2026-09-15
- Status: Done
- Priority: P1
- Owner: ACP maintainer
- References: `devlog/2026-09-15_strip-hallucinated-tags/` (parent fix, commit `9766daa`); harness `v2.0.3` `packages/core/src/aisdk.ts:288-292`, `packages/core/src/plugin/host.ts` (aisdk hook plumbing)

## 1. Background & Problem Statement

- **Context**: The parent fix (`9766daa`) added `lib/v2/hallucination-filter.ts` and registered
  `ctx.aisdk.hook("language", …)` in `index.ts` to strip model-hallucinated `dcp-message-id` tags from
  assistant output before the harness persists or displays it.
- **Current behavior (symptom)**: After `9766daa` (installed in a fresh plugin snapshot and loaded by the
  running server), hallucinated tags keep appearing at the end of stored assistant messages — the user
  reported "现在消息后面还是会有 … 之前的修复没生效吗？".
- **Root cause**: The `language` hook event ships **without** a model. Core calls
  `service.runLanguage({ model, sdk, options })` and only uses `result.language` when a hook supplied one,
  otherwise falling back to `sdk.languageModel(model.modelID ?? model.id)` itself
  (`packages/core/src/aisdk.ts:288-292`). The plugin host mirrors this: it builds
  `output = { model, options, sdk, language: event.language }`, applies the callback, then writes
  `event.language = output.language` back. The registration guarded on `if (event.language)`, which is
  always false in production — so `withHallucinationFilter` never ran.
- **Why the old test passed**: `tests/v2-setup.test.ts` fabricated an event containing a `language` field
  the harness never provides, so the assertion "the hook must wrap the resolved model" exercised a shape
  that cannot occur.
- **Expected behavior**: On the production event shape the hook must _supply_ a wrapped model (built from
  the same SDK fallback core would use), so the wrapper becomes the model core caches and streams through.

## 2. Reproduction (if applicable)

- **Environment**: opencode 2.0.3, darwin-arm64, provider `@ai-sdk/openai-compatible` (LiftAI).
- **Steps**: run any session where the model occasionally echoes a `dcp-message-id` tag; after `9766daa`
  the tag still reaches the stored assistant text and the UI.

## 3. Constraints & Non-Goals

- **Constraints**:
    - No new dependencies; type-only `@ai-sdk/provider` usage stays as-is.
    - Keep interop: a model supplied by an earlier hook must still be wrapped.
    - Never fail model resolution on our account — if the SDK cannot produce a model, leave `language`
      unset and let core keep its own fallback/error reporting.
- **Non-Goals** (unchanged from the parent task):
    - Cleaning already-polluted message rows.
    - Filtering reasoning deltas or tool I/O.
    - A config switch.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
    - [x] With the production event shape (`{ model, sdk, options }`), the hook sets `event.language` to a
          wrapped model built from `sdk.languageModel(...)`.
    - [x] Streaming through the hook-supplied model strips `dcp-message-id` tags while clean text survives.
    - [x] A model supplied by an earlier hook is wrapped instead of discarded.
    - [x] A missing or throwing `sdk.languageModel` leaves `language` unset and never throws.
- **Regression**:
    - [x] The updated `tests/v2-setup.test.ts` fails against the previous `if (event.language)` guard.

## 5. Design Notes (if any)

- The hook is an _output_ channel, not a wrapper seam: any plugin that replaces the model must construct it.
- Wrapping `sdk.languageModel(...)` inside the hook is safe with the language cache (`languages.set(key,
language)`), because core caches whatever the hook chain produced.
