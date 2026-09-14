/**
 * V2 host facade.
 *
 * The ACP pipeline was written against a duck-typed OpenCode client
 * (`client.session.messages/get/prompt`, `client.config.providers`,
 * `client.tui.showToast`). This module implements that surface from the V2
 * plugin context so the existing call sites keep working unchanged.
 *
 * Notices and command output become durable V2 synthetic messages
 * (`resume: false`) so they are visible in the session without waking the
 * model; their ids are registered as hidden and stripped from the outbound
 * context by the V2 hook handler.
 */

import type { Logger } from "../logger"
import { filterMessages } from "../messages/shape"
import type { WithParts } from "../state/types"
import { sessionMessagesToInternal } from "./session-adapter"
import type { JsonValue, V2SessionMessage } from "./types"

export interface V2HostContext {
    session: {
        context(input: { sessionID: string }): Promise<readonly unknown[]>
        get(input: { sessionID: string }): Promise<unknown>
        synthetic(input: {
            sessionID: string
            text: string
            resume?: boolean
            metadata?: Record<string, JsonValue>
        }): Promise<unknown>
    }
    catalog: {
        model: { list(): Promise<unknown> }
    }
}

export interface AcpClientFacade {
    session: {
        messages(input: { path: { id: string } }): Promise<{ data: WithParts[] }>
        get(input: { path: { id: string } }): Promise<{ data: unknown }>
        prompt(input: { path: { id: string }; body: Record<string, unknown> }): Promise<void>
    }
    config: {
        providers(): Promise<{
            data: {
                providers: Array<{
                    id: string
                    models: Record<string, { limit?: { context?: number } }>
                }>
            }
        }>
    }
    tui: {
        showToast(input: {
            body: { title?: string; message?: string; variant?: string; duration?: number }
        }): Promise<void>
    }
}

export interface AcpHost {
    client: AcpClientFacade
    /** Write a durable, model-invisible notice into the session transcript. */
    notify(sessionID: string, text: string): Promise<void>
}

export function createAcpHost(
    ctx: V2HostContext,
    logger: Logger,
    onHiddenMessage: (sessionID: string, messageID: string) => void,
    isHiddenMessage?: (sessionID: string, messageID: string) => boolean,
): AcpHost {
    const sendSynthetic = async (
        sessionID: string,
        text: string,
        kind: "notice" | "command-output",
    ): Promise<void> => {
        if (!sessionID || text.trim() === "") return
        try {
            const result = await ctx.session.synthetic({
                sessionID,
                text,
                resume: false,
                metadata: { acp: { kind } },
            })
            const id = extractMessageId(result)
            if (id) onHiddenMessage(sessionID, id)
        } catch (error) {
            logger.warn("Failed to write ACP session notice", {
                sessionId: sessionID,
                error: error instanceof Error ? error.message : String(error),
            })
        }
    }

    const client: AcpClientFacade = {
        session: {
            async messages(input) {
                const sessionID = input.path.id
                const messages = await ctx.session.context({ sessionID })
                const internal = sessionMessagesToInternal(
                    messages as readonly V2SessionMessage[],
                    sessionID,
                ).filter(
                    (message) =>
                        !(
                            isHiddenMessage?.(sessionID, message.info.id) === true &&
                            message.info.id !== ""
                        ),
                )
                return { data: filterMessages(internal) }
            },
            async get(input) {
                const data = await ctx.session.get({ sessionID: input.path.id })
                return { data }
            },
            async prompt(input) {
                const body = input.body ?? {}
                const parts = Array.isArray(body.parts) ? body.parts : []
                const texts = parts
                    .map((part) => {
                        const record = part as { type?: string; text?: unknown }
                        return record?.type === "text" && typeof record.text === "string"
                            ? record.text
                            : ""
                    })
                    .filter((text) => text !== "")
                if (texts.length > 0) {
                    await sendSynthetic(input.path.id, texts.join("\n"), "command-output")
                }
            },
        },
        config: {
            async providers() {
                return { data: { providers: await buildProvidersPayload(ctx) } }
            },
        },
        tui: {
            async showToast(input) {
                logger.info(`[ACP] ${input.body?.title ?? "Notice"}: ${input.body?.message ?? ""}`)
            },
        },
    }

    return {
        client,
        notify: (sessionID, text) => sendSynthetic(sessionID, text, "notice"),
    }
}

function extractMessageId(result: unknown): string | undefined {
    if (!result || typeof result !== "object") return undefined
    const direct = (result as { id?: unknown }).id
    if (typeof direct === "string" && direct !== "") return direct
    const nested = (result as { data?: { id?: unknown } }).data?.id
    return typeof nested === "string" && nested !== "" ? nested : undefined
}

async function buildProvidersPayload(ctx: V2HostContext) {
    const payload = await ctx.catalog.model.list()
    const models = Array.isArray(payload)
        ? payload
        : Array.isArray((payload as { data?: unknown })?.data)
          ? ((payload as { data: unknown[] }).data ?? [])
          : []
    const byProvider = new Map<string, Record<string, { limit?: { context?: number } }>>()
    for (const model of models) {
        if (!model || typeof model !== "object") continue
        const record = model as {
            providerID?: unknown
            id?: unknown
            limit?: { context?: unknown }
        }
        if (typeof record.providerID !== "string" || typeof record.id !== "string") continue
        let provider = byProvider.get(record.providerID)
        if (!provider) {
            provider = {}
            byProvider.set(record.providerID, provider)
        }
        const context =
            record.limit && typeof record.limit.context === "number"
                ? record.limit.context
                : undefined
        provider[record.id] = context === undefined ? {} : { limit: { context } }
    }
    return Array.from(byProvider, ([id, models]) => ({ id, models }))
}
