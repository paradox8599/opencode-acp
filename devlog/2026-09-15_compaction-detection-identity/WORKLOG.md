# WORKLOG - Identity-based compaction detection (stop the per-turn false resets)

- Task ID: `2026-09-15_compaction-detection-identity`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-15

## 1. Summary

- **What was done**: Compaction detection now keys on the checkpoint message **id** instead of a (fabricated) timestamp; the V2 AI adapter stops giving checkpoints a synthetic `created`; transcript-derived checkpoints reconcile/repair the `lastCompaction` boundary.
- **Why**: The old timestamp comparison fired on every request, resetting nudges/message refs/tool cache/usage baseline per turn and advancing `lastCompaction` to "now" — which made every message look compacted (`/acp context` all zeros, turn count 0).
- **Behavior / compatibility changes**: Detection is id-based; `SessionState.lastCompactionCheckpointId` is a new persisted field (unknown fields are ignored by older readers). AI-path checkpoints carry `created = 0`.
- **Risk level**: Medium (state-machine change), contained by tests.

## 2. Change Log

### Commits

| Commit | Description |
| ------ | ----------- |
| (pending user consent) | `fix: identity-based compaction detection` |

### Key Files

- `lib/state/utils.ts` — new `findLastCompactionCheckpoint` (newest assistant+summary message) and `syncCompactionBoundary` (trusts only `created > 0`, repairs stale/poisoned boundaries, keeps the checkpoint id in sync).
- `lib/state/state.ts` — `updatePerTurnState` detects by checkpoint id (single reset per real compaction); `ensureSessionInitialized` restores the persisted id and reconciles the boundary after load; `getOrCreate` reconciles on every call (no-op for AI-path input) and persists on change; factory/reset initialize the new field.
- `lib/state/types.ts` — `SessionState.lastCompactionCheckpointId?: string`.
- `lib/state/persistence.ts` — persist/restore the new field.
- `lib/v2/ai-adapter.ts` — compaction checkpoints get `time.created = 0` (sentinel: not a usable boundary) instead of the fabricated `now`.
- `tests/compaction-identity-detection.test.ts` — new regression suite.
- `tests/v2-ai-adapter.test.ts` — checkpoint test also asserts the sentinel.

## 3. Design & Implementation Notes

- Boundary semantics kept: `isMessageCompacted` still compares `created < lastCompaction`; only the *writers* of the boundary changed. The AI path (`created = 0`) can no longer poison it; the transcript path (real per-message times) reconciles it.
- Self-heal: existing poisoned state files (`lastCompaction ≈ now`) are pulled back to the real checkpoint time by `syncCompactionBoundary` on the next transcript-derived call (`/acp` commands, tools, compress), then persisted.
- Detection idempotence: `lastCompactionCheckpointId` persists, so a process restart does not re-fire the reset for the same checkpoint.

## 4. Testing & Verification

### Build & Test Commands

```sh
npx tsc --noEmit
node --import tsx --test tests/compaction-identity-detection.test.ts
node --import tsx --test tests/*.test.ts
```

### Results

- **PASS**: typecheck clean.
- **PASS**: new suite 4/4; `v2-ai-adapter` + `v2-setup` 19/19 combined run.
- **Verified against the bug**: with `updatePerTurnState` temporarily reverted to the timestamp comparison, both detection tests fail (fresh synthetic timestamps re-trigger; the checkpoint id is never recorded) — so the tests genuinely cover the regression.
- **Full suite**: 1295 tests — 1294 pass, 1 fail: the pre-existing unrelated `tests/inactive-block-decompress.test.ts` (macOS: the `toFile` guard rejects `/tmp` because the real temp dir lives under `/var/folders/...`). Identical to the baseline.

## 5. Risk Assessment & Rollback

- **Risk points**: `lastCompaction` now only advances from transcript-derived checkpoints — a session that only ever sees hook traffic keeps an older boundary; harmless in V2 because the context list only contains post-compaction messages.
- **Rollback method**: revert the commit (state field is additive and ignored by the old code).
- **Compatibility notes**: additive persisted field; old state files load unchanged.

## 6. Lessons Learned

- Fabricating timestamps for "convenience" created a self-inflicted loop: every derived comparison became time-dependent in a way no single test could see. Prefer an explicit sentinel plus identity-based comparisons over synthetic wall-clock values.
- The symptom (`/acp context` zeros) was 3 layers away from the cause (adapter timestamp → detection → boundary → per-message compaction).

## 7. Follow-ups

- [ ] Live verification after restart: `/acp context` numbers restored; log shows no per-request "Detected compaction"; message refs stable across turns.
