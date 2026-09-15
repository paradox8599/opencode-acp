# REQ - Make ACP command output and notices visible in the V2 TUI

- Task ID: `2026-09-15_acp-output-visibility`
- Home Repo: `opencode-acp`
- Created: 2026-09-15
- Status: Done
- Priority: P1
- Owner: paradox8599
- References: session `ses_f626c3e02ffePy3ZFAnHEF18vb` (live diagnosis)

## 1. Background & Problem Statement

- **Context**: User reported `/acp` "完全没反应".
- **Investigation (2026-09-15)**:
  - The command IS registered: `GET /api/command` on the running server lists `acp` and `dcp`.
  - The command DOES execute: the session already contained a full `[ACP Status] …` synthetic message (`metadata.acp.kind = "command-output"`, created 07:34:47 from the user's TUI invocation); an API reproduction (`POST /api/session/:id/command` → 204) produced another one.
  - The output was invisible because the V2 TUI renders a synthetic row only when `description` is non-empty (`packages/tui/src/routes/session/rows.ts:293`; live paths `rows.ts:211/221`), and shows `description` as the row text (`SessionNoticeMessageV2`, `packages/tui/src/routes/session/index.tsx:2010-2035`).
  - ACP's `sendSynthetic` (`lib/v2/host.ts:72-93`) sent only `text` + `metadata` → every ACP write (command output, notices) is persisted but never displayed.
  - v2.0.3 has no plugin toast domain (`packages/plugin/src/effect/plugin.ts` Context), so the synthetic row is the only user-visible channel for plugins.
- **Expected behavior**: `/acp stats|context|export|help` output appears in the transcript; ACP notices appear when `pruneNotification` enables them.

## 2. Constraints & Non-Goals

- **Constraints**:
  - Keep the model-invisible behavior: hidden-id registration and model-context stripping are unchanged — only a display field is added.
  - Match the official convention (`packages/core/src/tool/plugin/shell.ts:168`, `packages/core/src/session/subagent-completion.ts:36`: `description` + `text`).
- **Non-Goals**:
  - No toast/notification API work (does not exist in v2.0.3).
  - No TUI-side changes (opencode repo is out of scope).
  - The sibling `opencode-habits` plugin gets the same one-line fix in its own repo (user request: "一起修").

## 3. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] `sendSynthetic` passes `description: text` to `ctx.session.synthetic`.
  - [x] `V2HostContext.session.synthetic` typing accepts `description`.
  - [x] `tests/v2-setup.test.ts` asserts the synthetic command output carries a non-empty `description`.
- **Regression**:
  - [x] `npx tsc --noEmit` clean; full test suite unchanged (1 pre-existing unrelated failure).
