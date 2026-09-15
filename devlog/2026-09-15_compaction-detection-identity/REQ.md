# REQ - Identity-based compaction detection (stop the per-turn false resets)

- Task ID: `2026-09-15_compaction-detection-identity`
- Home Repo: `opencode-acp`
- Created: 2026-09-15
- Status: Done
- Priority: P0
- Owner: paradox8599
- References: live session `ses_f626c3e02ffePy3ZFAnHEF18vb`; ACP daily log 2026-09-15 08:05–08:09

## 1. Background & Problem Statement

- **Context**: While investigating `/acp context` showing all zeros, the ACP daily log revealed `state: Detected compaction - reset stale state` firing every ~10s — once per model request — with a `timestamp` ≈ "now" that kept advancing.
- **Root cause chain**:
  1. V2 AI messages (the context-hook input) carry no per-message timestamps; `lib/v2/ai-adapter.ts` fabricated `time.created = now` for every message.
  2. The harness compaction checkpoint appears as a user message containing `<conversation-checkpoint>` and is mapped to `role: "assistant", summary: true` — also with `created = now`, recomputed on every request.
  3. `findLastCompactionTimestamp` returned that synthetic "now" → `updatePerTurnState` (lib/state/state.ts) saw `timestamp > state.lastCompaction` on **every** request → `resetOnCompaction` + `state.lastCompaction = now`.
- **Current behavior (symptom)**:
  - `/acp context` showed all zeros (every message looked "compacted": `created < lastCompaction ≈ now`).
  - Nudges, message refs (`messageIds`), the tool cache and the usage baseline were wiped once per turn.
  - `countTurns` was always 0 (turn nudges dead); token accounting skipped every message.
- **Expected behavior**: a compaction is detected exactly once, keyed on the checkpoint's identity; `lastCompaction` reflects the real compaction time.
- **Impact**: silent, session-wide degradation of the nudge/GC/accounting subsystems (present since the V2 port, not introduced by the 2026-09-15 fixes).

## 2. Constraints & Non-Goals

- **Constraints**:
  - The AI path cannot supply real timestamps — do not invent them; the transcript path (`session-adapter`, tools/commands) is the trusted source.
  - No behavior change to the model-facing pipeline (prune/summary handling unchanged).
- **Non-Goals**:
  - Reconstructing historical boundaries for sessions whose state files were poisoned (self-heal on the next transcript-derived call is enough).
  - Changing V1-era consumers of `findLastCompactionTimestamp`.

## 3. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] Repeated turns with the same checkpoint reset state exactly once (identity comparison).
  - [x] A checkpoint whose `created` is re-fabricated each turn (pre-fix adapter shape) does not re-trigger detection.
  - [x] A transcript-derived checkpoint repairs a poisoned boundary and restores correct `isMessageCompacted` behavior.
  - [x] The AI-path checkpoint carries the sentinel `created = 0` and never moves the boundary.
- **Regression**:
  - [x] New tests verified to FAIL against the old timestamp-based detection.
  - [x] Full suite green apart from the known macOS `/tmp` failure.
