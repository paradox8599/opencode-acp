# WORKLOG - Provider Usage Accounting & Compaction Coexistence Fix

- Task ID: `2026-09-15_compaction-usage-fix`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-15 14:35

## 1. Summary

- **What was done** (1–3 sentences): Reworked provider usage accounting for the V2 `session.usage.updated` event (cumulative → per-request delta with a persisted baseline), added plausibility guards plus fast estimation fallbacks, and re-baselined usage on compaction detection. Replaced the README "compaction conflicts" warning with the supported trade-off wording.
- **Why** (1–3 sentences): A live session showed 18,000%+ usage and permanent "context critically full" nudges; large histories stalled ~50 s per transform; compaction kept the stale value.
- **Behavior / compatibility changes**: Yes — new optional persisted field `lastCumulativeUsage`; `lastUsedTokens` now stores the latest request delta instead of the cumulative total. Old state files load unchanged (implausible values are ignored); no migration required.
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `<this commit>` | fix: correct provider usage accounting and re-baseline on compaction |

### Key Files

- `lib/v2/usage.ts` (new) — usage event shape, counter sum, delta application with plausibility guard
- `index.ts` — `session.usage.updated` subscription now calls `applyUsageTotals`; removed inline counter sum
- `lib/token-utils.ts` — `isPlausibleContextTokens`, `getProviderUsedTokens`, fast fallback in `getCurrentTokenUsage`
- `lib/messages/enforce-budget.ts` — provider-anchored `estimateWireTokens`
- `lib/state/utils.ts` — `resetOnCompaction` clears stale `lastUsedTokens`
- `lib/state/types.ts`, `lib/state/state.ts`, `lib/state/persistence.ts` — `lastCumulativeUsage` plumbing
- `tests/v2-usage.test.ts` (new), `tests/token-usage.test.ts`, `tests/state-utils-pure.test.ts`, `tests/enforce-budget.test.ts`
- `README.md`, `README.zh-CN.md` — compaction wording

## 3. Design & Implementation Notes

- **Entry point / key function**: `applyUsageTotals(state, total)` in `lib/v2/usage.ts`, called from the `session.usage.updated` subscription in `index.ts`.
- **Key configuration items**: none changed.
- **Key logic explanation**:
    - The event total is session-cumulative → stored as `lastCumulativeUsage`; `total - baseline` goes into `lastUsedTokens` when > 0.
    - A lower total (counter reset after restart/compaction) re-baselines without emitting a delta.
    - `isPlausibleContextTokens` rejects values above an absolute 10M ceiling or the known model window, so the estimator wins instead of a bogus value.
    - `estimateWireTokens` anchors on `getProviderUsedTokens` and only estimates messages after the last assistant response.
- **Known limits**: delta granularity is per API request (not per message); chars/4 under-counts CJK (~2x) when no provider usage is available yet.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck
node --import tsx --test tests/*.test.ts
./scripts/e2e/run-e2e.sh
npm run verify:package
```

### Test Coverage

- New/modified test files: `tests/v2-usage.test.ts` (new, 5 cases), `tests/token-usage.test.ts` (+3), `tests/state-utils-pure.test.ts` (+1), `tests/enforce-budget.test.ts` (+2, 1 adapted)
- Test count: 1282 total, 1281 pass, 1 fail — pre-existing macOS path case in `tests/inactive-block-decompress.test.ts` (unrelated `/tmp` restriction)
- Key scenarios verified: baseline → delta, counter reset re-baseline, oversize delta rejected, implausible usage → estimator, provider-anchored wire estimate, compaction clears stale usage.

### Results

- `npm run typecheck` ✅
- Targeted suites 46/46 ✅
- E2E (opencode2, 13 scenarios incl. nudge→compress) 13/13 ✅
- `npm run verify:package` ✅ (102 tarball entries)
- Live validation: after pointing the config at the local checkout, transforms went from `usagePct=18272.5%` (old code) to 5.5–5.6% with `Detected compaction - reset stale state`; the state file now carries `lastCumulativeUsage` and a delta `lastUsedTokens`.
