# opencode-acp Development Specification

> **This document is the highest-priority specification for this project. All developers (including AI Agents) MUST comply unconditionally.**

---

## 1. Project Overview

### 1.1 What Is ACP

**Active Context Pruning (ACP)** is an [OpenCode](https://opencode.ai) plugin that implements model-driven context management. Instead of passively truncating context at a hard limit, ACP exposes a `compress` tool to the AI model, letting it decide **when** and **what** to compress into high-fidelity summaries.

ACP is a hardened fork of [DCP](https://github.com/Tarquinen/opencode-dynamic-context-pruning) with **39 bug fixes**, including state persistence, token reporting, GC deactivation, 268x logger speedup, auto-recovery for reversed boundaries, and hard-exclusion of protected tools from compression ranges.

### 1.2 Tech Stack

| Category           | Technology                                                           |
| ------------------ | -------------------------------------------------------------------- |
| Language           | TypeScript (strict, ESM)                                             |
| Runtime            | Node.js                                                              |
| Build              | None — source-direct entry (`index.ts`); `tsc --noEmit` for checking |
| Test Runner        | Node.js built-in: `node --import tsx --test tests/*.test.ts`         |
| Package Manager    | npm                                                                  |
| Linting/Formatting | Prettier                                                             |
| Plugin SDK         | `@opencode/plugin` 2.0.3 (devDependency; OpenCode V2 plugin API)     |
| Tokenizer          | `@anthropic-ai/tokenizer`                                            |
| Config Parsing     | `jsonc-parser`                                                       |
| Validation         | `zod`                                                                |

### 1.3 Repository Info

This repository is **paradox8599's personal fork** of the upstream project — development happens here; upstream is reference only (no upstream remote configured).

| Field           | Value                                         |
| --------------- | --------------------------------------------- |
| GitHub          | https://github.com/paradox8599/opencode-acp   |
| Upstream        | https://github.com/ranxianglei/opencode-acp   |
| npm package     | `opencode-acp` (not published from this fork) |
| License         | AGPL-3.0-or-later                             |
| Maintainer      | paradox8599                                   |
| Original author | ranxianglei                                   |

---

## 2. Architecture

### 2.1 Module Map

```
opencode-acp/
├── index.ts                          # Plugin entry point — wires hooks, tools, commands, config
├── lib/
│   ├── hooks.ts                      # Plugin hook handlers (system prompt, message transform, command, event, text-complete)
│   ├── config.ts                     # Three-layer config: global → config-dir → project
│   ├── logger.ts                     # Structured logging (logs/acp/)
│   ├── auth.ts                       # Plugin authentication
│   ├── token-utils.ts                # Token counting utilities
│   ├── message-ids.ts                # Message ID mapping (raw ↔ mNNNNNN refs)
│   ├── compress-permission.ts        # Permission management for compress tool
│   ├── protected-patterns.ts         # File pattern protection logic
│   ├── host-permissions.ts           # Host-based permission system
│   │
│   ├── compress/                     # Compression subsystem
│   │   ├── pipeline.ts               # Shared prepare/finalize pipeline for both modes
│   │   ├── range.ts                  # Range-mode compress tool (contiguous spans → block summaries)
│   │   ├── message.ts                # Message-mode compress tool (individual message summaries)
│   │   ├── search.ts                 # Boundary resolution: maps IDs → message indices
│   │   ├── state.ts                  # Block allocation, state mutation, wrapping
│   │   ├── message-utils.ts          # Message-level utilities for compression
│   │   ├── protected-content.ts      # Protected content injection into summaries
│   │   ├── range-utils.ts            # Range-level utility functions
│   │   ├── timing.ts                 # Compression timing tracking
│   │   ├── types.ts                  # Shared type definitions (ToolContext, BoundaryReference, etc.)
│   │   ├── quality-gate/             # Post-compression quality evaluation (non-blocking, pluggable)
│   │   │   ├── types.ts              # QualityGate interface, QualityGateContext, QualityReport
│   │   │   ├── registry.ts           # Singleton Map; registerQualityGate / getQualityGate / list
│   │   │   ├── tokenizer.ts          # Hand-rolled word-level tokenizer (EN keywords + ZH uni/bigrams)
│   │   │   ├── evaluate.ts           # Orchestrator: evaluateBlockQuality + evaluateBatchQuality
│   │   │   ├── algorithms/
│   │   │   │   ├── rouge-recall-v1.ts # Default gate: L1 length floor + L2 ROUGE-1 F1 AND top-20 recall
│   │   │   │   └── index.ts          # ensureBuiltinGatesRegistered() idempotent initializer
│   │   │   └── index.ts              # Barrel export
│   │   └── index.ts                  # Barrel export
│   │
│   ├── messages/                     # Message processing pipeline
│   │   ├── inject/
│   │   │   ├── inject.ts             # Nudge injection (context-limit, turn, iteration) + message ID injection
│   │   │   └── utils.ts              # Anchor management, context usage calculation, budget computation
│   │   ├── prune.ts                  # Replace compressed ranges with summaries, strip tool outputs
│   │   ├── sync.ts                   # Sync compression blocks with actual messages (deactivate orphans)
│   │   ├── priority.ts               # Message priority computation
│   │   ├── query.ts                  # Message query utilities
│   │   ├── shape.ts                  # Message shape analysis
│   │   ├── reasoning-strip.ts        # Strip reasoning tokens from messages
│   │   ├── utils.ts                  # General message utilities
│   │   └── index.ts                  # Barrel export
│   │
│   ├── prompts/                      # Prompt system
│   │   ├── index.ts                  # System prompt renderer (base + extensions)
│   │   ├── store.ts                  # 6 editable prompts, file-based overrides at 3 levels
│   │   ├── system.ts                 # Base system prompt template
│   │   ├── compress-message.ts       # Message-mode compress prompt
│   │   ├── compress-range.ts         # Range-mode compress prompt
│   │   ├── context-limit-nudge.ts    # Context limit nudge template
│   │   ├── turn-nudge.ts             # Turn nudge template
│   │   ├── iteration-nudge.ts        # Iteration nudge template
│   │   └── extensions/
│   │       └── nudge.ts              # Block aging warnings + message priority guidance
│   │
│   ├── state/                        # State management
│   │   ├── state.ts                  # SessionState creation, session change detection
│   │   ├── persistence.ts            # File persistence (plugin/acp/{sessionId}.json)
│   │   ├── tool-cache.ts             # Tool result caching
│   │   ├── types.ts                  # Core types (SessionState, CompressionBlock, Prune, etc.)
│   │   ├── utils.ts                  # State utility functions
│   │   └── index.ts                  # Barrel export
│   │
│   ├── gc/
│   │   └── truncate.ts               # Age-based deactivation + old-gen summary truncation
│   │
│   ├── commands/                     # /acp slash commands
│   │   ├── index.ts                  # Command barrel (context, stats, export)
│   │   ├── context.ts                # /acp context — show current context usage
│   │   ├── stats.ts                  # /acp stats — show compression statistics
│   │   ├── export.ts                 # /acp export — export compression blocks to markdown
│   │   └── compression-targets.ts    # Target selection for manual compression
│   │
│   ├── ui/
│   │   ├── notification.ts           # Compression notification builder (chat/toast, minimal/detailed)
│   │   └── utils.ts                  # UI formatting utilities
│   │
│   ├── v2/                           # OpenCode V2 plugin adapter layer
│   │   ├── ai-adapter.ts             # @opencode/ai Message[] ⇄ internal WithParts
│   │   ├── session-adapter.ts        # session.context() messages → internal model
│   │   ├── host.ts                   # Client facade (session/catalog) + notices
│   │   ├── context-handler.ts        # ctx.session.hook("context") pipeline wrapper
│   │   └── tool.ts / tools.ts        # zod tool definitions → V2 tool values
│   │
│   └── update.ts                     # Auto-update check and notification
│
├── devlog/                           # Development iteration logs (templates + per-iteration entries)
│   ├── README.md                     # Usage guide and naming conventions
│   ├── REQ.template.md               # Requirement template
│   ├── WORKLOG.template.md           # Worklog template
│   ├── DESIGN.template.md            # Design document template
│   └── YYYY-MM-DD_short-title/       # One folder per iteration (REQ.md + WORKLOG.md minimum)
│
├── scripts/                          # Utility scripts
│   ├── print.ts                      # Print DCP info
│   ├── verify-package.mjs            # Package verification before publish
│   ├── README.md                     # Scripts documentation
│   └── ...                           # CLI tools for session inspection
│
├── tests/                            # Test files — 591 tests across 45 files
├── lib/config-validation.ts          # Pure validation logic (extracted from config.ts for testability)
├── dcp.schema.json                   # JSON schema for config validation
├── tsconfig.json                     # TypeScript config
└── package.json                      # Package manifest (source entry: index.ts)
```

### 2.2 Core Data Flow

```
OpenCode Session
    │
    ▼
index.ts (Plugin Entry — registers hooks + tools)
    │
    ├─► System Prompt Hook (experimental.chat.system.transform)
    │       └─► prompts/index.ts → renderSystemPrompt()
    │               base prompt + extensions (protected tools, manual mode, subagent mode)
    │
    ├─► Message Transform Hook (experimental.chat.messages.transform) ← runs EVERY LLM call
    │       │
    │       ├─► registry.getOrCreate() → resolve per-session state (init + load persisted)
    │       ├─► updatePerTurnState() → compaction detection + turn count
    │       ├─► stripHallucinations() → remove stale mNNNNN refs from model output
    │       ├─► assignMessageRefs() → bidirectional map: raw message IDs ↔ mNNNNN refs
    │       ├─► syncCompressionBlocks() → deactivate orphaned blocks (messages deleted externally)
    │       ├─► runMajorGC() → age-based block deactivation + truncate oversized summaries
    │       ├─► prune() → replace compressed ranges with summary blocks in messages
    │       ├─► injectCompressNudges() → add context-limit / turn / iteration nudges
    │       │       └─► includes block aging guidance (only when context usage > 50%)
    │       ├─► injectMessageIds() → tag every message with mNNNNN ref (or BLOCKED)
    │       ├─► applyAnchoredNudges() → render nudge text into actual messages
    │       └─► stripStaleMetadata() → clean up removed messages' metadata
    │
    ├─► Command Hook (command.execute.before)
    │       └─► /acp {help|context|stats|export}
    │           (also accepts /dcp for backward compatibility)
    │
    ├─► Event Hook (event)
    │       └─► Track compress tool start/complete → attach duration to blocks
    │
    ├─► Text Complete Hook (experimental.text.complete)
    │       └─► Strip hallucinated mNNNNN/bN refs from completions
    │
    └─► Compress Tool (registered as "compress")
            │
            ├─► prepareSession() → permission check, fetch messages, init state
            │
            ├─► [range mode] resolve ranges → map startId/endId to message indices
            │       ├─► Auto-swap reversed boundaries (Bug 34 fix)
            │       ├─► Inject nested block placeholders into summaries
            │       └─► Append protected content (user msgs, tags, tool outputs)
            │
            ├─► [message mode] resolve individual messages
            │
            ├─► applyCompressionState() → allocate block/run IDs, deactivate consumed blocks
            │       ├─► Create CompressionBlock (generation: young → old)
            │       ├─► Update byMessageId index
            │       └─→ Track newly compressed tokens
            │
            └─► finalizeSession() → save state, evaluate quality gate (non-blocking), send notification
```

### 2.3 Key Concepts

#### Compression Blocks

When the model calls `compress`, one or more `CompressionBlock` objects are created:

- Each block has a `blockId` (bN) and `runId` for tracking
- Blocks track which messages/tools they cover (`directMessageIds`, `effectiveMessageIds`)
- Blocks can **nest** (newer compressions can consume older blocks)
- Blocks have a **generation**: `young` (newly created) → `old` (promoted after `promotionThreshold` survivals)
- Old-gen blocks can be **truncated** by GC if their summaries exceed `maxOldGenSummaryLength`
- Blocks track `survivedCount` — incremented each message-transform hook run

#### Message IDs

ACP maintains a bidirectional mapping:

- **Raw IDs**: OpenCode's internal message IDs (UUIDs)
- **Refs**: Short human-readable IDs (`m00001`, `m00002`, ...) shown to the model (5-digit zero-padded, max 99999)
- The model uses refs in `compress` tool calls (`startId: "m00005"`, `endId: "m00012"`)
- Block IDs use format `b0`, `b1`, etc.
- Protected messages get `BLOCKED` ref to prevent compression
- **Backward compat**: Old 4-digit refs (pre-1.1.0) are auto-migrated to 5-digit on state load

#### Session State

`SessionState` holds per-session runtime data:

- `prune` — compression state (blocks, message pruning map, active blocks)
- `nudges` — anchor tracking for context-limit, turn, and iteration nudges
- `stats` — token accounting
- `messageIds` — raw ↔ ref mapping
- `compressionTiming` — tool execution duration tracking
- `toolParameters` — tool call parameter cache

State is persisted to `~/.local/share/opencode/storage/plugin/acp/{sessionId}.json`.

### 2.4 Configuration System

Three-layer config merging (later layers override earlier; each layer may use `.jsonc` or `.json`, `.jsonc` wins):

```
1. Global:     $XDG_CONFIG_HOME/opencode/acp.jsonc (default: ~/.config/opencode/acp.jsonc)
2. Config dir: $OPENCODE_CONFIG_DIR/acp.jsonc (only when the env var is set)
3. Project:    nearest `.opencode/acp.jsonc` walking up from the session directory
```

On first run, `createDefaultConfig()` (`lib/config.ts:460`) writes a stub global `acp.jsonc` containing only `$schema` if none exists.

#### Default Configuration

`defaultConfig` (`lib/config.ts:314`) — the effective values when no config layer overrides them:

```typescript
{
    enabled: true,
    autoUpdate: true,
    debug: false,
    logLevel: "info",                 // "debug" | "info" | "warn" | "error"; debug: true forces full debug logging
    allowSubAgents: true,
    pruneNotification: "off",         // "off" | "minimal" | "detailed"
    pruneNotificationType: "toast",   // "chat" | "toast" — chat mode can freeze providers that reject empty messages
    commands: {
        enabled: true,
        protectedTools: ["task", "skill", "todowrite", "todoread", "compress", "decompress", "batch", "plan_enter", "plan_exit", "write", "edit"],
    },
    experimental: { customPrompts: false },
    protectedFilePatterns: [],
    compress: {
        permission: "allow",          // "allow" | "ask" | "deny"
        showCompression: true,
        summaryBuffer: true,
        candidates: false,            // opt-in micro/episode candidates in nudges + acp_status
        maxContextLimit: "80%",       // number | "NN%" of the model context limit
        minContextLimit: "80%",       // @deprecated — scheduled for removal, kept honored until then
        contextLimitFallback: 128000, // used when the model's window is unknown; 0 disables the fallback
        nudgeFrequency: 5,            // turn nudge every N turns
        minNudgeContextPercent: 5,
        nudgeGrowthTokens: 50000,     // growth-nudge re-arm threshold (tokens)
        iterationNudgeThreshold: 15,  // nudge after N messages since the last user message
        nudgeForce: "soft",           // "strong" | "soft"
        protectedTools: ["skill", "compress"], // root default; an explicit array replaces inherited policy (use [] to protect nothing)
        protectTags: false,
        protectUserMessages: false,
        maxSummaryLengthHard: 20000,
        minCompressRange: 5000,
        minNudgeGrowthRatio: 0.45,
        minNudgeGrowthFloor: 5000,
        emergencyThresholdPercent: "98%",
        maxVisibleSegments: 50,
        keepEmbedMaxChars: 2000,
        lastSegmentSoftBlock: true,
        preserveRecentMessages: 5,    // protected tail (messages)
        preserveRecentTokens: 5000,   // protected tail (tokens)
        preserveLastUserMessage: true,
        reasoning: { drop: true, threshold: 2048 }, // #368 — drop oversized reasoning from closed-turn compress calls
    },
    gc: {
        algorithm: "truncate",
        promotionThreshold: 5,           // young → old after this many survivals
        maxBlockAge: Number.MAX_SAFE_INTEGER, // no-op — age-based deactivation removed (memory-loss fix)
        maxOldGenSummaryLength: 3000,    // truncate old-gen summaries exceeding this (chars)
        majorGcThresholdPercent: "100%", // run major GC when usage exceeds this
        batchCleanup: { lowThreshold: "55%", highThreshold: "75%", forceThreshold: "90%" },
    },
    qualityGate: {
        enabled: false,
        algorithm: "rouge-recall-v1",
        algorithms: {
            "rouge-recall-v1": { layer1MinChars: 200, layer1MinRetentionPct: 5.0, layer2MaxRougeF1: 0.05, layer2MaxTop20Recall: 0.2 },
        },
    },
    messageFilters: {
        enabled: true,
        filters: {
            "omo-system-reminder": { enabled: true },
            "omo-todo-continuation": { enabled: true },
            "omo-context": { enabled: true },
            "omo-task-directive": { enabled: true },
            "omo-mode-injection": { enabled: true },
        },
    },
}
```

Keys with no default (unset unless configured): `storagePath`, `compress.modelMaxLimits`, `compress.providers` (per-provider/per-model cascade, resolved field-by-field: `providers[p].models[m]` > `providers[p]` > global), `compress.completionReserveTokens`, `compress.toolOutputNudgeThreshold`.

The `"compress"` tool is always force-protected from compression, regardless of `compress.protectedTools` / `commands.protectedTools` overrides.

### 2.5 Storage Paths

| What              | ACP Path                          | Notes         |
| ----------------- | --------------------------------- | ------------- |
| State persistence | `plugin/acp/{sessionId}.json`     | JSON file I/O |
| Config            | `~/.config/opencode/acp.jsonc`    | JSONC         |
| Prompt overrides  | `~/.config/opencode/acp-prompts/` | File-based    |
| Debug logs        | `logs/acp/`                       | Per-request   |

Base storage: `~/.local/share/opencode/storage/`

### 2.6 Internal vs External Naming

ACP maintains **backward compatibility** with DCP in internal code:

| Scope                                                                                                                 | Naming Convention                |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **User-visible** (commands, UI, notifications, docs, config files, storage paths)                                     | `ACP`, `acp`                     |
| **Internal code** (XML tags, regex variables, schema URLs)                                                            | `dcp` — kept for backward compat |
| **Examples**: `dcp-message-id` tag, `dcp-system-reminder` tag, `DCP_BLOCK_ID_TAG_REGEX`, `dcp.schema.json` schema URL |

**Rule**: Never change internal `dcp` naming without a migration plan. These tags appear in persisted state and LLM interactions.

---

## 3. Development Standards

### 3.1 Commands

```bash
npm run typecheck      # TypeScript type checking (no emit)
npm run test           # Run tests: node --import tsx --test tests/*.test.ts
npm run format         # Format with Prettier
npm run format:check   # Check formatting
npm run verify:package # Verify package contents before publish
npm run check:package  # Typecheck + verify
```

### 3.2 Packaging (source-direct)

The package ships **TypeScript source**: `exports` points at `index.ts`, and OpenCode loads it through Bun's TS support. There is no bundling step and no `dist/`.

- Published files (per `files` field): `index.ts`, `lib/`, `README.md`, `LICENSE`
- Runtime dependencies are installed by OpenCode's plugin installer (`~/.cache/opencode/npm/...`); devDependencies are never installed
- `@opencode/plugin` is a **devDependency** and must stay type-only at runtime (verified by `verify:package`)

### 3.3 Testing

**Test runner**: `node --import tsx --test tests/*.test.ts`

**Test directory**: Flat `tests/` structure — all test files in `tests/*.test.ts`. No subdirectories.
The project has ~70 source files under `lib/` and 45 test files; flat structure is sufficient.

This fork does not use CI — run typecheck + tests locally before committing (Section 5.1.1).

**Baseline**: Tag `v1.0.1-test-baseline` — 95 tests, initial state before ACP test fixes.

**Test categories** (by naming convention, all in `tests/`):

| Category          | Files                                                                                                                                                                              | Tests | Description                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------ |
| **Baseline**      | `hooks-permission.test.ts`, `compress-message.test.ts`, `compress-range.test.ts`, `message-priority.test.ts`, `token-counting.test.ts`, `context-limits.test.ts`, `update.test.ts` | 95    | Original DCP tests, adapted for ACP  |
| **Tier 1 (pure)** | `config-validation.test.ts`, `priority-classify.test.ts`, `shape.test.ts`, `query-pure.test.ts`, `gc-truncate-pure.test.ts`, `state-utils-pure.test.ts`                            | 83    | Pure function tests, no side effects |
| **Tier 2 (mock)** | `query-mock.test.ts`, `gc-truncate-mock.test.ts`                                                                                                                                   | 68    | Mock-data unit tests                 |
| **Functional**    | `compress-search.test.ts`, `compress-state.test.ts`, `message-ids.test.ts`                                                                                                         | 77    | Compress pipeline with mock data     |
| **E2E**           | `e2e-message-transform.test.ts`, `e2e-blocks-nudges.test.ts`                                                                                                                       | 21    | Full message-transform pipeline      |

**Total: 591 tests, 0 failures** (as of v1.10.0)

**Coverage gaps** (modules still without dedicated tests):

- `state/persistence.ts` — state persistence
- `messages/prune.ts` — prune replacement logic
- `messages/sync.ts` — block synchronization
- `messages/inject/inject.ts` — nudge injection
- `commands/*.ts` — slash command handlers
- `ui/notification.ts` — notification builder

### 3.4 Local Testing (source-direct)

There is no build or deploy step: point OpenCode at this checkout once, then restart it after code changes.

```jsonc
// ~/.config/opencode/opencode.jsonc
{
    "plugins": ["/absolute/path/to/opencode-acp"],
}
```

- The entry is `index.ts` — edit source and restart OpenCode to pick changes up.
- End users install from GitHub instead: `"github:paradox8599/opencode-acp"`.
- **⚠️ Restart OpenCode** after changing the plugin list or the source — the running process caches modules in memory.
- Local-path plugins resolve imports from this repo's `node_modules`; GitHub-installed plugins get their `dependencies` installed by OpenCode's installer.

**ACP debug logs** (for verifying injection behavior):

```
~/.config/opencode/logs/acp/context/<session_id>/<timestamp>.json   # per-request message snapshots
~/.config/opencode/logs/acp/daily/<date>.log                        # WARN/ERROR always; INFO/DEBUG when debug: true
```

## 4. Code Change Guidelines

### 4.1 Module Dependencies

**Dependency graph** (simplified):

```
config.ts ← (consumed by everything)
    ↑
state/state.ts ← state/persistence.ts
    ↑
hooks.ts ← messages/inject, messages/prune, messages/sync, gc, prompts, state
    ↑
compress/pipeline.ts ← state, config
    ↑
compress/range.ts ← compress/search, compress/state, compress/pipeline
compress/message.ts ← compress/search, compress/state, compress/pipeline
```

**Rules**:

- `config.ts` has no internal dependencies (leaf node)
- `state/` depends only on `config` and SDK types
- `hooks.ts` is the orchestrator — depends on most other modules
- `compress/` subsystem is self-contained; external code uses it through `pipeline.ts` or the tool functions

### 4.2 Key File Sizes (Complexity Indicators)

| File                            | Lines | Notes                                                   |
| ------------------------------- | ----- | ------------------------------------------------------- |
| `lib/config.ts`                 | ~1125 | Largest file — validation, merging, migration, defaults |
| `lib/hooks.ts`                  | ~700  | Core pipeline orchestration                             |
| `lib/compress/range.ts`         | ~600  | Range-mode compression logic                            |
| `lib/messages/inject/inject.ts` | ~500  | Nudge system brain                                      |
| `lib/prompts/store.ts`          | ~478  | Prompt management                                       |
| `lib/compress/search.ts`        | ~450  | Boundary resolution                                     |

### 4.3 Common Patterns

**State access pattern**: All modules receive `PluginConfig`, `SessionState`, and `Logger` through function parameters or a `ToolContext` object. No global singletons.

**Message transform pipeline**: Sequential steps in `hooks.ts`. Order matters — each step depends on the output of previous steps. Do NOT reorder without understanding dependencies.

**ID resolution**: The model uses short refs (`m0`, `b3`). These must be resolved to raw UUIDs via `messageIds.byRef` before any operation. Search (`compress/search.ts`) handles boundary resolution.

**Protected content**: Tools in `protectedTools` arrays and files matching `protectedFilePatterns` are never pruned. Their content is injected into compression summaries.

### 4.4 Bug Fix History (Key Fixes)

For reference when modifying code — these bugs were real and the fixes are load-bearing:

| Bug                | Fix Location                               | What It Fixed                                                                                                                                                                                      |
| ------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bug 39             | `compress/range.ts`, `compress/message.ts` | Hard-exclude protected tool messages (skill/task/todowrite) from compression ranges — they survive intact in visible context instead of being soft-appended to summaries (which GC could truncate) |
| Bug 35             | `nudge.ts`                                 | Aging warning only shows when context usage > 50% (was showing at 20-30%)                                                                                                                          |
| Bug 34             | `search.ts`                                | Auto-swap reversed compress boundaries (model gave endId < startId)                                                                                                                                |
| State persistence  | `persistence.ts`                           | State survives restart (was lost before)                                                                                                                                                           |
| Token reporting    | `token-utils.ts`                           | Returns actual token counts (was returning 0)                                                                                                                                                      |
| GC deactivation    | `gc/truncate.ts`                           | Age-based block deactivation (blocks were never deactivated)                                                                                                                                       |
| Logger speedup     | `logger.ts`                                | 268x faster tokenization (was using sync API)                                                                                                                                                      |
| Summary resolution | `compress/range.ts`                        | Block placeholder injection for nested compressions                                                                                                                                                |

---

## 5. Contributing

### 5.1 Before Making Changes

1. Run `npm run typecheck` to ensure no type errors
2. Keep the files you touch Prettier-formatted (`npx prettier --write <files>`; repo-wide `format:check` has pre-existing drift)
3. Understand the module dependency graph (Section 4.1)
4. Check if the change affects backward compatibility (Section 2.6)

### 5.1.1 Development Workflow

All changes MUST follow this workflow:

1. Work on the current branch — do NOT create a feature branch (this fork commits to `master` directly)
2. Create devlog entry: `devlog/{YYYY-MM-DD_short-title}/` with `REQ.md` and `WORKLOG.md` (see Section 5.1.2)
3. Implement changes
4. Ensure `npm run typecheck` and `npm run verify:package` pass
5. Ensure all tests pass: `npm run test` — plus `./scripts/e2e/run-e2e.sh` when the transform pipeline or nudge logic is affected
6. Commit with descriptive **English** messages (include devlog files) — ONLY after the user has explicitly agreed to commit
7. Push or publish ONLY on explicit instruction — this fork has no CI and does not publish to npm

### 5.1.1.1 Git Safety Rules (MANDATORY)

| Rule                                                         | Enforcement                                                                  |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| **NEVER force-push to `master`**                             | Under no circumstances — no history rewrites, not even for fixes or reverts. |
| **NEVER commit without the user's explicit consent**         | "Looks good" is not a commit request. Ask first.                             |
| **NEVER push (or publish) unless explicitly instructed**     | Commits stay local until the user says otherwise.                            |
| **NEVER delete branches or tags without human confirmation** | Preserve work for review.                                                    |
| **NEVER modify the `version` field in `package.json`**       | Only during an explicit release task the user asked for.                     |

### 5.1.2 Devlog Requirement (MANDATORY)

Every change MUST have a corresponding devlog entry in `devlog/{YYYY-MM-DD_short-title}/`.

**Rules:**

- The folder name describes the change — there is no branch to match (this fork works directly on the current branch)
- `REQ.md` and `WORKLOG.md` are the required minimum
- `DESIGN.md` is required for any change affecting architecture, data flow, or module boundaries
- `REQ.md` should be filled **BEFORE** implementation (functions as a ticket)
- `WORKLOG.md` should be updated **DURING** and **AFTER** implementation
- Devlog files are committed alongside code changes — not as a separate afterthought

See `devlog/README.md` for templates and naming conventions.

### 5.2 After Making Changes

1. `npm run typecheck` must pass
2. `npm run verify:package` must pass
3. Run relevant tests
4. Deploy locally and test in opencode

### 5.5 Commit Convention

Use descriptive commit messages written in **English**. Historical examples:

- `fix: aging warning only shows when context usage > 50%`
- `feat: /dcp → /acp command rename with backward compat`
- `chore: bump version to 1.0.1`
- `fix: config migration moved to getConfig() entry point`

### 5.7 Nudge & Growth Testing Requirements (MANDATORY)

Changes to `lib/messages/inject/` or nudge-related logic MUST include tests that satisfy ALL of the following. These requirements were added after the **baseline-reset bug** (PR #207) — a production bug where `lastPerMessageNudgeTokens` was silently reset on `nothingToCompress`, creating a feedback loop that prevented nudges from ever firing in short/subagent sessions. The existing test suite (900+ tests) failed to catch this bug due to five structural gaps.

#### 5.7.1 Unit Test Requirements

| Requirement                | What                                                                                                               | Why                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Multi-turn**             | At least 2 consecutive `injectCompressNudges` calls in the same test, sharing `SessionState`                       | Single-turn tests cannot catch cross-turn state bugs (baseline accumulation, feedback loops, proportional adjustment)                                              |
| **Side-effect assertions** | Assert BOTH `shouldInjectThisTurn` AND `lastPerMessageNudgeTokens` (and/or `lastNudgeShownTokens`) after each call | Checking only `shouldInject` misses baseline mutations that are invisible until the next turn                                                                      |
| **Production config**      | At least one test per change MUST use `preserveRecentMessages > 0` (production default: 5)                         | All existing tests use `preserveRecentMessages: 0`, which disables protection — the exact scenario that triggers `nothingToCompress` in production is never tested |
| **Growth cycle**           | At least one test covers the full cycle: baseline → growth → nudge → compress → new baseline → growth → nudge      | Verifies that the nudge system self-resets correctly after compression and can fire again                                                                          |

#### 5.7.2 Docker E2E Requirements

Docker E2E tests (`scripts/e2e/`) MUST cover:

| Requirement                     | What                                                                                                                                                                                                                 | Why                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Nudge-triggered compression** | At least one scenario using `"respond": "nudge-compress"` — the fake LLM detects ACP's nudge injection via `detectNudge()` (scans user-role messages for nudge-unique phrases) and emits a compress call in response | Tests the real nudge→compress flow, not just scripted compress calls          |
| **Nudge state verification**    | `verify.ts` MUST check nudge state fields (`lastPerMessageNudgeTokens`) not just `blockCount`                                                                                                                        | Block count alone cannot detect baseline corruption or nudge suppression bugs |
| **Growth accumulation**         | At least one scenario where context grows across multiple turns past the nudge threshold                                                                                                                             | Tests that all-compress-in-one-turn don't exercise the growth-gating logic    |

The `fake-llm-server.ts` reports `prompt_tokens` from actual input message sizes (via `computeInputTokens`), so ACP sees realistic token counts for threshold evaluation.

#### 5.7.3 Why These Requirements Exist

The baseline-reset bug (PR #207) was a **1-line production bug** that survived 900+ tests because:

1. All tests checked `shouldInjectThisTurn` but not `lastPerMessageNudgeTokens` → baseline reset was invisible
2. All tests were single-turn → the feedback loop (baseline eaten each turn) was invisible
3. All tests used `preserveRecentMessages: 0` → the `nothingToCompress` path (which triggers the bug) was never exercised
4. Docker E2E only verified `blockCount` → nudge state corruption was invisible
5. Docker E2E scenarios only used explicit compress calls → the nudge→compress flow was untested

**Lesson**: Tests that pass against buggy code are worse than no tests — they create false confidence. Every nudge/growth test MUST be verified to FAIL when the bug is present (temporarily revert the fix, run the test, confirm it fails, then re-apply the fix).
