# WORKLOG - Make ACP command output and notices visible in the V2 TUI

- Task ID: `2026-09-15_acp-output-visibility`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-15

## 1. Summary

- **What was done**: `sendSynthetic` (`lib/v2/host.ts`) now passes `description: text` to `ctx.session.synthetic`, so ACP command output and notices render in the V2 transcript instead of being silently dropped by the TUI. Type + test updated to lock the contract.
- **Why**: `/acp` "没反应" — root cause was display-side: the V2 TUI only renders synthetic rows with a non-empty `description` (and renders `description`, not `text`).
- **Behavior / compatibility changes**: Synthetic rows (command output; notices when enabled) now appear in the transcript. Model-context behavior unchanged (hidden-id stripping untouched).
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
| ------ | ----------- |
| (pending user consent) | `fix: give ACP synthetic messages a description so the V2 TUI renders them` |

### Key Files

- `lib/v2/host.ts` — `V2HostContext.session.synthetic` accepts `description?: string`; `sendSynthetic` passes `description: text` (comment explains the TUI gating).
- `tests/v2-setup.test.ts` — fake records `description`; command-output test asserts `description === text`.
- `devlog/2026-09-15_acp-output-visibility/` — this entry.

## 3. Design & Implementation Notes

- Evidence chain (see REQ.md): command registered (`GET /api/command`), executed (`POST /api/session/:id/command` → 204), message persisted (session contained `[ACP Status] …`, `metadata.acp.kind = "command-output"`), but hidden by the TUI gate at `packages/tui/src/routes/session/rows.ts:293` (live paths `:211/:221`) and rendered from `description` (`SessionNoticeMessageV2`, `packages/tui/src/routes/session/index.tsx:2010-2035`).
- Official convention matched: `packages/core/src/tool/plugin/shell.ts:168` and `packages/core/src/session/subagent-completion.ts:36` pass `description` alongside `text`.
- v2.0.3 has no plugin toast domain (`packages/plugin/src/effect/plugin.ts` Context), so the synthetic row is the only plugin-visible channel — `tui.showToast` remains log-only (unchanged).
- Sibling fix (same day, different repo): `opencode-habits/server.ts` `handleCommand.reply` now passes `description: text` (its `/habits` output had the same invisibility).

## 4. Testing & Verification

### Build & Test Commands

```sh
npx tsc --noEmit
npx prettier --write lib/v2/host.ts tests/v2-setup.test.ts
node --import tsx --test tests/v2-setup.test.ts
node --import tsx --test tests/*.test.ts
```

### Results

- **PASS**: `tsc --noEmit` clean; Prettier reports no changes.
- **PASS**: `tests/v2-setup.test.ts` 6/6 (updated assertion included).
- **PASS**: full suite — 1291 tests, 1290 pass, 1 fail: the pre-existing unrelated `tests/inactive-block-decompress.test.ts` (macOS `/tmp` path).
- **Pending live check**: restart opencode → `/acp` should render a `◈ [ACP Status] …` row; check multi-line layout of the long report.

## 5. Risk Assessment & Rollback

- **Risk points**: Multi-line `description` rendering in `InlineToolRow` is unverified live (theoretical wrap; if ugly, truncate or restructure the notice text).
- **Rollback method**: revert the commit (one field).
- **Compatibility notes**: No data-format change; `description` is an existing optional field of the synthetic message schema.

## 6. Lessons Learned

- When porting UI-visible output to a new host API, assert the *display contract*, not just the write: our V2 port test asserted "a synthetic message was written" — true and green — while the user saw nothing for weeks.
- The V2 rule to remember: **synthetic ⇔ description required for display; `text` is model-side.**

## 7. Follow-ups

- [ ] Live verification after restart (row visible + layout).
- [ ] `opencode-habits` — same fix applied locally; needs its own commit/push (separate repo).
