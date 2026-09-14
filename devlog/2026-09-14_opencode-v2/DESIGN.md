# DESIGN - OpenCode V2 plugin API port

- Task ID: `2026-09-14_opencode-v2`
- Created: 2026-09-14
- Status: InProgress

## 1. Context

ACP core (≈22k LOC, 86 test files) operates on an internal
`WithParts = { info: Message, parts: Part[] }` model inherited from the V1 SDK.
V2 hands plugins a different model — `@opencode/ai` `Message` objects
(`{ id?, role, content: ContentPart[] }`), where:

- `Message.id` is the durable `msg_*` id for user/assistant/synthetic/shell/
  skill/compaction messages, absent for instruction `system` messages and for
  the separately emitted `role: "tool"` result messages;
- one assistant message carries `tool-call` parts, while its local tool results
  arrive as following `role: "tool"` messages with matching `tool-result` part
  ids;
- there are no `tokens`, no `model`, no `sessionID` fields on messages; those
  live on the hook event (`event.model`, `event.agent`, `event.sessionID`).

The port therefore needs a translation layer, not a rewrite. Pruning already
proven on the real V2 host: mutating `event.messages` in
`ctx.session.hook("context")` changes the actual provider request.

## 2. Architecture

```
OpenCode 2.0
  │
  ├─ ctx.session.hook("context") ──► lib/v2/ai-adapter.ts
  │        import: AI Message[] ──► InternalMessage[]      (durable ids, tool
  │        export: InternalMessage[] ──► AI Message[]         results folded in)
  │                               │
  │                               ▼
  │                     lib/hooks.ts (existing pipeline, V2 handler)
  │                     refs → sync → GC → prune → nudges → tags → budget
  │
  ├─ ctx.tool.transform(add) ─────► lib/compress/* (existing tools)
  │        host facade session.context() ──► lib/v2/session-adapter.ts
  │
  ├─ ctx.command.transform(add) ──► /acp handler → synthetic output
  │
  └─ ctx.catalog / ctx.session ───► lib/v2/host.ts (client facade)
```

### 2.1 Internal message model

`lib/state/types.ts` keeps `WithParts` but the element types become local
`AcpMessage`/`AcpPart` definitions that mirror the field subset the pipeline
actually reads/writes:

- `info`: `id`, `role`, `sessionID?`, `time.created`, `summary?`, `tokens?`
  (logging only), `model?`, `agent?`, `tools?`
- parts: `text` / `reasoning` / `tool` (with `tool`, `callID`, `state`) /
  `file` / `step-start` / `step-finish` / unknown pass-through

`lib/v2/ai-adapter.ts` owns the two-way translation:

- **import**: folds each `role: "tool"` message into the preceding assistant
  message as a tool part (state `completed`/`error` from the tool-result
  payload); drops nothing else; marks pass-through/system messages so they are
  never pruned; records source back-references (AI message + merged tool
  messages + part objects) for export.
- **export**: rebuilds the outbound array from the mutated internal array:
  - unchanged parts reuse the original objects (provider metadata, cache
    hints, file parts preserved);
  - changed text/tool parts are rebuilt; tool results are emitted as the
    original `role: "tool"` messages when unchanged, otherwise rebuilt;
  - internal-only (synthetic) messages become `{ role: "user", content: [...] }`
    messages at their array position;
  - messages pruned from the internal array (or marked consumed) are removed
    together with their folded tool messages;
  - instruction `system` messages are passed through untouched.

`lib/v2/session-adapter.ts` maps `ctx.session.context()` output
(`SessionMessage.Info[]`) to the same internal model for tool-side call sites
(`fetchSessionMessages`, rebuild, status/export/context commands). Identity is
the durable `msg_*` id; the to-LLM projection rules from `@opencode/ai`'s
`toLLMMessage` are mirrored for user/shell/skill/synthetic/system/compaction
so summaries and token estimates match the hook path.

### 2.2 Host facade

Existing call sites use a V1-shaped client duck type
(`client.session.messages({path})`, `client.session.get({path})`,
`client.config.providers()`, `client.tui.showToast(...)`). `lib/v2/host.ts`
builds that object from the V2 context:

| facade call | V2 implementation |
| --- | --- |
| `session.messages` | `ctx.session.context({sessionID})` + session-adapter |
| `session.get` | `ctx.session.get({sessionID})` → `{ data: info }` |
| `session.prompt({body:{parts:[{text, ignored}]}})` | `ctx.session.synthetic({resume:false, metadata:{acp:true}})`; id recorded for outbound stripping |
| `config.providers` | `ctx.catalog.model.list()` reshaped to `{data:{providers:[...]}}` (model-limit hydration unchanged) |
| `tui.showToast` | synthetic message (same path as above), never a toast |

The context hook strips tracked synthetic output ids before ref assignment and
pruning, so notices and command output are visible in the TUI but never reach
the model or enter compression state. The tracked-id set is persisted in ACP
session state.

### 2.3 Entry point (index.ts)

```ts
export default Plugin.define({
  id: "opencode-acp",
  async setup(ctx) { ... return cleanup }
})
```

- config from `ctx.location.directory` (three-layer ACP jsonc unchanged);
- `ctx.session.hook("context", handler)` replaces
  `experimental.chat.system.transform` + `experimental.chat.messages.transform`;
  the system prompt is appended as a `SystemPart`;
- `ctx.tool.transform` registers the five tools when permission != deny, with
  `options.codemode` unset (default) so they stay model-visible;
- `ctx.command.transform` registers `acp` (and `dcp` alias) when commands are
  enabled;
- `experimental.text.complete` is dropped (no V2 equivalent; per-request
  `stripHallucinations` remains);
- the V1 `event` hook (compression timing via `message.part.updated`) is
  replaced by in-tool timing (`Tool.Context.id`/`messageID` are already
  available to `compress`/`decompress`), so no event subscription is needed;
- `allowSubAgents=false`: the context hook deletes the ACP tools from
  `event.tools` for child sessions and skips the pipeline; `execute.before`
  rejects direct calls as a second line of defense;
- model limit catalog: hydrated from `ctx.catalog.model.list()` at setup and
  lazily per session (no per-message `tokens`/`model.limit` in V2).

## 3. Error & permission semantics

- Promise-tool throws become model-visible tool errors (verified live), so the
  existing reject paths (`summary too long`, phantom range, quality gate,
  decompress resolution failures) stay intact.
- V2 plugin tools are auto-allowed; `options.permission` only participates in
  whole-tool deny filtering. `compress.permission: "deny"` → tools not
  registered. `"ask"` has no V2 equivalent (no mid-execution permission API) →
  treated as `"allow"` with a startup warning.
- `permissions` rulesets from the session/agent replace V1's permission map in
  `compressDisabledByOpencode` (last matching rule wins; `resource:"*"` +
  `effect:"deny"` disables).

## 4. Testing strategy

1. **Adapter unit tests** (`tests/v2-ai-adapter.test.ts`,
   `tests/v2-session-adapter.test.ts`): round-trip fidelity, tool folding,
   no-id messages, pruning removal, synthetic insertion, system pass-through.
2. **V2 setup integration test** (`tests/v2-setup.test.ts`): fake `ctx` captures
   hook/tool/command registrations; invoke them with realistic V2 payloads;
   assert system prompt, tool JSON schemas, command output, permission rules.
3. **Existing suites**: unchanged where possible (they exercise the internal
   pipeline with the same field shapes); hook-level suites updated to V2.
4. **E2E on the V2 CLI** (`scripts/e2e`): switch to `@opencode/cli` with
   `plugins` config; scenarios keep state-file verification, extended with
   wire-level assertions from the fake LLM: post-compression request must be
   smaller; nudges must not re-fire when the pruned context is below threshold.
5. CI: e2e job uses the V2 binary; unit/typecheck/build unchanged.

## 5. Risks

- **Ref instability**: mitigated by durable-id keys; tool results folded into
  their assistant message; regression tests replay prune → re-request.
- **Nudge re-fire loop**: nudge gating consumes the post-prune outbound
  estimate (existing ACP behavior); e2e asserts no nudge below threshold.
- **API drift**: pinned to `@opencode/plugin@2.0.3`; the port is isolated in
  `lib/v2/` so later API changes touch one directory.
