# REQ - Strip Model-Hallucinated dcp/acp Tags from Assistant Output

- Task ID: `2026-09-15_strip-hallucinated-tags`
- Home Repo: `opencode-acp`
- Created: 2026-09-15
- Status: Done
- Priority: P2
- Owner: ACP maintainer
- References: live session `ses_f626c3e02ffePy3ZFAnHEF18vb`; V1 port commit `f1ce636`; harness source `anomalyco/opencode` tag `v2.0.3`

## 1. Background & Problem Statement

- **Context**: V1 ACP had an `experimental.text.complete` hook whose only job was
  `output.text = stripHallucinationsFromString(output.text)` (V1 `lib/hooks.ts`, `createTextCompleteHandler`).
  The V2 port (`f1ce636`) dropped it — V2 has no `text.complete` hook — and nothing replaced it.
- **Current behavior (symptom)**: The model occasionally imitates the `dcp-message-id` tags it sees appended
  to every request message and appends one (with an invented `tokens` value) to its own reply. The harness
  stores assistant text straight from the LLM stream, so those tags persist in the message store
  (`~/.local/share/opencode/opencode.db`, table `session_message`) and show up in the UI. Observed on five
  assistant messages of the live session (m00020, m00095, m00117, m00130, m00183).
- **Evidence that the tags are model output, not plugin output**:
    - Stored tag token values match no ACP computation; e.g. m00130: stored `861` vs chars/4 `384`
      (ACP's tag formula) vs Anthropic BPE `953` vs provider usage output `741`.
    - v2.0.3 has no publisher for `session.message.content.updated` ("Replay-only: older releases allowed
      replacing completed assistant content") — only the LLM stream writes assistant text.
    - The request-side `stripHallucinations` (`lib/hooks.ts:202`) already removes echoed tags from later
      requests, which is why they never cascade.
- **Expected behavior**: Hallucinated dcp/acp tags never reach storage or the UI — matching V1 behavior.
- **Impact**: Cosmetic pollution of message history and UI; no functional damage, but a visible regression
  from V1 that users notice.

## 2. Reproduction (if applicable)

- **Environment**:
    - Node: 24.19.0
    - OS/Arch: darwin-arm64
    - opencode 2.0.3, provider `@ai-sdk/openai-compatible` (LiftAI)
- **Minimal reproduction steps**:
    1. Run a session with a model that occasionally echoes context tags (observed with `o/deepseek-v4.1-flash`).
    2. Inspect the message store for assistant text ending in `<dcp-message-id …>mNNNNN</dcp-message-id>`
       (only the model's reply text — never a tool result).
- **Relevant configuration**: defaults.

## 3. Constraints & Non-Goals

- **Constraints**:
    - V2-only (the plugin is V2-only since `f1ce636`).
    - Type-only dependency on `@ai-sdk/provider` (already present transitively); no runtime imports.
    - Streaming must not delay or reorder output beyond what tag detection requires.
- **Non-Goals** (explicitly out of scope):
    - Cleaning the five already-polluted rows (data surgery — separate decision).
    - Filtering reasoning deltas (Anthropic thinking signatures cover the exact text; V1 only cleaned text).
    - Filtering tool-call inputs/outputs.
    - A config switch (always on — V1 parity).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
    - [x] Streaming filter output equals `stripHallucinationsFromString` for arbitrary chunk splits
          (all two-way splits + fixed-size chunking over a sample corpus).
    - [x] Wrapped `LanguageModelV3`: `doStream` text deltas are cleaned, non-text parts pass through
          untouched, held text is flushed before `text-end`, interleaved text ids stay isolated.
    - [x] `doGenerate` text content is cleaned.
- **Performance / Stability**:
    - [x] Per-delta work is bounded by the delta plus the un-emitted tail; nothing beyond an unterminated
          tag is buffered.
- **Regression**:
    - [x] New test file added and passing; `npm run typecheck`, `npm run verify:package`,
          `npm run test` pass (one pre-existing unrelated failure remains — see WORKLOG).

## 5. Proposed Approach (optional)

- **Affected modules & entry files**: new `lib/v2/hallucination-filter.ts`; `index.ts` registers
  `ctx.aisdk.hook("language", …)` and replaces `event.language` with the wrapped model.
- **Risks**: legitimate prose containing literal `dcp`/`acp` tags is stripped too (by design, same as V1);
  provider routes that do not resolve through the AI SDK (`AISDK.language()`) are not covered by this hook.
- **Rollback strategy**: revert the commit — the hook is additive and stateless.
