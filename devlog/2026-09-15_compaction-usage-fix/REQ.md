# REQ - Provider Usage Accounting & Compaction Coexistence Fix

- Task ID: `2026-09-15_compaction-usage-fix`
- Home Repo: `opencode-acp`
- Created: 2026-09-15
- Status: Done
- Priority: P0
- Owner: ACP maintainer
- References: live session `ses_f626c3e02ffePy3ZFAnHEF18vb`, ACP log `~/.config/opencode/logs/acp/daily/2026-09-15.log`

## 1. Background & Problem Statement

- **Context**: The V2 port reads provider usage from the `session.usage.updated` event (`index.ts` subscription). V2 AI messages carry no `tokens` field, so this event is the only real prompt-size signal for nudge thresholds and the budget guard.
- **Current behavior (symptom)**:
    1. The event reports SESSION-CUMULATIVE totals (live evidence: 180,747,559 → 182,822,537 across requests). ACP stored the total as `lastUsedTokens`, so `getCurrentTokenUsage()` returned it and the transform logged `prePruneTokens=182725178 usagePct=18272.5%` on a 1M-window model → permanent "context critically full" nudges and a poisoned persisted state file.
    2. `resetOnCompaction()` left `lastUsedTokens` untouched, so the poisoned value survived OpenCode's compaction.
    3. Fallbacks in `getCurrentTokenUsage()` and `estimateWireTokens()` ran the Anthropic tokenizer (BPE) over the entire history on every transform (~25 ms/message) → ~50 s message-transform stalls at 449 messages.
- **Expected behavior**: usage reflects the LATEST request, implausible values are rejected, compaction re-baselines accounting, and fallbacks are cheap (chars/4 estimator).
- **Impact**: false nudges, misleading context percentages, message-send stalls on long sessions; README carried a "compaction conflicts with ACP" warning.

## 2. Reproduction (if applicable)

- **Environment**:
    - Node: 24.19.0
    - OS/Arch: darwin-arm64
    - opencode2 (V2 CLI), model context window 1,000,000
- **Minimal reproduction steps**:
    1. Run a session with the V2 plugin enabled past one compaction.
    2. Observe `usagePct=18xxx%` in `~/.config/opencode/logs/acp/daily/<date>.log` and the "context critically full" nudge.
- **Relevant configuration**: defaults (`compress.mode=range`, default `gc`).

## 3. Constraints & Non-Goals

- **Constraints**: V2-only; no V1 paths; persisted state format stays backward compatible (new field is optional; old files load unchanged).
- **Non-Goals**: recovering messages deleted by OpenCode compaction (impossible); changing default nudge thresholds.

## 4. Acceptance Criteria

- [x] `lastUsedTokens` reflects the latest request delta, not the session-cumulative total.
- [x] Implausible usage values are rejected and the estimator is used instead.
- [x] Compaction detection clears stale per-request usage.
- [x] Fallback estimation no longer runs a full BPE scan per transform.
- [x] README wording matches the supported behavior.
