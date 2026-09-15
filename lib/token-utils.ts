import { SessionState, WithParts } from "./state"
import type { AcpMessageInfo } from "./state/types"
import { Logger } from "./logger"
import * as _anthropicTokenizer from "@anthropic-ai/tokenizer"
const anthropicCountTokens = (_anthropicTokenizer.countTokens ??
    (_anthropicTokenizer as any).default?.countTokens) as typeof _anthropicTokenizer.countTokens
import { getLastUserMessage } from "./messages/query"

/**
 * Absolute sanity ceiling for "current context size" values. Real context
 * windows are ≤ 10M tokens today; anything larger is a mis-mapped number
 * (e.g. session-cumulative usage) and must never drive nudge thresholds or
 * the budget guard.
 */
export const MAX_PLAUSIBLE_CONTEXT_TOKENS = 10_000_000

/**
 * True when `value` can plausibly be the size of the current context:
 * positive, under the absolute ceiling, and within the model's window when
 * that window is known.
 */
export function isPlausibleContextTokens(state: SessionState, value: number): boolean {
    if (!(value > 0)) return false
    if (value > MAX_PLAUSIBLE_CONTEXT_TOKENS) return false
    const limit = state.modelContextLimit
    if (typeof limit === "number" && limit > 0 && value > limit) return false
    return true
}

/**
 * Provider-reported size of the latest request, when it is plausible.
 * See `SessionState.lastUsedTokens` (delta of the session-cumulative V2
 * `session.usage.updated` totals).
 */
export function getProviderUsedTokens(state: SessionState): number | undefined {
    if (typeof state.lastUsedTokens !== "number") return undefined
    return isPlausibleContextTokens(state, state.lastUsedTokens) ? state.lastUsedTokens : undefined
}

export function getCurrentTokenUsage(state: SessionState, messages: WithParts[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role !== "assistant") {
            continue
        }

        const assistantInfo = msg.info as AcpMessageInfo
        const input = assistantInfo.tokens?.input || 0
        const output = assistantInfo.tokens?.output || 0
        const reasoning = assistantInfo.tokens?.reasoning || 0
        const cacheRead = assistantInfo.tokens?.cache?.read || 0
        const cacheWrite = assistantInfo.tokens?.cache?.write || 0

        // [FIX output=0 underestimation] Accept input-only token data (output=0
        // from aborted/hidden requests). input + cacheRead + cacheWrite still
        // represents the prompt size sent to the model. Previously required
        // output > 0, which skipped these and fell through to text-only
        // estimation → massive undercount → no nudge fired → context overflow.
        if (input <= 0 && output <= 0) {
            continue
        }

        if (
            state.lastCompaction > 0 &&
            (msg.info.time.created < state.lastCompaction ||
                (msg.info.summary === true && msg.info.time.created === state.lastCompaction))
        ) {
            return 0
        }

        // [FIX Bug 17] Universal token estimation
        // opencode session.ts: adjustedInputTokens = inputTokens - cacheRead - cacheWrite
        // So: input + cacheRead + cacheWrite = prompt_tokens (total input)
        // Total context usage = prompt_tokens + output + reasoning
        return input + cacheRead + cacheWrite + output + reasoning
    }

    // V2 native messages carry no `tokens` field. The latest
    // provider-reported usage (session.usage.updated) is the real prompt size
    // including system prompt and tool schemas — prefer it over estimation.
    // Implausible values (e.g. session-cumulative totals: 180M+ on a 1M
    // window) are rejected here so a mis-mapped event can never drive nudges.
    const providerUsed = getProviderUsedTokens(state)
    if (providerUsed !== undefined) {
        return providerUsed
    }

    // [FIX Bug 5] fallback: estimate from all content (text + tool outputs)
    // when no assistant message has token data (first turn or full compaction).
    // [FIX perf] chars/4 estimator instead of the BPE tokenizer, which costs
    // ~25ms/message and made a single large-history transform take tens of
    // seconds (observed: ~50s on a 449-message session).
    let estimated = 0
    for (const m of messages) {
        estimated += estimateAllMessageTokensFast(m)
    }
    return estimated
}

/**
 * Estimate system prompt tokens by subtracting the first user message's tokens
 * from the first assistant message's total input prompt tokens.
 *
 * The first assistant turn's prompt = system_prompt + first_user_message (+
 * any injected suffixes). By subtracting the first user message's token count
 * (via countTokens for CJK/code accuracy), we isolate the system prompt estimate.
 *
 * Uses the real Anthropic tokenizer (countTokens) — NOT length/4 — for
 * consistency with /acp context and cacheSystemPromptTokens.
 *
 * Returns 0 if no assistant message with token data is found.
 */
export function estimateSystemPromptTokens(messages: WithParts[]): number {
    let firstInput: number | undefined
    for (const msg of messages) {
        if (msg.info.role !== "assistant") continue
        const assistantInfo = msg.info as AcpMessageInfo
        const t = assistantInfo.tokens
        if (!t) continue
        const input = (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0)
        if (input > 0) {
            firstInput = input
            break
        }
    }
    if (firstInput === undefined) return 0

    let firstUserText = ""
    for (const msg of messages) {
        if (msg.info.role !== "user") continue
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type === "text" && typeof part.text === "string") {
                firstUserText += part.text
            }
        }
        if (firstUserText) break
    }
    return Math.max(0, firstInput - countTokens(firstUserText))
}

export function getCurrentParams(
    state: SessionState,
    messages: WithParts[],
    logger: Logger,
): {
    providerId: string | undefined
    modelId: string | undefined
    agent: string | undefined
    variant: string | undefined
} {
    const userMsg = getLastUserMessage(messages)
    if (!userMsg) {
        logger.debug("No user message found when determining current params")
        return {
            providerId: undefined,
            modelId: undefined,
            agent: undefined,
            variant: undefined,
        }
    }
    const userInfo = userMsg.info as AcpMessageInfo
    const agent: string | undefined = userInfo.agent
    const providerId: string | undefined = userInfo.model?.providerID
    const modelId: string | undefined = userInfo.model?.modelID
    const variant: string | undefined = userInfo.model?.variant

    return { providerId, modelId, agent, variant }
}

export function countTokens(text: string): number {
    if (!text) return 0
    try {
        return anthropicCountTokens(text)
    } catch {
        return Math.round(text.length / 4)
    }
}

export function estimateTokensBatch(texts: string[]): number {
    if (texts.length === 0) return 0
    return countTokens(texts.join(" "))
}

export const COMPACTED_TOOL_OUTPUT_PLACEHOLDER = "[Old tool result content cleared]"

function stringifyToolContent(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value)
}

export function extractCompletedToolOutput(part: any): string | undefined {
    if (
        part?.type !== "tool" ||
        part.state?.status !== "completed" ||
        part.state?.output === undefined
    ) {
        return undefined
    }

    if (part.state?.time?.compacted) {
        return COMPACTED_TOOL_OUTPUT_PLACEHOLDER
    }

    return stringifyToolContent(part.state.output)
}

export function extractToolContent(part: any): string[] {
    const contents: string[] = []

    if (part?.type !== "tool") {
        return contents
    }

    if (part.state?.input !== undefined) {
        contents.push(stringifyToolContent(part.state.input))
    }

    const completedOutput = extractCompletedToolOutput(part)
    if (completedOutput !== undefined) {
        contents.push(completedOutput)
    } else if (part.state?.status === "error" && part.state?.error) {
        contents.push(stringifyToolContent(part.state.error))
    }

    return contents
}

export function countToolTokens(part: any): number {
    const contents = extractToolContent(part)
    return estimateTokensBatch(contents)
}

export function getTotalToolTokens(state: SessionState, toolIds: string[]): number {
    let total = 0
    for (const id of toolIds) {
        const entry = state.toolParameters.get(id)
        total += entry?.tokenCount ?? 0
    }
    return total
}

export function countMessageTextTokens(msg: WithParts): number {
    const texts: string[] = []
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    for (const part of parts) {
        if (part.type === "text") {
            texts.push(part.text ?? "")
        }
    }
    if (texts.length === 0) return 0
    return estimateTokensBatch(texts)
}

export function countAllMessageTokens(msg: WithParts): number {
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    const texts: string[] = []
    for (const part of parts) {
        if (part.type === "text") {
            texts.push(part.text ?? "")
        } else {
            texts.push(...extractToolContent(part))
        }
    }
    if (texts.length === 0) return 0
    return estimateTokensBatch(texts)
}

export function countMessageCharacters(msg: WithParts): number {
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    let total = 0
    for (const part of parts) {
        if (part.type === "text" && typeof part.text === "string") {
            total += part.text.length
        } else {
            for (const content of extractToolContent(part)) {
                total += content.length
            }
        }
    }
    return total
}

/**
 * [Issue #384] Fast per-message token estimate using the chars/4 convention
 * already used across the codebase for token statistics (tool-cache.ts,
 * pipeline.ts, inject/utils.ts). The BPE-exact countAllMessageTokens costs
 * ~25ms/message on this runtime and dominated candidate planning on wide
 * draft ranges; these counters feed heuristic stats/gates, not billing.
 */
export function estimateAllMessageTokensFast(msg: WithParts): number {
    return Math.round(countMessageCharacters(msg) / 4)
}
