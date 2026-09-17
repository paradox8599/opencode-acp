# Working on opencode-acp

## Fork workflow

- Work on the current branch; do not create a feature branch. This personal V2 fork's workflow differs from the inherited `CONTRIBUTING.md`.
- Commit only with explicit consent, using English messages. Push/publish requires explicit instruction; this fork does not publish to npm. Never force-push `master`. Delete branches/tags only with confirmation.
- Change `package.json`'s version only for an explicitly requested release.
- Every change needs `devlog/YYYY-MM-DD_short-title/REQ.md` before implementation and `WORKLOG.md` updated during/after it. Add `DESIGN.md` for architecture, data-flow, or module-boundary changes. Read `devlog/README.md` for templates; include the devlog with the change.

## Verification

- Use npm and `package-lock.json`. Run `npm run typecheck` before editing for a baseline.
- Before completion, run `npm run typecheck`, `npm run verify:package`, and `npm test`. There is no CI to catch omitted checks.
- Focused test: `node --import tsx --test tests/token-counting.test.ts`. Tests belong flat in `tests/*.test.ts`; the npm test glob does not recurse.
- Typecheck covers only `index.ts` and `lib/`, not tests or scripts. Passing typecheck does not verify test files.
- Format only touched files: `npx prettier --write <files>`. Avoid `npm run format` for focused changes: it rewrites the whole repo, including unrelated formatting drift.
- In tests using real logging or persistence, import `./test-env` before modules that instantiate a Logger, unless the test sets up its own XDG isolation. WARN/ERROR logging writes to disk even with debug disabled.
- Temp-path tests must respect `os.tmpdir()`: `decompress.toFile` only permits that directory or `~/.cache/opencode/`. The hard-coded `/tmp` case in `tests/inactive-block-decompress.test.ts` fails on macOS when its temp directory differs.

### Transform / nudge E2E

- Run `./scripts/e2e/run-e2e.sh` when the transform pipeline or nudge logic changes. Focused run: `./scripts/e2e/run-e2e.sh scripts/e2e/scenarios/01-basic-compress.json`.
- Requires local OpenCode V2, Bun, Node, and curl. The runner prefers `opencode2` over `opencode`; override with `OPENCODE_BIN`, `BUN_BIN`, or `NODE_BIN` when needed.
- The runner **deletes and recreates `/tmp/acp-e2e`**, isolates HOME and XDG config/data, and uses port 8400 by default (`FAKE_LLM_PORT` overrides it). Do not run concurrent copies against that shared directory.
- This is a local fake-LLM suite, not Docker. It loads the checkout directly: no build or `SKIP_BUILD` step. Trust `scripts/e2e/run-e2e.sh` over old build instructions in its README or devlog templates; `TESTING.md`'s baseline/coverage lists are also stale.

## Runtime and packaging

- This is a source-direct plugin, not a compiled app: both package exports (`.` and `./server`) point to `index.ts`. There is no build command or required `dist/`, despite `tsconfig.json`'s `outDir`.
- `@opencode/plugin` must remain a devDependency with type-only imports. Runtime imports must work with only production dependencies installed; `scripts/verify-package.mjs` checks packaging and the import graph.
- For a live smoke test, use the local-checkout installation in `README.md`, restart OpenCode after source/plugin-list changes, then run `/acp help`. Do not modify the user's global config just to run unit tests.

## Where behavior is wired

- `index.ts` registers the **V2** plugin. `lib/v2/context-handler.ts` imports V2 messages into ACP's internal `WithParts`, runs `lib/hooks.ts`, appends the system prompt, then exports messages. Old `experimental.chat.*` descriptions are not the current host API.
- Keep the transformed message array separate from the host's stored messages; in-place mutation can persist injected refs into conversation history. See `lib/v2/context-handler.ts` and `tests/v2-ai-adapter.test.ts`.
- Provider usage events are session-cumulative, not current-context size. `lib/v2/usage.ts` converts totals to per-request deltas; preserve this distinction when changing token accounting or nudge thresholds.
- Pipeline order in `lib/hooks.ts` is significant: candidate planning uses a pre-prune snapshot while nudges see pruned messages; tool-output truncation and the final budget guard run afterward. Preserve candidate/executor agreement when changing these stages.
- Compression enters through `lib/compress/range.ts`, using shared preparation/finalization in `lib/compress/pipeline.ts`. Quality checks can reject compression before state mutation; do not treat them as merely post-compression notifications.
- Session state is managed through `SessionStateRegistry` and persisted by `lib/state/persistence.ts`. Changes to block activation, consumed blocks, or hidden message IDs must survive a fresh process, not just an in-memory session.
- User-facing names use `ACP`/`acp`; internal `dcp-*` tags and `dcp.schema.json` are compatibility-sensitive. Keep them unless a migration is explicitly planned. Model-facing `mNNNNN` refs and `bN` block IDs are not raw host message IDs; use `lib/message-ids.ts` / `lib/compress/search.ts` for resolution.

## Configuration traps

- `lib/config.ts` is the source for defaults and merging; consult `lib/config-validation.ts`, `dcp.schema.json`, and `CONFIGURATION.md` when changing options rather than copying defaults from historical docs.
- Layers are global (`$XDG_CONFIG_HOME/opencode`, otherwise `~/.config/opencode`) → `$OPENCODE_CONFIG_DIR` → project. Each uses `acp.jsonc` in preference to `acp.json`. Project lookup stops at the nearest `.opencode` directory, even if it has no ACP config.
- `compress.protectedTools` explicitly replaces inherited policy; `commands.protectedTools` merges it. `compress` remains force-protected even when an explicit empty array is supplied. Preserve protected-tool exclusion, not just summary copies of protected output.

## Nudge regression requirements

For changes to `lib/messages/inject/` or related growth/nudge logic:

- Use at least two consecutive `injectCompressNudges` calls sharing one `SessionState`; assert both `shouldInjectThisTurn` and baseline fields (`lastPerMessageNudgeTokens` and/or `lastNudgeShownTokens`) after each call.
- Include production-like protection (`preserveRecentMessages > 0`) and a complete baseline → growth → nudge → compress → new baseline → growth → nudge cycle. Single-turn tests with protection disabled missed the baseline-reset feedback loop.
- E2E must include `"respond": "nudge-compress"`, growth across multiple turns, and verification of `lastPerMessageNudgeTokens`, not only block counts. See `scripts/e2e/scenarios/08-nudge-with-protection.json`, `09-nudge-refire-after-compress.json`, and `scripts/e2e/verify.ts`.
- Verify regression tests fail with the bug reintroduced, then restore the fix; a green test alone is insufficient.
