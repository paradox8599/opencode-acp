# REQ: Detach this fork from the upstream repo workflow

## Background

This repository is `paradox8599/opencode-acp`, a personal fork of `ranxianglei/opencode-acp`. Repo metadata and process docs were still inherited from upstream:

- `AGENTS.md` §1.3 pointed at the upstream repo/author; §5 required branch naming, PRs, dual-agent review, issue tracking and npm releases
- `package.json` `repository` / `homepage` / `author` pointed at upstream
- `.github/workflows/` (ci, pr-checks, pr-artifact, release) plus `scripts/ci/check-pr.sh` implemented the upstream PR + npm release pipeline

Actual usage installs the plugin via `github:paradox8599/opencode-acp`; npm publishing is not used.

## Decision (user-confirmed)

1. Keep the devlog flow (every change gets a devlog entry)
2. No issue-tracking requirement (drop §5.1.3)
3. No CI (remove the workflows and the PR-check script)
4. Update `package.json` metadata to the fork identity

## Acceptance Criteria

- [ ] `AGENTS.md` no longer requires branches, PRs, dual-agent review, issues or npm releases; devlog flow kept; git safety rules slimmed down (force-push, commit consent, push consent, deletion confirmation, version field)
- [ ] `AGENTS.md` §1.3 identifies the fork, keeping upstream attribution
- [ ] `devlog/README.md` naming/rules no longer couple to branches or PRs
- [ ] `package.json`: `repository` / `homepage` / `author` point at the fork; `bugs` field removed
- [ ] `.github/workflows/*` and `scripts/ci/check-pr.sh` deleted
- [ ] `npm run typecheck` and `npm run verify:package` pass; touched files are Prettier-clean

## Constraints

- Process/docs only — no changes under `lib/`
- Historical devlogs, `CHANGELOG.md` / `CHANGELOG.zh-CN.md` untouched
- `.github/FUNDING.yml` and `.github/ISSUE_TEMPLATE/` untouched
