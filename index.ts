import type { Plugin } from "@opencode/plugin"
import { getConfig } from "./lib/config"
import {
    createAcpContextRecapTool,
    createAcpStatusTool,
    createCompressRangeTool,
    createDecompressTool,
    createSearchContextTool,
} from "./lib/compress"
import { Logger } from "./lib/logger"
import { SessionStateRegistry, saveSessionState } from "./lib/state"
import { PromptStore } from "./lib/prompts/store"
import { createCommandHandler } from "./lib/hooks"
import { findBiliProxyProviders } from "./lib/bili-proxy"
import { startAutoUpdate } from "./lib/update"
import { createAcpHost } from "./lib/v2/host"
import { createV2ContextHandler } from "./lib/v2/context-handler"
import { scrubProviderResponseBody } from "./lib/v2/http-response-filter"
import { toV2Tool } from "./lib/v2/tools"
import { applyUsageTotals, sumUsageTokens, type V2UsageTokens } from "./lib/v2/usage"
import { ACP_VERSION } from "./lib/version"

const plugin: Plugin.Plugin = {
    id: "opencode-acp",

    async setup(ctx) {
        const directory = ctx.location.directory
        const config = getConfig({
            directory,
            client: {
                tui: {
                    showToast: (input) => {
                        const body = input.body ?? {}
                        console.warn(
                            `[opencode-acp] ${body.title ?? "Notice"}: ${body.message ?? ""}`,
                        )
                    },
                },
            },
        })

        if (!config.enabled) {
            return
        }

        if (process.env.BILLION_CONTEXT_PROXY) {
            console.log(
                "[opencode-acp] disabled: BILLION_CONTEXT_PROXY detected — proxy handles compression",
            )
            return
        }

        const logger = new Logger(config.debug, config.debug ? "debug" : config.logLevel)
        logger.info("ACP plugin initialized", {
            version: ACP_VERSION,
            workspace: directory,
            logLevel: logger.level,
            debug: config.debug,
            autoUpdate: config.autoUpdate,
        })

        const registry = new SessionStateRegistry(logger, directory)
        const prompts = new PromptStore(
            logger,
            directory,
            config.experimental.customPrompts,
            config.compress.candidates === true,
        )

        // Provider-reported usage feeds the nudge thresholds: V2 native
        // messages carry no `tokens` field, so `session.usage.updated` is the
        // only real prompt-size signal (system prompt + tools included).
        // The event reports SESSION-CUMULATIVE totals — lib/v2/usage.ts keeps
        // the baseline and stores the per-request delta, rejecting values that
        // cannot be a real context size.
        const eventAbort = new AbortController()
        void (async () => {
            try {
                for await (const event of ctx.event.subscribe({ signal: eventAbort.signal })) {
                    if (event.type !== "session.usage.updated") continue
                    const data = (event as { data?: unknown }).data
                    if (!data || typeof data !== "object") continue
                    const record = data as { sessionID?: unknown; tokens?: unknown }
                    if (typeof record.sessionID !== "string") continue
                    if (!record.tokens || typeof record.tokens !== "object") continue
                    const total = sumUsageTokens(record.tokens as V2UsageTokens)
                    if (total <= 0) continue
                    const state = registry.get(record.sessionID)
                    if (!state) continue
                    // Persist so a fresh `run` server keeps both the baseline
                    // and the latest request's usage.
                    if (applyUsageTotals(state, total)) {
                        saveSessionState(state, logger).catch(() => {})
                    }
                }
            } catch (error) {
                if (!eventAbort.signal.aborted) {
                    logger.warn("ACP event subscription ended", {
                        error: error instanceof Error ? error.message : String(error),
                    })
                }
            }
        })()

        // [FIX #337] Manual proxy mode: a provider baseURL routed through the
        // bili proxy means the proxy handles context compression — ACP must
        // stay fully off, mirroring the BILLION_CONTEXT_PROXY env guard.
        const disabledByBiliProxy = await detectBiliProxy(ctx, logger)
        if (disabledByBiliProxy) {
            console.log(
                "[opencode-acp] disabled: /bili/ proxy detected in provider baseURL — proxy handles compression",
            )
            return
        }

        // Model output hygiene: the model sometimes echoes the dcp-message-id
        // tags it sees in its context into its own reply (with an invented
        // token count). V1 stripped those in `experimental.text.complete`; V2
        // has no such hook, and the `aisdk` "language" hook never fires for
        // external plugins (verified in 2.0.3), so the cleanup runs on the
        // provider's raw HTTP response — the only output-side hook the harness
        // dispatches. See lib/v2/http-response-filter.ts.
        await ctx.session.hook("http.response", (event) => {
            event.response = scrubProviderResponseBody(event.response)
        })

        if (config.compress.permission === "ask") {
            logger.warn(
                'compress.permission "ask" is not supported by the OpenCode V2 plugin API (no mid-execution permission prompt); treating it as "allow". Use OpenCode permission rules with effect "deny" to disable compression.',
            )
        }

        const host = createAcpHost(
            ctx,
            logger,
            (sessionID, messageID) => {
                const state = registry.get(sessionID)
                if (!state) return
                state.hiddenMessageIds.add(messageID)
                // The write must outlive this process: a later request may run
                // in a fresh server process that reloads state from disk.
                saveSessionState(state, logger).catch(() => {})
            },
            (sessionID, messageID) =>
                registry.get(sessionID)?.hiddenMessageIds.has(messageID) ?? false,
        )

        // Seed the model-limit catalog so the FIRST request after a model
        // switch resolves the new model's context window. Fire-and-forget —
        // outcome is logged so a silent degrade stays debuggable.
        registry.hydrateModelLimitsFromClient(host.client).then(
            (recorded) => {
                if (recorded > 0) {
                    logger.info("Model limit catalog seeded from provider catalog", {
                        models: recorded,
                    })
                } else {
                    logger.warn(
                        "Model limit catalog seeding recorded no entries — " +
                            "falling back to per-request refresh",
                    )
                }
            },
            (error) => {
                logger.warn("Model limit catalog seeding failed", {
                    error: error instanceof Error ? error.message : String(error),
                })
            },
        )

        const toolsEnabled = config.compress.permission !== "deny"

        if (toolsEnabled) {
            await ctx.session.hook(
                "context",
                createV2ContextHandler({
                    client: host.client,
                    registry,
                    logger,
                    config,
                    prompts,
                }),
            )

            const toolContext = {
                client: host.client,
                registry,
                logger,
                config,
                prompts,
            }

            await ctx.tool.transform((editor) => {
                editor.add(toV2Tool("compress", createCompressRangeTool(toolContext)))
                editor.add(toV2Tool("decompress", createDecompressTool(toolContext)))
                editor.add(toV2Tool("search_context", createSearchContextTool(toolContext)))
                editor.add(toV2Tool("acp_status", createAcpStatusTool(toolContext)))
                editor.add(toV2Tool("acp_context_recap", createAcpContextRecapTool(toolContext)))
            })
        }

        if (config.commands.enabled && toolsEnabled) {
            const handleCommand = createCommandHandler(
                host.client,
                registry,
                logger,
                config,
                directory,
            )
            const execute = async (input: {
                sessionID: string
                prompt: { text?: string }
            }): Promise<void> => {
                await handleCommand({
                    sessionID: input.sessionID,
                    text: input.prompt?.text ?? "",
                })
            }

            await ctx.command.transform((editor) => {
                editor.add({
                    name: "acp",
                    description: "ACP context management (stats, context, export, help)",
                    execute,
                })
                editor.add({
                    name: "dcp",
                    description: "ACP context management (backward-compatible alias)",
                    execute,
                })
            })
        }

        startAutoUpdate(host.client, config.autoUpdate, logger)

        logger.info("ACP initialized")
        return () => {
            eventAbort.abort()
            logger.info("ACP plugin unloaded")
        }
    },
}

export default plugin

async function detectBiliProxy(
    ctx: {
        /**
         * Host provider catalog. @opencode/plugin 2.0.4 moved this from
         * `ctx.catalog.provider` to `ctx.provider`.
         */
        provider: { list(): Promise<unknown> }
    },
    logger: Logger,
): Promise<boolean> {
    try {
        const payload = await ctx.provider.list()
        const providers = Array.isArray(payload)
            ? payload
            : Array.isArray((payload as { data?: unknown })?.data)
              ? ((payload as { data: unknown[] }).data ?? [])
              : []
        const shaped: Record<string, unknown> = {}
        for (const provider of providers) {
            if (!provider || typeof provider !== "object") continue
            const record = provider as {
                id?: unknown
                settings?: Record<string, unknown>
            }
            if (typeof record.id !== "string") continue
            shaped[record.id] = {
                options: { baseURL: record.settings?.baseURL },
            }
        }
        return findBiliProxyProviders(shaped).length > 0
    } catch (error) {
        // Never silent: swallowing this hid a broken catalog call for days.
        logger.warn("bili-proxy detection failed", {
            error: error instanceof Error ? error.message : String(error),
        })
        return false
    }
}
