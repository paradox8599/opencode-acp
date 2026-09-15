# WORKLOG - Strip Model-Hallucinated dcp/acp Tags

- Task ID: `2026-09-15_strip-hallucinated-tags`
- Branch: `master`
- Started: 2026-09-15
- Status: Done (commit pending user consent)

## 2026-09-15

### Investigation (pre-implementation)

- Root-caused the `dcp-message-id` tags appearing in stored assistant messages of session
  `ses_f626c3e02ffePy3ZFAnHEF18vb`: they are model output (hallucinated echoes), not plugin writes.
    - Stored tag token values match no ACP formula (chars/4, Anthropic BPE, provider usage all differ).
    - v2.0.3 has no publisher for `session.message.content.updated`; only the LLM stream writes assistant text.
    - Verified the plugin's own request-side guard (`stripHallucinations`, `lib/hooks.ts:202`) still exists.
- Found the V1 guard that was dropped in the V2 port: `experimental.text.complete` →
  `createTextCompleteHandler` (V1 `lib/hooks.ts:534-541`).
- Confirmed the V2 replacement mechanism in the harness source (tag v2.0.3):
  `packages/core/src/aisdk.ts:288-293` — the plugin `aisdk.hook("language")` may replace `event.language`;
  core only ever calls `language.doStream(options)` (`aisdk.ts:638`).

### Implementation

- Created devlog entry (REQ / DESIGN).
- Added `lib/v2/hallucination-filter.ts`:
    - `HallucinationTagFilter` — incremental stripper with tag-aware holdback (opener without closer,
      partial tag name / unclosed opener at the buffer tail); `flush()` uses the reference
      `stripHallucinationsFromString`.
    - `withHallucinationFilter(language)` — wraps `doStream` via a `TransformStream` keyed per text id
      (flush delta emitted before `text-end`) and `doGenerate` content text parts.
- Wired the hook in `index.ts` (`ctx.aisdk.hook("language", …)`) right after the bili-proxy guard, so it is
  active whenever ACP is active (V1 parity), independent of compression-tool permission.

### Verification

- `node --import tsx --test tests/hallucination-filter.test.ts` → 9/9 pass (reference-equivalence for all
  two-way splits and 1/2/3/5/7/11-char chunking, wrapper stream/non-stream paths, flush ordering,
  interleaved text ids, reasoning pass-through).
- `tests/v2-setup.test.ts` extended with the `aisdk` fake domain: asserts the `language` hook is registered,
  actually wraps a resolved model, stays off behind the bili proxy, and stays active under
  `compress.permission: "deny"`.
- `npm run typecheck` → pass.
- `npm run verify:package` → pass (103 tarball entries).
- `npm run test` → 1291 tests, 1290 pass, 1 fail — the pre-existing, unrelated
  `tests/inactive-block-decompress.test.ts` failure (macOS `/tmp` path).

### Status

- Implementation complete; **not committed or pushed** (awaiting explicit user consent).
- Docker e2e (`scripts/e2e/run-e2e.sh`) not run: the change does not touch the transform pipeline or nudge
  logic (per AGENTS.md §5.1.1, required only for those).
- Live-effect caveat: the user's config loads `github:paradox8599/opencode-acp`, so the fix reaches real
  sessions only after a push + OpenCode restart (plugin cache refresh).
