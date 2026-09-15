# WORKLOG - Wrap the SDK Language Model in the `language` Hook

- Task ID: `2026-09-15_hallucination-hook-wrap-fix`
- Branch: `master`
- Started: 2026-09-15
- Status: InProgress

## 2026-09-15

### Diagnosis

- User report: hallucinated `dcp-message-id` tags still appear after the parent fix.
- Reverified local soundness of the filter itself: feeding the exact leaked text through
  `HallucinationTagFilter` leaks nothing for a single chunk, all two-way splits, and
  1/2/3/5/7/11/13/17-char chunking — the stripper is not the problem.
- Read the harness (sparse clone, `v2.0.3`):
    - `packages/core/src/aisdk.ts:288` — `const result = yield* service.runLanguage({ model, sdk, options })`:
      the event has **no** `language` field.
    - `packages/core/src/aisdk.ts:289` — `result.language ?? sdk.languageModel(model.modelID ?? model.id)`:
      the hook field is an optional _output_; core falls back on its own.
    - `packages/plugin/src/effect/aisdk.ts:12-17` — `language: { readonly model; readonly sdk; readonly
options; language?: LanguageModelV3 }`.
    - `packages/core/src/plugin/host.ts` — aisdk hook plumbing writes `event.language = output.language`
      back after each callback, so chained hooks see earlier plugins' models and core reads the last value.
- Therefore `index.ts`'s `if (event.language)` guard never fired in production; the wrapper was dead code.
- Also confirmed: no other installed plugin registers a `language` hook (`ccsafety-bridge`,
  `opencode-habits` have no `aisdk` usage), so no hook clobbers ours.

### Implementation

- `index.ts`: the hook now does what core does — when the chain has not supplied a model, build the
  fallback `sdk.languageModel(event.model.modelID ?? event.model.id)` (guarded by `typeof … === "function"`,
  wrapped in `try/catch`), wrap whatever model it ends up with through `withHallucinationFilter`, and leave
  `language` unset when the SDK cannot produce one.
- `tests/v2-setup.test.ts`:
    - First test keeps only the registration assertion.
    - New test "language hook supplies a wrapped model built from the SDK fallback": production-shaped event
      (`{ model: { id }, sdk: { languageModel }, options: {} }`), asserts the hook supplies a wrapped model,
      keeps identity fields, and that streaming through it drops the tag (`"hello  world"` survives).
    - New test "language hook wraps a model from an earlier hook and tolerates missing SDK models": asserts
      interop wrapping plus the no-SDK-model and throwing-SDK paths (no throw, `language` stays unset).

### Verification

- `node --import tsx --test tests/v2-setup.test.ts tests/hallucination-filter.test.ts` → 17/17 pass.
- Regression check: reverting `index.ts` to the old `if (event.language)` guard makes the new test fail
  (`✖ language hook supplies a wrapped model built from the SDK fallback`); restored afterwards.
- `npm run typecheck` → pass.
- `npm run test` → 1299 tests, 1298 pass, 1 fail — the pre-existing, unrelated
  `tests/inactive-block-decompress.test.ts` failure (macOS `/tmp` path).
- `npm run verify:package` → pass (103 tarball entries, version 1.18.1).
- Prettier applied to the touched files.

### Status

- Implementation complete; not committed or pushed (awaiting explicit user consent).
