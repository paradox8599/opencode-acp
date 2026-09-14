# REQ - OpenCode V2 plugin API port (V2-only)

- Task ID: `2026-09-14_opencode-v2`
- Home Repo: `opencode-acp`
- Created: 2026-09-14
- Status: InProgress
- Priority: P0
- Owner: paradox8599
- References: https://github.com/ranxianglei/opencode-acp/issues/395

## 1. Background & Problem Statement

- **Context**: OpenCode 2.0 replaced the V1 plugin API (function plugin returning
  hook keys, `@opencode-ai/plugin` + `@opencode-ai/sdk`) with a new scoped API:
  `@opencode/plugin` `Plugin.define({ id, setup })`, domain transforms/hooks,
  JSON-Schema tools with structured results, command transforms, and
  `ctx.event.subscribe`. V1 plugin implementations do not run in V2.
- **Current behavior (symptom)**: `opencode-acp` (this fork, v1.18.0) loads only
  under OpenCode 1.x. On OpenCode 2.x the plugin is ignored entirely: no system
  prompt injection, no message transform, no compress/decompress/search_context/
  acp_status/acp_context_recap tools, no `/acp` commands, no notices.
- **Expected behavior**: Full ACP feature set runs on OpenCode 2.0.x
  (`@opencode/plugin@2.0.3`) with no V1 compatibility requirement:
  context pruning actually shrinks the outbound request, nudges respect the
  post-prune token count, compression state persists, and `/acp` commands work.

## 2. Reproduction

- **Environment**: OpenCode `@opencode/cli@2.0.3`, Node 22/24.
- **Steps**: configure the package in `plugins: ["opencode-acp"]`, run any
  session; observe zero ACP activity (no prompt/tools/commands).
- **Wire-level evidence** (this task): with a minimal V2 plugin, splicing
  `event.messages` inside `ctx.session.hook("context")` reduces the actual
  outbound request (fake LLM recorded `msgs=3` after pruning vs `msgs=4`
  unpruned), so the port must (and can) implement pruning at that hook.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Keep the battle-tested ACP core: block state, GC, nudges, quality gate,
    tiers, decompression, search, status, recap, persistence, logger, prompts.
  - Persisted ACP state format (files under
    `~/.local/share/opencode/storage/plugin/acp/{sessionId}.json`) unchanged.
  - Message identity uses durable `msg_*` IDs. Never positional keys; the
    tool-result AI messages (no id) must be attached to the owning assistant
    message so refs stay stable across prune/splice cycles.
  - Nudge gating must be driven by the post-prune outbound token count
    (never stale provider usage), otherwise compression re-fires every turn.
  - V2 server plugins have no toast API: compression notices and `/acp` command
    output are written as session synthetic messages and stripped from the
    outbound request by the context hook.
- **Non-Goals**:
  - No V1 runtime compatibility (V2-only entry).
  - No TUI companion plugin (no `tui` entrypoint).
  - No changes to compression prompts/algorithms/config semantics, except the
    V2-specific `compress.permission` handling documented below.

## 4. Acceptance Criteria

1. `plugins: ["<package>"]` loads the plugin under OpenCode 2.0.3 with a stable
   plugin id and `setup(ctx)`.
2. `ctx.session.hook("context")` injects the ACP system prompt and runs the full
   message pipeline (refs, block sync, GC, prune, nudges, budget guard, tags).
3. All five tools are registered with JSON Schema inputs and V2 structured
   results; throws surface as tool errors (compress rejection path preserved).
4. `/acp` and `/dcp` commands are registered through `ctx.command.transform`;
   output is visible in the session without polluting the model context.
5. Compression actually reduces the outbound request; a compressed range is not
   re-compressed while it is active (no repeated-compression loop).
6. Sub-agent rule (`allowSubAgents=false`) hides ACP tools for sub-sessions and
   skips transforms there.
7. `compress.permission: "deny"` unregisters the tools; `"ask"` is treated as
   `"allow"` in V2 (no mid-execution permission API) and documented.
8. `compaction.auto: false` remains the documented setup so OpenCode's built-in
   compaction does not fight ACP state.
9. Tests: adapter unit tests, V2 setup integration test (fake ctx), updated
   existing unit suites, and the e2e scenario set running on the V2 CLI
   (`@opencode/cli`) with wire-level assertions (request shrinks after
   compression; nudges do not re-fire below threshold).
10. Docs updated: README / README.zh-CN / CONFIGURATION (+ zh-CN) with V2 install
    and `plugins` + `compaction.auto:false` configuration.
