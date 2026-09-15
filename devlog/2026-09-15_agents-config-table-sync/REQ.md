# REQ - AGENTS.md §2.4 default-config table sync

- Task ID: `2026-09-15_agents-config-table-sync`
- Home Repo: `opencode-acp`
- Created: 2026-09-15
- Status: Done
- Priority: P2
- Owner: paradox8599
- References: AGENTS.md §2.4, `lib/config.ts:314-396`, `lib/config.ts:398-458`

## 1. Background & Problem Statement

- **Context**: AGENTS.md is the fork-local spec and is treated as source of truth by both humans and AI agents. Its §2.4 "Default Configuration" snapshot was written during the V1 era and never re-synced after the V2 port.
- **Current behavior (symptom)**: The documented defaults diverged from `defaultConfig` in `lib/config.ts` in ~20 fields — stale: `pruneNotification: "detailed"` (actual `"off"`), `compress.mode: "range"` (field no longer exists), `maxContextLimit`/`minContextLimit` "55%"/"45%" (actual `"80%"`/`"80%"`), `gc.maxBlockAge: 15` (actual no-op `Number.MAX_SAFE_INTEGER`), `protectedTools: ["skill"]` (actual `["skill", "compress"]`). Whole sections missing: `logLevel`, `compress.candidates`, `compress.contextLimitFallback`, growth-nudge fields, `compress.reasoning`, `gc.batchCleanup`, `qualityGate`, `messageFilters`, and ~15 more `compress` fields.
- **Expected behavior**: §2.4 mirrors `defaultConfig` (`lib/config.ts:314`) key-for-key, and the config-layering block matches `getConfigPaths()` (`lib/config.ts:398-458`).
- **Impact**: Stale defaults mislead anyone (human or agent) reasoning from AGENTS.md about runtime behavior.

## 2. Reproduction (if applicable)

- **Environment**: N/A (docs-only change)
- **Minimal reproduction steps**: `diff` the §2.4 code block against `lib/config.ts:314-396`.
- **Relevant configuration**: N/A

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: none — docs only, no code or default changes.
  - Keep the block formatted as the existing style (aligned inline comments).
- **Non-Goals** (explicitly out of scope):
  - Changing any code or default values.
  - Exhaustively documenting optional keys (only a one-line list of keys with no default).
  - Syncing unrelated sections (e.g. §2.5 storage-path table, §5.7's "production default: 20" note — flagged as follow-up).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] Every key/value in the §2.4 block matches `defaultConfig` (`lib/config.ts:314-396`).
  - [x] Layering block matches `getConfigPaths()` incl. `.json`/`.jsonc` preference, XDG global fallback, `$OPENCODE_CONFIG_DIR` gating, nearest-ancestor project discovery.
- **Regression**:
  - [x] No other section of AGENTS.md modified.
