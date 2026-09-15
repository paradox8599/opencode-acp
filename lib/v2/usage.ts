/**
 * Provider-usage ingestion for the V2 `session.usage.updated` event.
 *
 * The event reports SESSION-CUMULATIVE usage (observed: 180M+ tokens for a
 * 1M-window session), while ACP's nudge thresholds need the size of the latest
 * request. `applyUsageTotals` keeps the cumulative total as a baseline and
 * stores the per-event delta in `state.lastUsedTokens`, rejecting deltas that
 * cannot be a real context size.
 */

import type { SessionState } from "../state"
import { isPlausibleContextTokens } from "../token-utils"

/** Shape of `data.tokens` on `session.usage.updated`. */
export interface V2UsageTokens {
    input?: unknown
    output?: unknown
    reasoning?: unknown
    cache?: { read?: unknown; write?: unknown }
}

function numberOrZero(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/** Sum the five provider counters (input + output + reasoning + cache). */
export function sumUsageTokens(tokens: V2UsageTokens): number {
    return (
        numberOrZero(tokens.input) +
        numberOrZero(tokens.output) +
        numberOrZero(tokens.reasoning) +
        numberOrZero(tokens.cache?.read) +
        numberOrZero(tokens.cache?.write)
    )
}

/**
 * Ingest a session-cumulative usage total.
 *
 * - First event / counter reset: only the baseline is stored (no delta yet).
 * - Otherwise: `delta = total - previous` is the size of the request that
 *   just finished; it is accepted only when it can plausibly be a context
 *   size (see `isPlausibleContextTokens`).
 *
 * Returns true when the total was valid and the caller should persist state.
 */
export function applyUsageTotals(state: SessionState, total: number): boolean {
    if (!Number.isFinite(total) || total <= 0) return false

    const previous = state.lastCumulativeUsage
    state.lastCumulativeUsage = total

    if (typeof previous !== "number" || previous <= 0 || total <= previous) {
        return true
    }

    const delta = total - previous
    if (isPlausibleContextTokens(state, delta)) {
        state.lastUsedTokens = delta
    }
    return true
}
