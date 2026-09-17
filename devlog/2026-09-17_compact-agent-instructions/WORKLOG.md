# WORKLOG — Compact repository agent instructions

- Task ID: `2026-09-17_compact-agent-instructions`
- Updated: 2026-09-17
- Status: Done

## Investigation

- Read existing instructions, README installation guidance, manifest/lockfile, TypeScript and Prettier config, testing/contribution docs, devlog rules/templates, package verifier, E2E runner, test isolation helper, and V2 entrypoint/context pipeline.
- Confirmed no repository-local OpenCode config or additional agent instruction files were found; `.github/workflows/` is empty.
- Found stale V1 hook descriptions, message-mode paths, non-blocking quality-gate claims, test counts/coverage gaps, and Docker/build instructions in the old guidance or referenced docs.
- Verified the runner uses local OpenCode/Bun/Node/curl, loads source directly, and wipes `/tmp/acp-e2e`.
- Recorded pre-existing changes in `index.ts`, state/V2 modules, package manifests, tests, and a separate devlog; these are outside this task.

## Verification

- Before editing: `npm run typecheck` passed.
- `npm run check:package` passed (typecheck and package verification).
- `npm test`: 1,315 passed, 1 failed. `tests/inactive-block-decompress.test.ts:203` hard-codes `/tmp/test-inactive-block-decompress.txt`, but `decompress.toFile` requires the platform's `os.tmpdir()` or `~/.cache/opencode/`; this Mac's temp directory differs. Confirmed in the existing test and `lib/compress/decompress.ts`; left the unrelated fix out of scope.
- Targeted Prettier formatting passed; `git diff --check` passed.
- Local fake-LLM E2E and live OpenCode smoke tests were not run: this change affects documentation only.

## Changes

- Compacted root `AGENTS.md` from 608 lines to a short guide preserving fork workflow and nudge regression requirements.
- Added verified V2 wiring, source-direct packaging, focused test commands, test isolation, configuration merge traps, and macOS temp-path guidance.
- Removed exhaustive module/default dumps and stale architecture, coverage, and build claims.
- Documentation only; no runtime behavior or architecture changes.
- No commit or push requested.
