# REQ - README fork notice (original repo + personal-use disclaimer)

- Task ID: `2026-09-15_readme-fork-notice`
- Home Repo: `opencode-acp`
- Created: 2026-09-15
- Status: Done
- Priority: P2
- Owner: paradox8599
- References: AGENTS.md §1.3

## 1. Background & Problem Statement

- **Context**: This repository is paradox8599's personal fork of `ranxianglei/opencode-acp`, created to run ACP on the OpenCode V2 plugin API. The READMEs did not say so anywhere near the top.
- **Current behavior (symptom)**: Readers (and search engines) could mistake this fork for the original project; the only fork-related hint was the install snippet (`github:paradox8599/opencode-acp`).
- **Expected behavior**: Both READMEs state up front: (a) the original repository, (b) this is a personal-use fork, (c) it may be abandoned at any time once upstream supports V2.
- **Impact**: Sets expectations for support and prevents confusion with upstream.

## 2. Constraints & Non-Goals

- **Constraints**: Keep the note short and consistent across `README.md` and `README.zh-CN.md`; do not rewrite unrelated sections.
- **Non-Goals**: Changing install instructions or badges; documenting the fork's internals (AGENTS.md already covers them).

## 3. Acceptance Criteria

- [x] `README.md` and `README.zh-CN.md` each carry the fork notice directly under the title block.
- [x] The notice names the original repo, marks the fork as personal-use, and warns about abandonment after upstream V2 support.
