# WORKLOG - AGENTS.md §2.4 default-config table sync

- Task ID: `2026-09-15_agents-config-table-sync`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-15

## 1. Summary

- **What was done**: Rewrote AGENTS.md §2.4 — the config-layering block now reflects `getConfigPaths()` and the "Default Configuration" block mirrors `defaultConfig` (`lib/config.ts:314-396`) key-for-key, including previously undocumented sections (`logLevel`, `compress.candidates`/growth nudges/`reasoning`, `gc.batchCleanup`, `qualityGate`, `messageFilters`).
- **Why**: The §2.4 snapshot was V1-era and diverged in ~20 fields; AGENTS.md is treated as source of truth, so stale defaults mislead.
- **Behavior / compatibility changes**: No (docs only).
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
| ------ | ----------- |
| (pending user consent) | `docs: sync AGENTS.md default-config table with lib/config.ts` |

### Key Files

- `AGENTS.md` — §2.4 replaced; no other section touched.
- `devlog/2026-09-15_agents-config-table-sync/REQ.md`, `WORKLOG.md` — this entry.

## 3. Design & Implementation Notes

- Source of truth for the table: `defaultConfig` (`lib/config.ts:314`) + constants `DEFAULT_PROTECTED_TOOLS` (`lib/config.ts:237`), `COMPRESS_DEFAULT_PROTECTED_TOOLS` (`lib/config.ts:251`), `DEFAULT_COMPRESS_REASONING` (`lib/config.ts:164`).
- Comment semantics taken from the interface doc comments (`CompressConfig` at `lib/config.ts:64-138`, `GCConfig`, `CompressReasoningConfig` at `lib/config.ts:147-157`) — e.g. `minContextLimit` is `@deprecated`, `contextLimitFallback` `0` disables, `maxBlockAge` is a no-op.
- Keys with no default are listed in one line rather than in the block: `storagePath`, `compress.modelMaxLimits`, `compress.providers`, `compress.completionReserveTokens`, `compress.toolOutputNudgeThreshold`.
- Layering block now documents `.jsonc`-wins-over-`.json` per layer, `XDG_CONFIG_HOME` fallback, `$OPENCODE_CONFIG_DIR` gating, and nearest-ancestor `.opencode/` discovery (walking up from the session directory, `findOpencodeDir` at `lib/config.ts:404`).

## 4. Testing & Verification

### Build & Test Commands

```sh
# Docs-only: no build/test needed. Manual diff against lib/config.ts performed.
grep -n "const defaultConfig" -A 85 lib/config.ts
```

### Results

- **PASS**: table assembled field-by-field from `lib/config.ts` output (no values written from memory).

## 5. Risk Assessment & Rollback

- **Risk points**: None functional; worst case a doc typo.
- **Rollback method**: revert the docs commit.
- **Compatibility notes**: No.

## 6. Lessons Learned

- Defaults drift silently across majors (V1→V2); doc snapshots of code constants should cite the defining symbol + line so the next sync is a diff, not an archaeology exercise.

## 7. Follow-ups

- [ ] §5.7.1 claims "production default: 20" for `compress.preserveRecentMessages`; actual default is `5` (`lib/config.ts:357`). `lib/config.ts:117` interface comment also says 20, and `lib/compress/pipeline.ts:459` still falls back to `?? 20` at one call site. Needs a separate decision: fix docs + stray fallback, or raise the default.
- [ ] §2.5 storage-path table: `storagePath` (XDG_DATA_HOME-aware) is now configurable; table mentions only the default path.
