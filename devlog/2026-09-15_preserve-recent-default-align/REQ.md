# REQ - Align preserveRecentMessages / preserveRecentTokens default claims on 5 / 5000

- Task ID: `2026-09-15_preserve-recent-default-align`
- Home Repo: `opencode-acp`
- Created: 2026-09-15
- Status: Done
- Priority: P2
- Owner: paradox8599
- References: `defaultConfig` (`lib/config.ts:314`), `devlog/2026-07-27_release-v1.14.3/` (the 20→5 / 20000→5000 change), `devlog/2026-09-15_agents-config-table-sync/` follow-up #1

## 1. Background & Problem Statement

- **Context**: v1.14.3 lowered the protected-tail defaults to `preserveRecentMessages: 5` / `preserveRecentTokens: 5000` (`lib/config.ts:357-358`). Several non-historical places still described the old 20 / 20000 values as "the production default".
- **Current behavior (symptom)**: stale claims at `lib/config.ts:117` ("default: 20"), `lib/config.ts:119` ("default: 20000"), `lib/compress/pipeline.ts:459` (`?? 20` fallback in the protected-zone error text), AGENTS.md §5.7.1 ("production default: 20"), plus comments/test title in `tests/context-limit-fallback.test.ts` and `tests/compression-candidates-switch.test.ts` calling an explicit `preserveRecentMessages: 20` the "production config/default".
- **Expected behavior**: every non-historical claim and fallback matches the actual default 5 / 5000.
- **Impact**: readers (humans, agents, tests authors) plan against a wrong protected-zone size — AGENTS.md §5.7.1's compliance rule literally instructed "use the production default: 20".

## 2. Reproduction (if applicable)

- **Environment**: N/A (docs + one error-text constant)
- **Minimal reproduction steps**: `grep -rn "production default" AGENTS.md lib/ tests/` → 20 claimed, while `lib/config.ts:357` says 5.
- **Relevant configuration**: N/A

## 3. Constraints & Non-Goals

- **Constraints**:
  - The actual default stays 5 / 5000 (the v1.14.3 decision is not revisited).
  - `pipeline.ts:459`'s value is interpolated into the model-facing "Protected zone: last N messages" error text — the aligned value must not alter control flow.
- **Non-Goals** (explicitly out of scope):
  - Resizing test fixtures that deliberately use `preserveRecentMessages: 20` (their scenarios are sized around a 20-message zone; they remain valid `> 0` coverage).
  - Rewriting historical devlog entries (2026-07-26/27) — they record the state at that time.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] `grep -rn "default: 20\|?? 20\|production default: 20" AGENTS.md lib/ tests/` returns only historical devlog hits.
  - [x] `pipeline.ts:459` fallback equals `defaultConfig.compress.preserveRecentMessages`.
- **Regression**:
  - [x] Existing test behavior unchanged; typecheck + affected suites pass.
