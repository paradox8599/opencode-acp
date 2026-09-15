import type { CompressionTimingState } from "../compress/timing"

/**
 * Internal message model.
 *
 * ACP's pipeline historically operated on the V1 SDK message shape
 * (`{ info, parts }`). The OpenCode V2 plugin API hands plugins native
 * `@opencode/ai` messages instead, so the pipeline keeps this internal shape
 * and `lib/v2/ai-adapter.ts` translates in both directions. Only the fields
 * the pipeline reads/writes are declared; extra fields are preserved by the
 * adapter's source references.
 */

export interface AcpToolState {
    status: "pending" | "running" | "completed" | "error"
    input?: unknown
    output?: string
    error?: string
    title?: string
    metadata?: Record<string, unknown>
    time?: { start?: number; end?: number; completed?: number }
}

export interface AcpPart {
    type: string
    text?: string
    tool?: string
    callID?: string
    id?: string
    sessionID?: string
    messageID?: string
    state?: AcpToolState
    metadata?: Record<string, unknown>
    synthetic?: boolean
    ignored?: boolean
    reason?: string
    [key: string]: unknown
}

export interface AcpMessageInfo {
    id: string
    sessionID?: string
    role: "user" | "assistant" | "system"
    time: { created: number }
    summary?: boolean
    tokens?: {
        input?: number
        output?: number
        reasoning?: number
        cache?: { read?: number; write?: number }
    }
    model?: { providerID?: string; modelID?: string; variant?: string }
    modelID?: string
    providerID?: string
    parentID?: string
    agent?: string
    mode?: string
    path?: { cwd?: string; root?: string }
    cost?: number
    tools?: unknown
    [key: string]: unknown
}

export interface WithParts {
    info: AcpMessageInfo
    parts: AcpPart[]
}

export type ToolStatus = "pending" | "running" | "completed" | "error"

export interface ToolParameterEntry {
    tool: string
    parameters: any
    status?: ToolStatus
    error?: string
    turn: number
    tokenCount?: number
}

export interface SessionStats {
    pruneTokenCounter: number
    totalPruneTokens: number
}

export interface PrunedMessageEntry {
    tokenCount: number
    allBlockIds: number[]
    activeBlockIds: number[]
}

export type CompressionMode = "range" | "message"

export type BlockGeneration = "young" | "old"

export type CompressionTier = 1 | 2 | 3

export interface CompressionBlock {
    blockId: number
    runId: number
    active: boolean
    deactivatedByUser: boolean
    deactivatedByUserDeep?: boolean
    compressedTokens: number
    /**
     * Total tokens this block represents, including tokens from consumed
     * blocks. For tier 1 blocks: equals compressedTokens. For tier 2+:
     * compressedTokens + sum of consumed blocks' effectiveCompressedTokens.
     * Undefined on old state files — callers should fall back to compressedTokens.
     */
    effectiveCompressedTokens?: number
    summaryTokens: number
    durationMs: number
    mode?: CompressionMode
    tier?: CompressionTier
    topic: string
    batchTopic?: string
    startId: string
    endId: string
    anchorMessageId: string
    compressMessageId: string
    compressCallId?: string
    includedBlockIds: number[]
    consumedBlockIds: number[]
    parentBlockIds: number[]
    directMessageIds: string[]
    directToolIds: string[]
    effectiveMessageIds: string[]
    effectiveToolIds: string[]
    createdAt: number
    deactivatedAt?: number
    deactivatedByBlockId?: number
    summary: string
    survivedCount: number
    generation?: BlockGeneration
}

export interface PruneMessagesState {
    byMessageId: Map<string, PrunedMessageEntry>
    blocksById: Map<number, CompressionBlock>
    activeBlockIds: Set<number>
    activeByAnchorMessageId: Map<string, number>
    nextBlockId: number
    nextRunId: number
    markedForCleanup: Set<number>
    /** Transient: persisted memberships need one repair sync before fast-path reuse. */
    membershipsVerified: boolean

    /**
     * [Issue #384] Transient fields below are NEVER persisted — serialization
     * (serializePruneMessagesState / PersistedSessionState) lists fields
     * explicitly, so they survive only within one process lifetime.
     *
     * structureVersion: monotonically increasing counter bumped by every
     * block-structure/liveness mutation (applyCompressionState, merge, user
     * decompress). syncCompressionBlocks uses it to skip the full replay over
     * all historical blocks when nothing changed since the last sync.
     */
    structureVersion?: number
    /** structureVersion at which the last sync (full or incremental) ran. */
    lastSyncedStructureVersion?: number
    /**
     * Cached consumed-call indexes for hideConsumedCompressCalls. Depends only
     * on block liveness, so it is keyed by structureVersion.
     */
    hideConsumedIndex?: {
        version: number
        allBlockCallIds: Set<string>
        liveRangeKeysByCallId: Map<string, Set<string>>
        activeCallIds: Set<string>
    }
}

export interface Prune {
    messages: PruneMessagesState
}

export interface MessageIdState {
    byRawId: Map<string, string>
    byRef: Map<string, string>
    nextRef: number
}

export interface Nudges {
    contextLimitAnchors: Set<string>
    turnNudgeAnchors: Set<string>
    iterationNudgeAnchors: Set<string>
    lastPerMessageNudgeTurn: number
    lastPerMessageNudgeTokens: number | undefined
    lastNudgeShownTokens: number | undefined
    lastToolOutputNudgeTokens: number | undefined
    lastTier2NudgeTokens: number | undefined
    lastTier3NudgeTokens: number | undefined
    /** Set by injectCompressNudges; read by system prompt handler next turn (1-turn lag). Undefined = first turn. */
    shouldInjectThisTurn: boolean | undefined
    /**
     * Lock flag: prevents baseline leak after compress.
     *
     * When compress is detected in the current turn, the baseline is set to
     * currentTokens ONLY on the first transform (before continuation work
     * inflates it). Subsequent transforms in the same turn skip the update.
     * Reset to false when compress is NOT in the current turn.
     */
    compressBaselineSet: boolean
    /**
     * Tracks the message ID of the last processed compress call.
     *
     * Prevents the early-return in injectCompressNudges from firing repeatedly
     * for the SAME compress call. In autonomous sessions (single user message),
     * a compress stays in the turn forever — without this tracking, the nudge
     * system would NEVER evaluate again after the first compress.
     *
     * NOT persisted — transient by design. On restart it's undefined, causing
     * one extra early-return on the first call, then normal behavior resumes.
     */
    lastProcessedCompressMessageId: string | undefined
}

export interface SessionState {
    sessionId: string | null
    isSubAgent: boolean
    compressPermission: "ask" | "allow" | "deny" | undefined
    prune: Prune
    nudges: Nudges
    stats: SessionStats
    compressionTiming: CompressionTimingState
    toolParameters: Map<string, ToolParameterEntry>
    toolIdList: string[]
    messageIds: MessageIdState
    lastCompaction: number
    currentTurn: number
    modelContextLimit: number | undefined
    /** [FIX #312 follow-up] Identity of the model `modelContextLimit` was recorded for. Written together with the limit by the system hook; lets the messages hook detect a stale limit when the catalog misses. */
    modelProviderID: string | undefined
    modelID: string | undefined
    systemPromptTokens: number | undefined
    /**
     * Resolved directory for this session's persisted state file (absolute path).
     * Transient (NOT persisted): resolved once per session from config.storagePath
     * in ensureSessionInitialized. Undefined → default XDG location.
     */
    storageDir: string | undefined
    /**
     * Transient flag (NOT persisted): set to true when a compress call is rejected
     * by the pre-commit quality gate. The model must retry with `acknowledgeRisk: true`
     * to bypass quality on the retry. Consumed (reset to false) on use.
     *
     * Lifecycle:
     * - Quality fails → flag = true → rejection error returned
     * - Retry with acknowledgeRisk:true + flag=true → accepted, flag = false
     * - acknowledgeRisk:true + flag=false → IGNORED (no-op): quality runs
     *   normally, result carries an "acknowledgeRisk was ignored" note (#301)
     * - Normal call (no acknowledgeRisk) → quality runs normally
     */
    /**
     * Durable ids of ACP-authored synthetic output messages (compression
     * notices, /acp command output). They stay visible in the session
     * transcript but are stripped from the model-visible context by the V2
     * context hook.
     */
    hiddenMessageIds: Set<string>
    /**
     * Size of the latest model request as provider-reported usage
     * (input + output + reasoning + cache.read/cache.write). V2 AI messages
     * carry no `tokens` field, so this is the only source of real usage data
     * for nudge thresholds. Persisted so a restarted process keeps a baseline.
     *
     * `session.usage.updated` reports SESSION-CUMULATIVE totals (observed:
     * 180M+ tokens for a 1M-window session), so this field stores the delta
     * between consecutive events — the last request's prompt + response size.
     * See `lib/v2/usage.ts`.
     */
    lastUsedTokens?: number
    /**
     * Latest session-cumulative usage total from `session.usage.updated`,
     * kept as the baseline for computing `lastUsedTokens` deltas. Persisted so
     * the baseline survives process restarts.
     */
    lastCumulativeUsage?: number
    qualityGateRetryPending: boolean
    /**
     * Transient flag (NOT persisted): set to true after the "model reports no
     * context window" warning has been emitted for this session, so the
     * warning fires at most once per session per process.
     */
    noContextLimitWarned: boolean
}
