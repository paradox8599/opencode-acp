# REQ — Compact repository agent instructions

- Task ID: `2026-09-17_compact-agent-instructions`
- Created: 2026-09-17
- Status: Done

## Problem and scope

The root `AGENTS.md` is 608 lines long and mixes useful fork-specific rules with stale architecture, configuration defaults, test counts, and coverage claims. Replace this with compact, verified instructions for future OpenCode sessions.

## Acceptance criteria

- Preserve current-branch, consent, release, devlog, and nudge regression-test requirements.
- Verify commands, packaging, test isolation, and entrypoint guidance against executable repository sources.
- Remove exhaustive trees, duplicated defaults, historical metrics, and obsolete V1/Docker/build claims.
- Change only `AGENTS.md` and this devlog; leave pre-existing code and dependency changes untouched.
- Check formatting and run the required local verification commands; report any failures without expanding scope.

## Non-goals

No runtime changes, dependency updates, fixes to other documentation, commits, or publishing.
