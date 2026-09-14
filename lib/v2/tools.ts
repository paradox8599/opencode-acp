/**
 * Registration helpers that turn ACP's `tool()` definitions into V2 tool
 * values (`ctx.tool.transform(editor => editor.add(...))`).
 */

import { z } from "zod"

import type { AcpTool } from "./tool"

export interface V2ToolProgressContext {
    sessionID: unknown
    messageID: unknown
    id: unknown
    agent?: unknown
    progress(update: Record<string, unknown>): Promise<void>
}

export interface V2ToolValue {
    name: string
    description: string
    input: z.ZodType
    options: { codemode: false }
    execute(input: unknown, context: V2ToolProgressContext): Promise<{ content: string }>
}

export function toV2Tool(name: string, definition: AcpTool): V2ToolValue {
    return {
        name,
        description: definition.description,
        // The host converts the zod schema to JSON Schema for the model and
        // validates provider input against it.
        input: z.object(definition.args),
        options: { codemode: false },
        async execute(rawInput: unknown, context: V2ToolProgressContext) {
            const input =
                rawInput && typeof rawInput === "object"
                    ? (rawInput as Record<string, unknown>)
                    : {}
            const acpContext = {
                sessionID: String(context.sessionID),
                messageID: String(context.messageID),
                callID: context.id === undefined ? "" : String(context.id),
                agent: context.agent === undefined ? undefined : String(context.agent),
                ask: async () => {},
                metadata: (update: { title: string }) => {
                    void context.progress({ title: update.title }).catch(() => {})
                },
            }
            const content = await definition.execute(input as never, acpContext)
            return { content }
        },
    }
}
