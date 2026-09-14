/**
 * Bidirectional adapter between OpenCode V2 model-visible messages
 * (`@opencode/ai` `Message`) and ACP's internal `WithParts` model.
 *
 * Import folds `role: "tool"` result messages into the assistant message that
 * carries the matching `tool-call` part, because ACP's pipeline, ref assignment
 * and compression ranges all operate per durable session message. Export
 * rebuilds the outbound array from the mutated internal array, restoring tool
 * result messages and synthetic (ACP-only) messages at their positions.
 *
 * Identity rules:
 * - a message keeps its durable `id` when the source had one;
 * - system messages and orphan tool results keep id `""` so they are never
 *   assigned a message ref or compressed;
 * - every source part is tracked so untouched payloads round-trip verbatim.
 */

import type { AcpPart, AcpToolState, WithParts } from "../state/types"
import {
    isReasoningPart,
    isTextPart,
    isToolCallPart,
    isToolResultPart,
    stringify,
    toMillis,
    toolResultText,
    type V2ContentPart,
    type V2Message,
    type V2ToolResultPart,
    type V2ToolResultValue,
} from "./types"

export interface V2ImportContext {
    sessionID: string
    agent?: string
    model?: { providerID?: string; modelID?: string; variant?: string }
}

export interface ImportedV2Messages {
    messages: WithParts[]
    exportV2Messages(current?: WithParts[]): V2Message[]
}

interface MessageMeta {
    role: V2Message["role"]
    source?: V2Message
}

interface PartMeta {
    source?: V2ContentPart
    inlineResult?: V2ToolResultPart
    resultMessage?: V2Message
    originalResultText?: string
    originalResultValue?: V2ToolResultValue
    originalInput?: unknown
    originalOutput?: string
    announced?: boolean
}

const CHECKPOINT_MARKER = "<conversation-checkpoint>"

export function importV2Messages(
    input: readonly V2Message[],
    context: V2ImportContext,
): ImportedV2Messages {
    const messageMeta = new WeakMap<WithParts, MessageMeta>()
    const partMeta = new WeakMap<AcpPart, PartMeta>()
    const callsById = new Map<string, AcpPart>()
    const messages: WithParts[] = []
    // Messages ACP must not touch: instruction system messages and id-less
    // provider-native content. They are held aside and re-emitted at their
    // chronological anchor during export.
    const passThrough: Array<{ message: V2Message; afterId: string | null }> = []
    let lastImportedId: string | null = null

    const now = Date.now()

    for (const message of input) {
        if (message.role === "tool") {
            let folded = false
            for (const part of message.content) {
                if (!isToolResultPart(part)) continue
                const call = callsById.get(part.id)
                if (!call) continue
                const meta = partMeta.get(call) ?? {}
                meta.resultMessage = message
                meta.originalResultText = toolResultText(part.result)
                meta.originalResultValue = part.result
                partMeta.set(call, meta)
                call.state = completedState(call.state ?? { status: "pending", input: undefined }, part.result)
                folded = true
            }
            if (!folded) passThrough.push({ message, afterId: lastImportedId })
            continue
        }

        if (message.role === "system" || typeof message.id !== "string" || message.id === "") {
            passThrough.push({ message, afterId: lastImportedId })
            continue
        }

        const internal = buildInternalMessage(message, context, now)
        messageMeta.set(internal, { role: message.role, source: message })
        lastImportedId = message.id
        for (let index = 0; index < message.content.length; index++) {
            const part = message.content[index]!
            if (isToolResultPart(part)) {
                const call = callsById.get(part.id)
                if (call) {
                    // Provider-executed tools keep call + result inline.
                    const meta = partMeta.get(call) ?? {}
                    meta.inlineResult = part
                    meta.originalResultText = toolResultText(part.result)
                    meta.originalResultValue = part.result
                    partMeta.set(call, meta)
                    call.state = completedState(call.state ?? { status: "pending", input: undefined }, part.result)
                }
                continue
            }

            const internalPart = buildInternalPart(part, message, context)
            if (!internalPart) continue
            if (isToolCallPart(part) && typeof part.id === "string") {
                callsById.set(part.id, internalPart)
                partMeta.set(internalPart, {
                    source: part,
                    originalInput: part.input,
                })
            } else {
                partMeta.set(internalPart, { source: part })
            }
            if (part.type === "tool-call") {
                // Keep the step-start marker convention the pipeline relies on
                // for turn counting: one marker at the head of each assistant
                // message (prune strips them from the outbound request).
            }
            internal.parts.push(internalPart)
        }

        messages.push(internal)
    }

    const exportV2Messages = (current: WithParts[] = messages): V2Message[] => {
        const output: V2Message[] = []
        const pending = passThrough.slice()
        const flush = (afterId: string | null) => {
            let index = 0
            while (index < pending.length) {
                const entry = pending[index]!
                if (entry.afterId === afterId) {
                    output.push(entry.message)
                    pending.splice(index, 1)
                    continue
                }
                index += 1
            }
        }
        flush(null)
        for (const message of current) {
            const meta = messageMeta.get(message)
            if (!meta) {
                const synthetic = buildSyntheticMessage(message)
                if (synthetic) output.push(synthetic)
                continue
            }
            if (meta.role === "tool") {
                output.push(rebuildToolMessage(message, meta.source))
            } else if (meta.role === "assistant") {
                output.push(...rebuildAssistantMessage(message, meta.source, partMeta, context))
            } else {
                output.push(rebuildPlainMessage(message, meta.source, partMeta))
            }
            if (meta.source && typeof meta.source.id === "string") flush(meta.source.id)
        }
        for (const entry of pending) output.push(entry.message)
        return output
    }

    return { messages, exportV2Messages }
}

function buildInternalMessage(
    message: V2Message,
    context: V2ImportContext,
    now: number,
): WithParts {
    const id = typeof message.id === "string" ? message.id : ""
    const isCheckpoint =
        message.role === "user" &&
        message.content.some(
            (part) => isTextPart(part) && part.text.includes(CHECKPOINT_MARKER),
        )
    // OpenCode's compaction checkpoint replaces earlier history. Mirror the V1
    // assistant-summary shape so the pipeline's compaction bookkeeping works.
    const role: WithParts["info"]["role"] = isCheckpoint
        ? "assistant"
        : message.role === "tool"
          ? "user"
          : message.role
    const info: WithParts["info"] = {
        id,
        sessionID: context.sessionID,
        role,
        time: { created: toMillis((message as { time?: unknown }).time, now) },
        agent: context.agent,
        model: context.model
            ? {
                  providerID: context.model.providerID,
                  modelID: context.model.modelID,
                  variant: context.model.variant,
              }
            : undefined,
    }
    if (isCheckpoint) {
        info.summary = true
    }
    if (message.metadata !== undefined) info.metadata = message.metadata

    const parts: AcpPart[] = []
    if (message.role === "assistant") {
        // Synthetic step marker: V1 counted turns from step-start parts and the
        // existing nudge/GC logic depends on that count.
        parts.push({ type: "step-start" })
    }
    return { info, parts }
}

function buildInternalPart(
    part: V2ContentPart,
    message: V2Message,
    context: V2ImportContext,
): AcpPart | null {
    if (isTextPart(part)) {
        const internal: AcpPart = { type: "text", text: part.text }
        if (part.cache !== undefined) internal.cache = part.cache
        if (part.providerMetadata !== undefined) internal.providerMetadata = part.providerMetadata
        if (part.metadata !== undefined) internal.metadata = part.metadata
        return internal
    }
    if (isReasoningPart(part)) {
        const internal: AcpPart = { type: "reasoning", text: part.text }
        if (part.encrypted !== undefined) internal.encrypted = part.encrypted
        if (part.cache !== undefined) internal.cache = part.cache
        if (part.providerMetadata !== undefined) internal.providerMetadata = part.providerMetadata
        if (part.metadata !== undefined) internal.metadata = part.metadata
        return internal
    }
    if (isToolCallPart(part)) {
        const internal: AcpPart = {
            type: "tool",
            tool: part.name,
            callID: part.id,
            messageID: typeof message.id === "string" ? message.id : undefined,
            state: { status: "pending", input: part.input },
        }
        if (part.namespace !== undefined) internal.namespace = part.namespace
        if (part.providerExecuted !== undefined) internal.providerExecuted = part.providerExecuted
        if (part.cache !== undefined) internal.cache = part.cache
        if (part.providerMetadata !== undefined) internal.providerMetadata = part.providerMetadata
        if (part.metadata !== undefined) internal.metadata = part.metadata
        return internal
    }
    // Media, compaction windows, and any future content type pass through with
    // a permissive internal part; export reuses the source object.
    const internal: AcpPart = { type: part.type }
    if (part.cache !== undefined) internal.cache = part.cache
    if (part.providerMetadata !== undefined) internal.providerMetadata = part.providerMetadata
    if (part.metadata !== undefined)
        internal.metadata = part.metadata as Record<string, unknown>
    for (const [key, value] of Object.entries(part)) {
        if (key === "type" || key in internal) continue
        internal[key] = value
    }
    return internal
}

function completedState(state: AcpToolState, result: V2ToolResultValue | undefined): AcpToolState {
    const text = toolResultText(result)
    if (result?.type === "error") {
        return { ...state, status: "error", output: text, error: text }
    }
    return { ...state, status: "completed", output: text }
}

function rebuildPlainMessage(
    message: WithParts,
    source: V2Message | undefined,
    partMeta: WeakMap<AcpPart, PartMeta>,
): V2Message {
    const content = message.parts
        .map((part) => rebuildTextualPart(part, partMeta))
        .filter((part): part is V2ContentPart => part !== null)
    const base: V2Message = source
        ? { ...source, content }
        : {
              role: message.info.role === "assistant" ? "assistant" : "user",
              content,
          }
    if (message.info.summary === true && source) base.role = source.role
    return base
}

function rebuildAssistantMessage(
    message: WithParts,
    source: V2Message | undefined,
    partMeta: WeakMap<AcpPart, PartMeta>,
    context: V2ImportContext,
): V2Message[] {
    const content: V2ContentPart[] = []
    const toolMessages: V2Message[] = []

    for (const part of message.parts) {
        if (part.type === "tool") {
            const meta = partMeta.get(part) ?? {}
            content.push(rebuildCallPart(part, meta))
            if (meta.inlineResult) {
                content.push(rebuildResultPart(meta.inlineResult, part, meta))
            } else if (part.state?.status === "completed" || part.state?.status === "error") {
                toolMessages.push(rebuildResultMessage(part, meta))
            }
            continue
        }
        const rebuilt = rebuildTextualPart(part, partMeta)
        if (rebuilt) content.push(rebuilt)
    }

    const output: V2Message[] = []
    if (content.length > 0) {
        const base: V2Message = source
            ? { ...source, content }
            : { role: "assistant", content }
        output.push(base)
    }
    output.push(...toolMessages)
    return output
}

function rebuildTextualPart(
    part: AcpPart,
    partMeta: WeakMap<AcpPart, PartMeta>,
): V2ContentPart | null {
    const meta = partMeta.get(part)
    const source = meta?.source
    if (part.type === "text") {
        const base = source && source.type === "text" ? { ...source } : undefined
        const rebuilt: Record<string, unknown> = base ?? { type: "text" }
        rebuilt.type = "text"
        rebuilt.text = part.text ?? ""
        applyCarriedFields(rebuilt, part)
        return rebuilt as V2ContentPart
    }
    if (part.type === "reasoning") {
        const base = source && source.type === "reasoning" ? { ...source } : undefined
        const rebuilt: Record<string, unknown> = base ?? { type: "reasoning" }
        rebuilt.type = "reasoning"
        rebuilt.text = part.text ?? ""
        if (part.encrypted !== undefined) rebuilt.encrypted = part.encrypted
        applyCarriedFields(rebuilt, part)
        return rebuilt as V2ContentPart
    }
    if (part.type === "step-start" || part.type === "step-finish") {
        return null
    }
    if (source && source.type !== "tool-call" && source.type !== "tool-result") {
        return source
    }
    const rebuilt: Record<string, unknown> = { type: part.type }
    for (const [key, value] of Object.entries(part)) {
        if (key === "type" || key in RESERVED_INTERNAL_KEYS) continue
        rebuilt[key] = value
    }
    return rebuilt as V2ContentPart
}

function rebuildCallPart(part: AcpPart, meta: PartMeta): V2ContentPart {
    const source = meta.source
    const rebuilt: Record<string, unknown> =
        source && source.type === "tool-call" ? { ...source } : { type: "tool-call" }
    rebuilt.type = "tool-call"
    rebuilt.id = part.callID ?? ""
    rebuilt.name = part.tool ?? ""
    rebuilt.input = part.state?.input
    if (part.namespace !== undefined) rebuilt.namespace = part.namespace
    if (part.providerExecuted !== undefined) rebuilt.providerExecuted = part.providerExecuted
    applyCarriedFields(rebuilt, part)
    return rebuilt as V2ContentPart
}

function rebuildResultPart(
    original: V2ToolResultPart,
    part: AcpPart,
    meta: PartMeta,
): V2ContentPart {
    const output = part.state?.output
    if (output === meta.originalResultText && meta.originalResultValue !== undefined) {
        return original
    }
    const rebuilt: Record<string, unknown> = { ...original }
    rebuilt.type = "tool-result"
    rebuilt.id = part.callID ?? original.id
    rebuilt.name = part.tool ?? original.name
    rebuilt.result =
        part.state?.status === "error"
            ? { type: "error" as const, value: output ?? "" }
            : { type: "text" as const, value: output ?? "" }
    applyCarriedFields(rebuilt, part)
    return rebuilt as V2ContentPart
}

function rebuildResultMessage(part: AcpPart, meta: PartMeta): V2Message {
    const source = meta.resultMessage
    const callID = part.callID ?? ""
    const name = part.tool ?? ""
    const output = part.state?.output ?? ""
    const unchanged = source !== undefined && output === meta.originalResultText

    if (unchanged && source) {
        return {
            ...source,
            content: source.content.map((contentPart) =>
                isToolResultPart(contentPart)
                    ? rebuildResultPart(contentPart, part, meta)
                    : contentPart,
            ),
        }
    }

    const error = part.state?.status === "error"
    const result: V2ToolResultValue = error
        ? { type: "error", value: output }
        : { type: "text", value: output }
    const contentPart: V2ToolResultPart = {
        type: "tool-result",
        id: callID,
        name,
        result,
    }
    if (typeof part.providerExecuted === "boolean")
        contentPart.providerExecuted = part.providerExecuted
    if (source) {
        return {
            ...source,
            content: [contentPart],
        }
    }
    return { role: "tool", content: [contentPart] }
}

function rebuildToolMessage(message: WithParts, source: V2Message | undefined): V2Message {
    const content = message.parts
        .filter((part): part is AcpPart => part.type === "tool")
        .map((part): V2ContentPart => {
            const error = part.state?.status === "error"
            const result: V2ToolResultValue = error
                ? { type: "error", value: part.state?.output ?? "" }
                : { type: "text", value: part.state?.output ?? "" }
            const rebuilt: V2ToolResultPart = {
                type: "tool-result",
                id: part.callID ?? "",
                name: part.tool ?? "",
                result,
            }
            if (typeof part.providerExecuted === "boolean")
                rebuilt.providerExecuted = part.providerExecuted
            if (typeof part.namespace === "string") rebuilt.namespace = part.namespace
            return rebuilt
        })
    return source ? { ...source, content } : { role: "tool", content }
}

function buildSyntheticMessage(message: WithParts): V2Message | null {
    const content: V2ContentPart[] = []
    for (const part of message.parts) {
        if (part.type === "text") {
            content.push({ type: "text", text: part.text ?? "" })
        } else if (part.type === "reasoning") {
            content.push({ type: "reasoning", text: part.text ?? "" })
        }
    }
    if (content.length === 0) return null
    const role = message.info.role === "assistant" ? "assistant" : "user"
    return { role, content }
}

const RESERVED_INTERNAL_KEYS = new Set([
    "type",
    "text",
    "tool",
    "callID",
    "id",
    "sessionID",
    "messageID",
    "state",
    "metadata",
    "synthetic",
    "ignored",
    "reason",
    "cache",
    "providerMetadata",
    "providerExecuted",
    "namespace",
    "encrypted",
])

function applyCarriedFields(target: Record<string, unknown>, part: AcpPart): void {
    if (part.cache !== undefined) target.cache = part.cache
    if (part.providerMetadata !== undefined) target.providerMetadata = part.providerMetadata
    if (part.metadata !== undefined) target.metadata = part.metadata
}

export { stringify }
