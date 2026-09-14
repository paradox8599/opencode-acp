/**
 * ACP's tool definition helper for the V2 plugin API.
 *
 * Keeps the ergonomic `tool({ description, args, execute })` shape the ACP
 * tool factories were written with, while exposing the raw zod args shape so
 * registration can hand V2 a JSON-Schema input and a structured result.
 */

import { z } from "zod"

export interface AcpToolAskInput {
    permission: string
    patterns: string[]
    always: string[]
    metadata: Record<string, unknown>
}

/** Subset of the V2 tool context the ACP tools consume. */
export interface AcpToolContext {
    sessionID: string
    messageID: string
    callID: string
    agent?: string
    /**
     * V2 has no mid-execution permission prompt. Accepted for signature
     * compatibility; the entry point never registers `ask`-mode tools.
     */
    ask(input: AcpToolAskInput): Promise<void>
    /** Progress/title update shown by the host while the tool runs. */
    metadata(input: { title: string }): void
}

export interface AcpTool<P extends z.ZodRawShape = z.ZodRawShape> {
    description: string
    args: P
    execute(args: z.infer<z.ZodObject<P>>, context: AcpToolContext): Promise<string>
}

export function tool<P extends z.ZodRawShape>(input: AcpTool<P>): AcpTool<P> {
    return input
}

tool.schema = z

export type AcpToolResult = string
