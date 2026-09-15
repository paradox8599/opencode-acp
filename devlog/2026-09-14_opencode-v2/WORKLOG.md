# WORKLOG - OpenCode V2 plugin API port

- Task ID: `2026-09-14_opencode-v2`
- Branch: `2026-09-14_opencode-v2`
- Created: 2026-09-14

## Scope delivered

V2-only port of the ACP plugin. The V1 entry, hooks, tool definitions, command
handler, event handler and text-complete handler were replaced; the internal
compression pipeline, state model, GC, nudges, quality gate, prompts, logger
and persistence were kept and re-typed.

## Key changes

### Internal model (`lib/state/types.ts`)

`WithParts` no longer imports `@opencode-ai/sdk`; `AcpMessageInfo`/`AcpPart`
declare exactly the fields the pipeline reads and writes. `@opencode-ai/plugin`
and `@opencode-ai/sdk` were removed from `package.json`; `@opencode/plugin`
2.0.3 was added.

### Adapter layer (`lib/v2/`)

| File | Purpose |
| --- | --- |
| `types.ts` | Structural V2 message/content types + JSON/DateTime helpers |
| `ai-adapter.ts` | `@opencode/ai` messages ⇄ internal `WithParts`; tool results fold into the owning assistant message; system/id-less messages pass through at chronological anchors; synthetic ACP messages export as id-less user messages |
| `session-adapter.ts` | `ctx.session.context()` durable messages → internal `WithParts` for tools/commands/rebuild |
| `host.ts` | V1-shaped duck-typed client facade over `ctx.session`/`ctx.catalog`; notices become `session.synthetic({resume:false})` |
| `context-handler.ts` | V2 `ctx.session.hook("context")` wrapper: state init → hidden-output strip → import → existing pipeline → system prompt → export; hides ACP tools from sub-agent requests |
| `tool.ts` | `tool({description, args, execute})` helper (zod) for the ACP tool factories |
| `tools.ts` | Registration helper: zod args → V2 tool value (`codemode: false`), structured `{content}` results |

### Entry point (`index.ts`)

`Plugin.define({ id: "opencode-acp", setup })`; registers the context hook,
five tools and the `/acp` + `/dcp` commands. `/bili/` proxy detection now reads
`ctx.catalog.provider.list()`; `compress.permission: "deny"` skips
registration; `"ask"` logs a warning and behaves as `"allow"`.

### Pipeline changes

- `lib/host-permissions.ts` rewritten for V2 ordered rulesets
  (`{action, resource, effect}`, last match wins).
- `lib/compress/pipeline.ts` measures compression duration in-tool
  (`startedAt` in `prepareSession`, recorded in `finalizeSession`); the V1
  `message.part.updated` event hook and `experimental.text.complete` handler
  were deleted.
- `SessionState.hiddenMessageIds` (persisted) tracks ACP-authored synthetic
  output so it stays TUI-visible but never reaches the model. The context
  handler resolves session state before stripping, and the write path saves
  immediately — otherwise the next server process would reload a state file
  without the id and leak `/acp` output into context.
- V2 AI messages carry no `tokens` field, so `getCurrentTokenUsage` fell back
  to text estimation and nudges never fired (the same failure mode DCP hit).
  `index.ts` now subscribes to `ctx.event.subscribe()` and tracks
  `session.usage.updated` (real prompt size incl. system prompt + tool
  schemas) into `SessionState.lastUsedTokens`, persisted so consecutive
  `run` processes see the previous request's usage. The subscription is
  aborted by the cleanup function returned from `setup`.
- `lib/config.ts` / `lib/update.ts` take a minimal init context
  (`{directory, client.tui.showToast?}`) instead of `PluginInput`.

### E2E migration (`scripts/e2e/`)

- `run-e2e.sh`: `plugins: [...]` config, V2 provider
  (`@opencode/ai/providers/openai-compatible` + `settings.baseURL`),
  `agents`, `permissions` ruleset, `compaction.auto: false`, `--standalone`
  on every CLI invocation, `OPENCODE_BIN` defaults to `opencode2`.
- The plugin is loaded from the **repository root** (`index.ts`), so the e2e
  suite exercises the same source-direct entry users get from GitHub.
- `fake-llm-server.ts`: the subagent tool is `subagent` with `agent` (V1:
  `task` with `subagent_type`); `detectNudge` phrases updated to the current
  ACP nudge templates ("Context limit reached", "Context is getting full",
  "iterating for a while", "efficiency nudge to compress early").
- CI: e2e job installs `@opencode/cli@2.0.3` instead of `opencode-stable`.
- `verify-package.mjs`: the CommonJS detector now recognizes dual packages with
  an ESM entry (`module` / `exports.import`), so importing `zod` from source no
  longer trips a false positive.

### Source-direct packaging

The package no longer bundles: `exports` points at `index.ts`, `files` ships
`index.ts` + `lib/`, and `tsup`/`dist` are gone (`tsup.config.ts` deleted).
Rationale: OpenCode V2's installer runs with `ignoreScripts: true`, so a
git/GitHub install never executes `prepare` — a git-installed package must
contain its loadable entry. This matches the pattern of other V2 plugins
(e.g. `ccsafety-bridge`, whose `exports` is committed `src/index.ts`).

- `@opencode/plugin` moved to devDependencies and must stay type-only at
  runtime (`index.ts` exports a plain `{ id, setup }` object);
  `verify-package.mjs` fails if it reappears in `dependencies`.
- `context-compress-algorithms` moved from devDependencies to dependencies
  (previously bundled by tsup).
- `lib/version.ts` reads the version from `package.json` at runtime
  (replaces the tsup `define`-injected `ACP_VERSION`).
- `scripts/dev-deploy.sh` deleted: source-direct needs no deploy step — keep
  `plugins: ["/abs/path/to/opencode-acp"]` in the config and restart.
- `scripts/verify-package.mjs` rewritten for source packaging (entry/exports
  shape, shipped files, forbidden paths).
- CI: `build` job → `package` job (`npm run verify:package`); e2e loads the
  repo root; `pr-artifact.yml` no longer builds and its install comment uses
  the V2 config / `opencode plugin add` forms.
- Docs: README/README.zh-CN installation now documents
  `plugins: ["github:paradox8599/opencode-acp"]` and the local-checkout path;
  AGENTS.md build/deploy sections rewritten; CONFIGURATION autoUpdate notes
  that GitHub/local installs skip the registry check.

### System-prompt sizing

V1 inferred the system-prompt size by subtracting the first user message from
the first assistant's reported input tokens. V2 messages carry no tokens, so
`context-handler.ts` estimates the fixed request part from `event.system` text
and `event.tools` schemas (`countTokens` + JSON length/4). The value is stable
for the session, which is what the nudge breakdown (`Breakdown: X system`) and
the budget guard need.

## Verification

- `npm run typecheck` — clean.
- `npm test` — 1270/1271 (the one failure is the pre-existing macOS
  `tmpdir()` vs hard-coded `/tmp` path test, unrelated to this port).
- `npm run check:package` — typecheck + tarball verification pass.
- **E2E: all 13 scenarios pass on `@opencode/cli@2.0.3`** (`scripts/e2e`,
  fake LLM): basic/quality/batch compression, subagent compression, nudge
  triggered, protection filtering, nudge refire, tier-2 baseline, consumed
  call hiding, adaptive candidates. Re-verified after the source-direct
  switch: all 13 pass loading the repository root's `index.ts`.
- New tests: `tests/v2-setup.test.ts` (6), `tests/v2-ai-adapter.test.ts` (9),
  `tests/v2-session-adapter.test.ts` (6); existing hook/permission/model-switch
  suites adapted.
- Live verification highlights:
  - plugin loads from `plugins: [...]`, registers 17 tools (12 built-in + 5 ACP);
  - `compress` executes, creates a block, prunes the covered range: the
    continuation request shrank (wire messages 8 → 4 in scenario 01);
  - nudges fire from real provider usage (`lastUsedTokens` persisted across
    `run` processes) and the visible context stays pruned;
  - `/acp help` via the V2 command API writes a synthetic transcript entry that
    is stripped from the next outbound request (verified on a fresh session);
  - **git install (source-direct)**: a local git snapshot installed through
    `plugins: ["git+file://…"]` resolves the entry to
    `…/node_modules/opencode-acp/index.ts`; OpenCode installed exactly the four
    runtime dependencies (`@anthropic-ai/tokenizer`, `context-compress-algorithms`,
    `jsonc-parser`, `zod`, plus transitive `tiktoken`/`undici-types`/`@types`),
    installed **no** devDependencies, and ACP processed a live turn (17 tools,
    transform complete, state persisted).

## Known gaps / follow-ups

- `pruneNotificationType: "chat"` is documented as transcript-only on V2.
- `scripts/dev-deploy.sh` still targets the V1 plugin cache layout; V2 local
  iteration is via `plugins: ["<abs path to dist>"]`.
- `npm run format:check` reports pre-existing repo-wide style drift (464 files,
  including untouched ones); not addressed here.
- Dual-agent review (AGENTS.md §5.3/§5.6) still required before merge.
