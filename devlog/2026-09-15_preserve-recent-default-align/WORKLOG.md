# WORKLOG - Align preserveRecentMessages / preserveRecentTokens default claims on 5 / 5000

- Task ID: `2026-09-15_preserve-recent-default-align`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-15

## 1. Summary

- **What was done**: Replaced every non-historical claim/fallback that said the protected-tail defaults are 20 messages / 20000 tokens with the actual 5 / 5000.
- **Why**: Follow-up from the AGENTS.md §2.4 config-table sync; §5.7.1's compliance rule ("production default: 20") was actively misdirecting new nudge tests.
- **Behavior / compatibility changes**: The model-facing error text of the protected-zone guard now interpolates `5` instead of `20` when config lacks the field (only reachable for configs built without `defaultConfig`; `getConfig()` always populates 5). No control-flow change.
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
| ------ | ----------- |
| (pending user consent) | `fix: align preserveRecentMessages/NTokens claims and fallback with the 5/5000 defaults` |

### Key Files

- `lib/config.ts` — interface comments at :117/:119 now say "default: 5" / "default: 5000".
- `lib/compress/pipeline.ts` — protected-zone guard error text fallback `?? 20` → `?? 5` (line ~459).
- `AGENTS.md` — §5.7.1 "production default: 20" → "production default: 5".
- `tests/context-limit-fallback.test.ts` — comment now marks 20 as an explicit larger zone vs the 5-message default.
- `tests/compression-candidates-switch.test.ts` — header comment + test title no longer call the explicit 20 a "production config".
- `devlog/2026-09-15_agents-config-table-sync/WORKLOG.md` — follow-up #1 marked resolved.

## 3. Design & Implementation Notes

- Historical devlogs (`devlog/2026-07-26_preserve-recent-messages/`, `devlog/2026-07-27_soften-protected-zone/`, `devlog/2026-07-27_release-v1.14.3/`) intentionally left untouched — they describe the values as they were at that time (20 → 5, 20000 → 5000).
- Test fixtures using `preserveRecentMessages: 20` kept as-is: they exercise a 20-message protected zone on purpose, and §5.7.1 only requires `> 0`. Renaming their claims avoids implying the number is the production default.

## 4. Testing & Verification

### Build & Test Commands

```sh
npx tsc --noEmit
node --import tsx --test tests/context-limit-fallback.test.ts tests/compression-candidates-switch.test.ts tests/preserve-recent.test.ts
node --import tsx --test tests/*.test.ts
```

### Results

- **PASS**: `tsc --noEmit` clean.
- **PASS**: targeted suites 33/33 (context-limit-fallback, compression-candidates-switch, preserve-recent).
- **Full suite**: 1291 tests — 1290 pass, 1 fail: the pre-existing, unrelated `tests/inactive-block-decompress.test.ts` failure (macOS: the `toFile` guard rejects `/tmp` because the real temp dir is under `/var/folders/...`). Identical to the baseline before this change.

## 5. Risk Assessment & Rollback

- **Risk points**: None functional; the only code-path change is an interpolated number inside an error message.
- **Rollback method**: revert the commit.
- **Compatibility notes**: No.

## 6. Lessons Learned

- When a default is intentionally changed (v1.14.3), sweep for *claims about* the default (comments, docs, test titles, error-text fallbacks) in the same change — otherwise they resurface months later as "requirements".

## 7. Follow-ups

- [ ] §2.5 storage-path table could mention the configurable `storagePath` key (tracked in the sibling devlog's follow-ups).
