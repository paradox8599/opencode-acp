import type { SessionState, WithParts } from "./state"
import type { Logger } from "./logger"
import type { PluginConfig } from "./config"
import { assignMessageRefs } from "./message-ids"
import {
    buildPriorityMap,
    buildToolIdList,
    computeInputBudget,
    dropCompressReasoning,
    dropEmptyMessages,
    injectCompressNudges,
    injectMessageIds,
    prune,
    stripHallucinations,
    stripHallucinationsFromString,
    stripStaleMetadata,
    syncCompressionBlocks,
} from "./messages"
import { applyCompressOverrides } from "./messages/inject/utils"
import type { PromptStore } from "./prompts"
import { DEFAULT_COMPRESS_REASONING } from "./config"
import { filterMessages, filterMessagesInPlace } from "./messages/shape"
import { getLastUserMessage, isSyntheticMessage } from "./messages/query"
import { OUTPUT_RESERVE_TOKENS, truncateLargeToolOutputs } from "./messages/truncate-tools"
import { resolveEffectiveContextLimit } from "./state/utils"
import { enforceContextBudget } from "./messages/enforce-budget"
import { handleContextCommand, handleStatsCommand } from "./commands"
import { handleExportCommand } from "./commands/export"
import { sendIgnoredMessage } from "./ui/notification"
import { type HostPermissionSnapshot } from "./host-permissions"
import { compressPermission, syncCompressPermissionState } from "./compress-permission"
import { hideConsumedCompressCalls } from "./compress/hide-consumed"
import { hideFailedCompressCalls } from "./compress/hide-failed"
import { applyMessageFilters } from "./messages/filter/apply"
import { ensureBuiltinFiltersRegistered } from "./messages/filter/builtin"
import {
    createSessionState,
    saveSessionState,
    syncToolCache,
    updatePerTurnState,
    type SessionStateRegistry,
} from "./state"
import { cacheSystemPromptTokens } from "./ui/utils"
import { runBatchCleanup } from "./gc/merge"
import { getCurrentTokenUsage } from "./token-utils"

const INTERNAL_AGENT_SIGNATURES = [
    "You are a title generator",
    "You are a helpful AI assistant tasked with summarizing conversations",
    "You are an anchored context summarization assistant for coding sessions",
    "Summarize what was done in this conversation",
]

// [FIX Bug 37] OpenCode built-in hidden primary-mode agents that must NOT be
// run through the message-transform pipeline. These small internal LLM
// requests (title/summary/compaction generation) carry the agent name on the
// user message's `info.agent` field. Mutating them corrupts the request and
// shared session state (e.g. countTurns runs on the wrong message set).
// Keep in sync with INTERNAL_AGENT_SIGNATURES (system-prompt layer) and the
// agent IDs defined in OpenCode's packages/core/src/plugin/agent.ts.
const INTERNAL_AGENT_NAMES = new Set(["title", "summary", "compaction"])

function isInternalAgentRequest(messages: WithParts[]): boolean {
    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) {
        return false
    }
    const agent = (lastUserMessage.info as { agent?: unknown }).agent
    return typeof agent === "string" && INTERNAL_AGENT_NAMES.has(agent)
}

export function createChatMessageTransformHandler(
    client: any,
    registry: SessionStateRegistry,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
    hostPermissions: HostPermissionSnapshot,
) {
    return async (input: {}, output: { messages: WithParts[] }) => {
        const receivedMessages = Array.isArray(output.messages) ? output.messages.length : 0
        const messages = filterMessagesInPlace(output.messages)
        if (messages.length !== receivedMessages) {
            logger.warn("Skipping messages with unexpected shape during chat transform", {
                received: receivedMessages,
                usable: messages.length,
            })
        }

        // [FIX Bug 37] Skip OpenCode internal agents (title/summary/compaction).
        // These small hidden LLM requests must not be mutated, and resolving a
        // session state for them would corrupt it (currentTurn, etc.).
        if (isInternalAgentRequest(messages)) {
            logger.debug("Skipping message transform for internal agent request")
            return
        }

        const lastUserMessage = getLastUserMessage(messages)
        let state: SessionState
        if (!lastUserMessage) {
            // Ephemeral state: no session to resolve, but keep running
            // state-independent stages (e.g. stripHallucinations).
            state = createSessionState()
        } else {
            // [FIX #33] Per-session state: each session keeps its own SessionState,
            // so interleaved sessions no longer reset each other's modelContextLimit.
            state = await registry.getOrCreate(
                client,
                lastUserMessage.info.sessionID ?? "",
                messages,
                config,
            )

            // [FIX #312] system.transform (the only writer of
            // state.modelContextLimit) fires AFTER messages.transform within
            // one request, so on the first request after a model switch the
            // value still reflects the previous model. Reconcile it from the
            // catalog entry for the model named on this request's user message
            // before any consumer (filters, GC, nudge thresholds) reads it.
            const requestModel = (
                lastUserMessage.info as { model?: { providerID?: string; modelID?: string } }
            ).model
            let requestModelLimit = registry.resolveModelLimit(
                requestModel?.providerID,
                requestModel?.modelID,
            )
            // [FIX #346] Catalog miss: the init-time seed is fire-and-forget and
            // races server readiness, so in headless spawn+resume mode the
            // catalog can stay empty for the whole process lifetime. During a
            // request the server is guaranteed up (we are inside its pipeline),
            // so retry hydration once per process before any threshold math.
            if (
                requestModelLimit === undefined &&
                requestModel?.providerID &&
                requestModel?.modelID
            ) {
                requestModelLimit = await registry.hydrateAndResolve(
                    client,
                    requestModel.providerID,
                    requestModel.modelID,
                )
            }
            const prevModelID = state.modelID
            if (requestModelLimit !== undefined) {
                state.modelContextLimit = requestModelLimit
                state.modelProviderID = requestModel?.providerID
                state.modelID = requestModel?.modelID
            } else if (
                // [FIX #312 fallback] Catalog miss: we cannot CORRECT the
                // limit, but we can tell when it belongs to a DIFFERENT model.
                // Invalidate instead of letting every percentage threshold
                // below run against the wrong window (#312's false positive).
                // States persisted before this identity pair existed carry no
                // identity and are treated as stale for the same reason.
                // Consumers already tolerate undefined — fresh sessions run
                // with it until the first system.transform sets the pair.
                requestModel?.providerID &&
                requestModel?.modelID &&
                state.modelContextLimit !== undefined &&
                (state.modelProviderID !== requestModel.providerID ||
                    state.modelID !== requestModel.modelID)
            ) {
                state.modelContextLimit = undefined
                state.modelProviderID = requestModel.providerID
                state.modelID = requestModel.modelID
            }
            if (requestModel?.modelID && requestModel.modelID !== prevModelID) {
                logger.info("Model switched mid-session", {
                    session: state.sessionId,
                    from: prevModelID,
                    to: requestModel.modelID,
                    contextLimit: state.modelContextLimit,
                })
            }
            await updatePerTurnState(state, logger, messages)

            if (
                state.modelContextLimit === undefined &&
                !state.noContextLimitWarned &&
                requestModel?.providerID &&
                requestModel?.modelID &&
                registry.resolveModelLimit(requestModel.providerID, requestModel.modelID) ===
                    undefined
            ) {
                state.noContextLimitWarned = true
                logger.warn(
                    'Model reports no context window and the catalog has no entry for it; all percentage thresholds (min/max/emergency, GC) and the context-budget guard are disabled. Set the model limit in opencode.json (e.g. "limit": {"context": 262144, "output": 16384}) to enable them (also fixes the 32000 max_tokens fallback); an absolute compress.maxContextLimit in acp.jsonc only enables proactive nudges, not the guard.',
                    {
                        session: state.sessionId,
                        model: `${requestModel.providerID}/${requestModel.modelID}`,
                    },
                )
            }
        }

        syncCompressPermissionState(state, config, hostPermissions, output.messages)

        if (state.isSubAgent && !config.allowSubAgents) {
            return
        }

        stripHallucinations(output.messages)

        // [#368] Drop oversized reasoning from closed-turn compress tool calls.
        // compress calls are hard-exempt from compression (Bug 39), so their
        // thinking otherwise rides along every request as an unreclaimable
        // floor. Gated by the nested `compress.reasoning` config, resolved
        // through the #344 cascade (model > provider > global) using THIS
        // request's model identity (request metadata first, session state as
        // fallback). Runs BEFORE token accounting / pruning so every later
        // stage sees the post-drop array.
        const dropReasoningModel = (
            lastUserMessage?.info as
                { model?: { providerID?: string; modelID?: string } } | undefined
        )?.model
        const reasoningConfig = applyCompressOverrides(
            config,
            dropReasoningModel?.providerID ?? state.modelProviderID,
            dropReasoningModel?.modelID ?? state.modelID,
        ).compress.reasoning
        if (reasoningConfig?.drop !== false) {
            const droppedReasoning = dropCompressReasoning(
                output.messages,
                reasoningConfig?.threshold ?? DEFAULT_COMPRESS_REASONING.threshold,
            )
            if (droppedReasoning > 0) {
                logger.debug("compress.reasoning: dropped oversized reasoning parts", {
                    dropped: droppedReasoning,
                    threshold: reasoningConfig?.threshold ?? DEFAULT_COMPRESS_REASONING.threshold,
                })
            }
        }

        ensureBuiltinFiltersRegistered()
        const effectiveLimit = resolveEffectiveContextLimit(state, config)
        applyMessageFilters(output.messages, config.messageFilters, logger, {
            sessionId: state.sessionId ?? "",
            isSubAgent: state.isSubAgent,
            modelContextLimit: effectiveLimit?.limit,
        })
        cacheSystemPromptTokens(state, output.messages)
        assignMessageRefs(state, output.messages)
        const activeBlockCountBefore = state.prune.messages.activeBlockIds.size // [FIX Bug 4]
        const compressionStateChanged = syncCompressionBlocks(state, logger, output.messages)
        if (
            compressionStateChanged ||
            state.prune.messages.activeBlockIds.size !== activeBlockCountBefore
        ) {
            // [FIX Bug 4]
            saveSessionState(state, logger).catch(() => {}) // [FIX Bug 4] persist deactivations
        }
        syncToolCache(state, config, logger, output.messages)
        buildToolIdList(state, output.messages)
        const batchResult = runBatchCleanup(state, config, logger, output.messages)
        if (batchResult.mergedCount > 0) {
            saveSessionState(state, logger).catch(() => {})
        }
        const prePruneTokens = getCurrentTokenUsage(state, output.messages)
        // Keep the full post-filter projection for candidate planning. The
        // nudge receives a pruned view, while range validation still needs the
        // original ordering to prove tool-pair and protection parity.
        // Skip the copy entirely when candidates are disabled (default).
        const candidateMessages =
            config.compress.candidates === true ? output.messages.slice() : undefined
        prune(state, logger, config, output.messages)
        hideConsumedCompressCalls(state, output.messages)
        assignMessageRefs(state, output.messages)
        const compressionPriorities = buildPriorityMap(config, state, output.messages)
        prompts.reload()
        injectCompressNudges(
            state,
            config,
            logger,
            output.messages,
            prompts.getRuntimePrompts(),
            compressionPriorities,
            config.debug
                ? (text: string) => {
                      // sendIgnoredMessage writes an ignored:true user msg to DB.
                      // opencode's runtime loop detects it as "last user" (role-only,
                      // ignores the flag) → phantom turn → compress → notification →
                      // infinite loop. Use logger.debug + toast instead.
                      logger.debug(`[ACP Debug] Nudge injected:\n${text}`)
                      client.tui
                          .showToast({
                              body: {
                                  title: "ACP: Nudge Injected",
                                  message: text.slice(0, 500),
                                  variant: "info",
                                  duration: 5000,
                              },
                          })
                          .catch(() => {})
                  }
                : undefined,
            prePruneTokens,
            candidateMessages,
        )
        // Candidate planning consumes the pre-truncation snapshot so its
        // executor-parity check matches the fresh messages fetched by compress.
        truncateLargeToolOutputs(
            state,
            config,
            logger,
            output.messages.filter((message) => !isSyntheticMessage(message)),
        )
        // Keep candidate planning independent from the final budget guard:
        // candidates are computed from the pre-truncation snapshot so their
        // ranges remain valid when the compress executor fetches fresh history.
        enforceContextBudget(state, config, logger, output.messages)
        injectMessageIds(state, config, output.messages, compressionPriorities)
        hideFailedCompressCalls(output.messages)
        stripStaleMetadata(output.messages)
        dropEmptyMessages(output.messages)
        const postTokens = getCurrentTokenUsage(state, output.messages)
        // [FIX #346] Hard guard: if the post-transform context still exceeds
        // the model's real request budget (window minus system prompt + tool
        // schemas + output-token reserve), the backend will reject the
        // request. opencode exits 0 with zero output in that case (upstream
        // behavior the plugin cannot change), so this ERROR is the only
        // signal that the session has hit the length-rejection wall.
        if (postTokens !== undefined && effectiveLimit) {
            const budget =
                effectiveLimit.limit - (state.systemPromptTokens ?? 0) - OUTPUT_RESERVE_TOKENS
            if (postTokens > budget) {
                logger.error(
                    "ACP hard guard: context exceeds model budget after in-flight reduction",
                    {
                        session: state.sessionId,
                        postTokens,
                        budget,
                        contextLimit: effectiveLimit.limit,
                        contextLimitSource: effectiveLimit.source,
                        hint: "request will likely be rejected; run /compact or start a new session",
                    },
                )
            }
        }
        logger.info("Chat transform complete", {
            session: state.sessionId,
            model: state.modelID,
            messages: output.messages.length,
            prePruneTokens,
            postTokens,
            contextLimit: effectiveLimit?.limit,
            contextLimitSource: effectiveLimit?.source,
            usagePct:
                postTokens !== undefined && effectiveLimit
                    ? `${((postTokens / effectiveLimit.limit) * 100).toFixed(1)}%`
                    : undefined,
            nudged: state.nudges.shouldInjectThisTurn,
        })

        if (state.sessionId) {
            await logger.saveContext(state.sessionId, output.messages)
        }
    }
}

function buildHelpText(): string {
    return [
        "[ACP] Available commands:",
        "",
        "  /acp              Show compression status (same as /acp stats)",
        "  /acp context      Token usage breakdown (system, user, assistant, tools)",
        "  /acp stats        Compression status: blocks, context usage, ranges",
        "  /acp export       Export active compression blocks to markdown",
        "                   Options: --output <path>, --tier t1,t2,t3, --stdout, --append",
        "  /acp help         Show this help",
        "",
        "Also accepts /dcp for backward compatibility.",
    ].join("\n")
}

export function createCommandHandler(
    client: any,
    registry: SessionStateRegistry,
    logger: Logger,
    config: PluginConfig,
    workingDirectory: string,
) {
    return async (input: { sessionID: string; text: string }): Promise<void> => {
        if (!config.commands.enabled) {
            return
        }

        const messagesResponse = await client.session.messages({
            path: { id: input.sessionID },
        })
        const messages = filterMessages(messagesResponse.data || messagesResponse)

        const state = await registry.getOrCreate(client, input.sessionID, messages, config)

        const commandCtx = {
            client,
            state,
            config,
            logger,
            sessionId: input.sessionID,
            messages,
            workingDirectory,
        }

        const raw = input.text ?? ""
        const sub = raw.trim().toLowerCase()
        if (sub === "stats" || sub === "status" || sub === "") {
            await handleStatsCommand(commandCtx)
            return
        }

        if (sub === "export" || sub.startsWith("export ")) {
            const exportArgs = raw.trim().slice("export".length).trim() || ""
            await handleExportCommand(commandCtx, exportArgs)
            return
        }

        if (sub === "help") {
            await sendIgnoredMessage(client, input.sessionID, buildHelpText(), {}, logger)
            return
        }

        await handleContextCommand(commandCtx)
    }
}
