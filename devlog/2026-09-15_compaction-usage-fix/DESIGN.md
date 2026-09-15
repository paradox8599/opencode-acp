# DESIGN - Provider Usage Accounting & Compaction Coexistence

- Task ID: `2026-09-15_compaction-usage-fix`
- Home Repo: `opencode-acp`
- Created: 2026-09-15
- Status: Accepted

## 1. Problem Statement

- **What problem are we solving?**: `session.usage.updated` carries session-cumulative totals; ACP treated them as the latest request size (false nudges, poisoned state), did not re-baseline on compaction, and used a full-history BPE scan as fallback (transform stalls).
- **Why now?**: The V2 port made this event the only real usage source — the bug is live-visible (18,000%+ usage) and stalls long sessions.

## 2. Goals & Non-Goals

- **Goals**: per-request delta accounting with a persisted cumulative baseline; plausibility guards; cheap estimation fallback; compaction re-baseline; correct docs.
- **Non-Goals**: per-message precision (the event is per-request); recovering compacted-away messages.

## 3. Current Architecture (if applicable)

- **How it works today**: `index.ts` explicitly sums the five usage counters into `state.lastUsedTokens`; `getCurrentTokenUsage()` returns it when > 0; `resetOnCompaction()` resets transient state except usage; fallbacks call `countAllMessageTokens()` (Anthropic BPE) per message.
- **Pain points**: cumulative totals accumulate across requests; stale value survives compaction; O(history) tokenization per transform.

## 4. Proposed Architecture

- **Overview**:

```
session.usage.updated (cumulative total)
        │  sumUsageTokens(tokens)
        ▼
applyUsageTotals(state, total)            lib/v2/usage.ts
   ├─ reject if !isPlausibleContextTokens  (ceiling 10M + model window)
   ├─ total > baseline → lastUsedTokens = delta, baseline = total
   ├─ total < baseline → re-baseline, no delta
   └─ persist on change

getCurrentTokenUsage(state, ...)          lib/token-utils.ts
   ├─ lastUsedTokens (guard: plausible only)
   └─ estimateAllMessageTokensFast()      (chars/4)

estimateWireTokens(state, messages, ...)  lib/messages/enforce-budget.ts
   ├─ V1 path: token-bearing assistant messages (unchanged)
   ├─ V2 path: getProviderUsedTokens + fast estimate of messages after it
   └─ fallback: fast estimate

resetOnCompaction(state)                  lib/state/utils.ts
   └─ lastUsedTokens = undefined (lastCumulativeUsage stays valid)
```

- **Key components**: `lib/v2/usage.ts` (new), `lib/token-utils.ts`, `lib/messages/enforce-budget.ts`, `lib/state/utils.ts`, `lib/state/{types,state,persistence}.ts`.
- **Data flow**: event → baseline/delta → thresholds & budget guard → persisted state.
- **API / interface changes**: new optional `SessionState.lastCumulativeUsage` (string-key persisted as `lastCumulativeUsage`).

## 5. Design Decisions & Rationale

| Decision | Options Considered | Chosen | Why |
|----------|--------------------|--------|-----|
| Cumulative vs delta | use total as-is; delta vs persisted baseline | delta + persisted baseline | matches "latest request size" semantics the thresholds expect |
| Persist baseline | in-memory only; persisted | persisted | a restarted process would otherwise treat the next total as a huge delta |
| Guard invalid values | none; clamp to window; reject | reject + fall back to estimator | clamping invents numbers; rejection degrades gracefully |
| Fallback estimator | BPE scan; chars/4 | chars/4 | ~25 ms/message vs O(n) fast scan; accuracy acceptable for thresholds |
| Compaction reset | reset everything; clear usage only | clear `lastUsedTokens` only | blocks and the monotonic cumulative counter stay valid |

## 6. Impact Analysis

- **Backward compatibility**: old state files load unchanged; a stale implausible `lastUsedTokens` is ignored by the guard; no migration needed.
- **Performance**: removes repeated full-history BPE scans per transform.
- **Security**: no change.
- **Dependencies** (new packages required): none.

## 7. Migration Plan (if applicable)

- **Steps**: none — self-healing: the guard ignores poisoned values, and the first subsequent usage event writes a correct delta.
- **Feature flags / gradual rollout**: N/A.

## 8. Open Questions

- [ ] Per-message precision could be restored via provider cache-read breakdown if the SDK ever exposes it.
