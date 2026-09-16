/**
 * OpenCode V2 `ctx.session.hook("context")` handler.
 *
 * Wraps ACP's existing message-transform pipeline with the V2 adapter:
 *   strip hidden synthetic output → system prompt → import → pipeline → export.
 *
 * V2 has no separate system-transform hook, so the ACP system prompt is
 * appended to `event.system` here, after the message pipeline has resolved
 * session state and model limits.
 */

import { compressPermission } from "../compress-permission"
import type { PluginConfig } from "../config"
import { createChatMessageTransformHandler } from "../hooks"
import type { HostPermissionSnapshot, PermissionRuleset } from "../host-permissions"
import type { Logger } from "../logger"
import { renderSystemPrompt, type PromptStore } from "../prompts"
import { countTokens } from "../token-utils"
import { buildProtectedToolsExtension } from "../prompts/extensions/system"
import type { SessionStateRegistry } from "../state"
import type { AcpClientFacade } from "./host"
import { importV2Messages } from "./ai-adapter"
import type { V2Message, V2SystemPart } from "./types"

export interface V2ContextEvent {
    sessionID: string
    agent: string
    model: { providerID: string; id: string; variant?: string }
    system: V2SystemPart[]
    messages: V2Message[]
    tools: Record<string, unknown>
}

export const ACP_TOOL_NAMES = [
    "compress",
    "decompress",
    "search_context",
    "acp_status",
    "acp_context_recap",
] as const

export interface ContextHandlerDeps {
    client: AcpClientFacade
    registry: SessionStateRegistry
    logger: Logger
    config: PluginConfig
    prompts: PromptStore
}

export function createV2ContextHandler(
    deps: ContextHandlerDeps,
): (event: V2ContextEvent) => Promise<void> {
    const { client, registry, logger, config, prompts } = deps
    const hostPermissions: HostPermissionSnapshot = { global: undefined, agents: {} }
    const permissionsChecked = new Set<string>()

    const transform = createChatMessageTransformHandler(
        client,
        registry,
        logger,
        config,
        prompts,
        hostPermissions,
    )

    return async (event: V2ContextEvent) => {
        try {
            await hydrateHostPermissions(event.sessionID)

            const imported = importV2Messages(event.messages, {
                sessionID: event.sessionID,
                agent: event.agent,
                model: {
                    providerID: event.model.providerID,
                    modelID: event.model.id,
                    variant: event.model.variant,
                },
            })

            // Resolve session state before stripping: hidden output ids are
            // loaded from the persisted state file, which may happen on this
            // very call (fresh process after a `/acp` command wrote output).
            const state = await registry.getOrCreate(
                client,
                event.sessionID,
                imported.messages,
                config,
            )
            stripHiddenMessages(event.sessionID, imported.messages)

            // V1 derived the system-prompt size by subtracting the first user
            // message from the first assistant's reported input tokens. V2
            // messages carry no tokens, so estimate the request's fixed part
            // directly from the system parts and tool schemas. Stable for the
            // session (both are constant), which is what nudge breakdowns and
            // the budget guard need.
            if (state.systemPromptTokens === undefined || state.systemPromptTokens <= 0) {
                const systemText = event.system
                    .map((part) => (typeof part.text === "string" ? part.text : ""))
                    .join("\n")
                let toolsJson = ""
                try {
                    toolsJson = JSON.stringify(event.tools)
                } catch {
                    toolsJson = ""
                }
                state.systemPromptTokens =
                    countTokens(systemText) + Math.round(toolsJson.length / 4)
            }

            await transform({}, { messages: imported.messages })

            const postState = registry.get(event.sessionID)
            if (postState?.isSubAgent && !config.allowSubAgents) {
                for (const name of ACP_TOOL_NAMES) delete event.tools[name]
            }

            injectSystemPrompt(event)

            // Replace the message list on the event instead of mutating the array in place:
            // the caller keeps its own (untagged) messages, so the injected refs never leak
            // into the session store when the harness persists the request it sent.
            event.messages = imported.exportV2Messages()
        } catch (error) {
            logger.warn("ACP V2 context transform failed; passing context through", {
                sessionId: event.sessionID,
                error: error instanceof Error ? error.message : String(error),
            })
        }
    }

    async function hydrateHostPermissions(sessionID: string): Promise<void> {
        if (permissionsChecked.has(sessionID)) return
        permissionsChecked.add(sessionID)
        try {
            const result = (await client.session.get({ path: { id: sessionID } })) as {
                data?: { permissions?: PermissionRuleset }
            }
            hostPermissions.global = result?.data?.permissions
        } catch {
            hostPermissions.global = undefined
        }
    }

    function stripHiddenMessages(
        sessionID: string,
        messages: import("../state").WithParts[],
    ): void {
        const state = registry.get(sessionID)
        if (!state || state.hiddenMessageIds.size === 0 || messages.length === 0) return
        const kept = messages.filter(
            (message) => message.info.id === "" || !state.hiddenMessageIds.has(message.info.id),
        )
        if (kept.length !== messages.length) {
            messages.splice(0, messages.length, ...kept)
        }
    }

    function injectSystemPrompt(event: V2ContextEvent): void {
        const state = registry.get(event.sessionID)
        if (!state || (state.isSubAgent && !config.allowSubAgents)) return
        if (compressPermission(state, config) === "deny") return

        prompts.reload()
        const newPrompt = renderSystemPrompt(
            prompts.getRuntimePrompts(),
            buildProtectedToolsExtension(config.compress.protectedTools),
            state.isSubAgent && config.allowSubAgents,
        )
        event.system.push({ type: "text", text: newPrompt })
    }
}
