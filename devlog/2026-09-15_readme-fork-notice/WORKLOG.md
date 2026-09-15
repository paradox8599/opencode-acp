# WORKLOG - README fork notice (original repo + personal-use disclaimer)

- Task ID: `2026-09-15_readme-fork-notice`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-15

## 1. Summary

- **What was done**: Added a blockquote fork notice under the title block of `README.md` and `README.zh-CN.md`: original repo (`ranxianglei/opencode-acp`), personal-use fork statement, and "may be abandoned at any time once upstream supports V2".
- **Why**: The fork identity and its support expectations were not stated anywhere near the top of either README.
- **Behavior / compatibility changes**: Docs only.
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
| ------ | ----------- |
| (pending user consent) | `docs: add personal-fork notice to both READMEs` |

### Key Files

- `README.md` — fork notice inserted between the title block and the first `---`.
- `README.zh-CN.md` — mirrored notice (same placement).
- `devlog/2026-09-15_readme-fork-notice/` — this entry.

## 3. Design & Implementation Notes

- Placement chosen: directly after the centered title `<p>` block, before the first horizontal rule — the first thing a reader sees, no structural changes elsewhere.
- Wording keeps the user's framing ("personal use", "deprecated/abandoned once upstream supports V2", best-effort support).
- Historical license/lineage sections (e.g. the `ranxianglei` attribution and the DCP fork note) left untouched — they describe upstream lineage, not this fork.

## 4. Testing & Verification

- Docs-only; verified by re-reading the rendered markdown heads (`head -40 README.md README.zh-CN.md`).

## 5. Risk Assessment & Rollback

- **Risk points**: None (markdown-only).
- **Rollback method**: revert the commit.
- **Compatibility notes**: No.

## 6. Follow-ups

- [ ] Badge rows still link to upstream (`ranxianglei/opencode-acp`); revisit only if the fork's identity should extend there.
