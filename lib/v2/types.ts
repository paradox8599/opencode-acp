/**
 * Structural types for the OpenCode V2 model-visible message shapes.
 *
 * These mirror the subset of `@opencode/ai` (`Message`, `ContentPart`,
 * `SystemPart`) and `@opencode/schema/session-message` that ACP touches. They
 * are declared locally so the plugin does not import transitive packages, and
 * kept permissive so unknown/future fields survive the adapter round trip.
 */

export type V2Role = "system" | "user" | "assistant" | "tool"

export interface V2TextPart {
    type: "text"
    text: string
    cache?: unknown
    metadata?: Record<string, unknown>
    providerMetadata?: Record<string, unknown>
    [key: string]: unknown
}

export interface V2ReasoningPart {
    type: "reasoning"
    text: string
    encrypted?: string
    cache?: unknown
    metadata?: Record<string, unknown>
    providerMetadata?: Record<string, unknown>
    [key: string]: unknown
}

export interface V2ToolCallPart {
    type: "tool-call"
    id: string
    name: string
    namespace?: string
    input: unknown
    providerExecuted?: boolean
    cache?: unknown
    metadata?: Record<string, unknown>
    providerMetadata?: Record<string, unknown>
    [key: string]: unknown
}

export interface V2ToolResultValue {
    type: "text" | "error" | "json" | "content"
    value: unknown
}

export interface V2ToolResultPart {
    type: "tool-result"
    id: string
    name: string
    namespace?: string
    result?: V2ToolResultValue
    providerExecuted?: boolean
    cache?: unknown
    metadata?: Record<string, unknown>
    providerMetadata?: Record<string, unknown>
    [key: string]: unknown
}

export interface V2OtherPart {
    type: string
    [key: string]: unknown
}

export type V2ContentPart =
    | V2TextPart
    | V2ReasoningPart
    | V2ToolCallPart
    | V2ToolResultPart
    | V2OtherPart

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export interface V2Message {
    id?: string
    role: V2Role
    content: ReadonlyArray<V2ContentPart>
    metadata?: Record<string, unknown>
    providerMetadata?: Record<string, unknown>
    native?: Record<string, unknown>
    [key: string]: unknown
}

export interface V2SystemPart {
    type: "text"
    text: string
    cache?: unknown
    metadata?: Record<string, unknown>
    [key: string]: unknown
}

/** Subset of `SessionMessage.Info` (durable session transcript). */
export interface V2SessionMessage {
    id: string
    type: string
    time?: { created?: unknown; completed?: unknown }
    metadata?: Record<string, unknown>
    [key: string]: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null

export const isTextPart = (part: V2ContentPart): part is V2TextPart =>
    part.type === "text" && typeof (part as { text?: unknown }).text === "string"

export const isReasoningPart = (part: V2ContentPart): part is V2ReasoningPart =>
    part.type === "reasoning" && typeof (part as { text?: unknown }).text === "string"

export const isToolCallPart = (part: V2ContentPart): part is V2ToolCallPart =>
    part.type === "tool-call" && typeof (part as { id?: unknown }).id === "string"

export const isToolResultPart = (part: V2ContentPart): part is V2ToolResultPart =>
    part.type === "tool-result" && typeof (part as { id?: unknown }).id === "string"

/** Join the textual payload of a tool result value into the string ACP stores. */
export function toolResultText(result: V2ToolResultValue | undefined): string {
    if (!result) return ""
    switch (result.type) {
        case "text":
            return typeof result.value === "string" ? result.value : stringify(result.value)
        case "content": {
            const value = Array.isArray(result.value) ? result.value : []
            return value
                .filter((item): item is { type: "text"; text: string } =>
                    isRecord(item) && item.type === "text" && typeof item.text === "string",
                )
                .map((item) => item.text)
                .join("\n")
        }
        case "error": {
            if (typeof result.value === "string") return result.value
            if (isRecord(result.value) && typeof result.value.message === "string")
                return result.value.message
            return stringify(result.value)
        }
        case "json":
        default:
            return typeof result.value === "string" ? result.value : stringify(result.value)
    }
}

export function stringify(value: unknown): string {
    if (typeof value === "string") return value
    if (value === undefined) return ""
    try {
        return JSON.stringify(value) ?? String(value)
    } catch {
        return String(value)
    }
}

/** Millisecond timestamp from either a number or an Effect DateTime-like value. */
export function toMillis(value: unknown, fallback: number): number {
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (isRecord(value)) {
        const epoch = value.epochMilliseconds
        if (typeof epoch === "number" && Number.isFinite(epoch)) return epoch
        const millis = value.millis
        if (typeof millis === "number" && Number.isFinite(millis)) return millis
    }
    return fallback
}
