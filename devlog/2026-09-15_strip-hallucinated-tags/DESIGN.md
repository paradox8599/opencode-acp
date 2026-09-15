# DESIGN - Streaming Strip of Model-Hallucinated dcp/acp Tags

- Task ID: `2026-09-15_strip-hallucinated-tags`
- Home Repo: `opencode-acp`
- Created: 2026-09-15
- Status: Accepted

## 1. Problem Statement

- **What problem are we solving?** The model occasionally echoes a `dcp-message-id` tag (with an invented
  token count) at the end of its own reply. V1 removed these in `experimental.text.complete`
  (`stripHallucinationsFromString`); the V2 port dropped that hook and nothing replaced it, so the tags are
  stored and displayed.
- **Why now?** Live-session evidence (five polluted messages) and the harness gives no post-completion text
  hook — the port needs an equivalent interception point.

## 2. Goals & Non-Goals

- **Goals**:
    - Strip hallucinated `dcp`/`acp` tags from assistant text **before** the harness persists or displays it.
    - Preserve V1 cleanup semantics exactly (reuse `stripHallucinationsFromString`).
    - Be correct for arbitrary streaming chunk splits.
- **Non-Goals**:
    - Reasoning-delta filtering; tool-input filtering; a config switch; cleaning existing rows.

## 3. Current Architecture (if applicable)

- **How it works today** (v2.0.3): `packages/core/src/aisdk.ts` `AISDK.language()` resolves a provider
  `LanguageModelV3`, runs the plugin `aisdk.hook("language")` chain, and uses
  `event.language ?? sdk.languageModel(…)` (`aisdk.ts:288-293`). `streamLanguage()` then consumes
  `language.doStream(options)` stream parts and converts them to `LLMEvent`s which the session accumulates
  into the stored message parts. Plugins replace `event.language` in the hook (same mutation pattern core
  provider plugins use for `evt.sdk`, see `packages/core/src/plugin/provider/dynamic.ts`).
- **Pain points**: no `experimental.text.complete` equivalent; `http.response` rewriting would need
  per-provider SSE parsing; the message-transform hook cannot see the completion (it runs before requests).

## 4. Proposed Architecture

- **Overview** (text diagram):

```
LLM stream ─ doStream(parts) ─► HallucinationTagFilter (one per text id)
                                  ├─ push(delta) → emit-safe prefix (via stripHallucinationsFromString)
                                  └─ flush() at text-end / stream close → stripped tail delta
                                        ▼
                             harness → message store / UI
```

- **Key components**:
    - `HallucinationTagFilter` (`lib/v2/hallucination-filter.ts`): incremental stripper. Emits only the
      prefix that can no longer participate in a tag match and holds the rest; `flush()` finishes with the
      reference function `stripHallucinationsFromString`.
    - `withHallucinationFilter(language)`: returns a `LanguageModelV3`-shaped object with `doStream`
      (stream rewrite) and `doGenerate` (content rewrite) wrapped; every other field is delegated.
    - `index.ts`: `await ctx.aisdk.hook("language", (event) => { … event.language = withHallucinationFilter(event.language) })`.
- **Data flow**: text deltas → per-`id` filter → cleaned deltas (plus a synthetic delta ahead of `text-end`
  when text was held) → harness accumulation.
- **API / interface changes**: none (no new config, no new tools).

## 5. Design Decisions & Rationale

| Decision           | Options Considered                                   | Chosen                 | Why                                                                                                                |
| ------------------ | ---------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Hook point         | `http.response` SSE rewrite; `aisdk` "language" hook | `aisdk` "language"     | Provider-agnostic, structured parts, no SSE framing; core uses it as the model override point                      |
| Filtering strategy | Filter only at `text-end`; holdback stream filter    | Holdback stream filter | Deltas reach the UI before `text-end`, so a tag must be dropped while streaming, not afterwards                    |
| Match semantics    | New regexes; reuse `stripHallucinationsFromString`   | Reuse                  | Identical to V1 and to the request-side cleanup already in `lib/messages/utils.ts`                                 |
| Holdback rule      | Hold on any `<`; hold only when a tag can still form | Tag-aware holdback     | Avoids delaying ordinary text (`a < b`, `<div>`) while staying exact for tag prefixes                              |
| Reasoning deltas   | Filter too; skip                                     | Skip                   | Anthropic thinking signatures cover the exact text; mutating reasoning risks replay failures; V1 cleaned text only |
| Config gating      | New config flag                                      | Always on              | V1 parity — the guard is part of ACP being active                                                                  |

## 6. Impact Analysis

- **Backward compatibility**: no state, config, or storage format changes.
- **Performance**: per delta, one anchored `search` plus an opener/closer scan over the un-emitted tail
  (bounded by the distance to the last complete tag; an unterminated opener holds the message tail until
  `text-end` — rare, and the text still arrives).
- **Security**: none.
- **Dependencies**: `@ai-sdk/provider` **types only** (type-only import; resolvable via `@opencode/plugin`'s
  dependency — no runtime import, no new package).

## 7. Migration Plan (if applicable)

- None — additive, stateless hook.

## 8. Open Questions

- [ ] Clean the five already-polluted rows in the user's message store? (separate task, needs explicit ask)
