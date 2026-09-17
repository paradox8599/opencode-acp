/**
 * [FIX #312] Catalog of per-model context limits, keyed `${providerID}/${modelID}`.
 *
 * Within one LLM request the host fires experimental.chat.messages.transform
 * BEFORE experimental.chat.system.transform (sst/opencode: session/prompt.ts
 * triggers messages.transform, then llm/request.ts triggers system.transform
 * during handle.process). state.modelContextLimit is written only by the
 * system hook, so on the first request after a model switch every percentage
 * threshold (emergencyThresholdPercent, min/maxContextLimit "%", GC tiers) is
 * still computed against the PREVIOUS model's
 * limit. This catalog lets the messages hook reconcile against the model
 * named on the request's user message instead of waiting one turn.
 *
 * Entries are recorded live by the messages hook (in V2 there is no
 * system-transform hook, so that hook is the only writer) and seeded once at
 * plugin init from the host's model catalog — `ctx.model.list()`, surfaced to
 * the pipeline as `client.config.providers()`.
 *
 * [2026-09-17] The host moved this API from `ctx.catalog.model` to `ctx.model`
 * in @opencode/plugin 2.0.4. Calling the old path raised a TypeError that the
 * catch below swallowed, so the catalog stayed permanently empty while looking
 * exactly like "the host has no model limits". Every session then fell back to
 * `compress.contextLimitFallback` (128000) and treated a 1M-window model as
 * critically full. Do not remove the error log.
 *
 * Standalone factory (not embedded in SessionStateRegistry) so the test
 * registry stub can compose the SAME implementation instead of hand-rolling
 * a drift-prone copy.
 */
import type { Logger } from "../logger"

export interface ModelLimitCatalog {
    record(
        providerId: string | undefined,
        modelId: string | undefined,
        limit: number | undefined,
    ): void
    resolve(providerId: string | undefined, modelId: string | undefined): number | undefined
    hydrateFromClient(client: unknown): Promise<number>
}

export function createModelLimitCatalog(logger?: Logger): ModelLimitCatalog {
    const modelLimits = new Map<string, number>()
    return {
        record(providerId, modelId, limit) {
            if (!providerId || !modelId || typeof limit !== "number" || limit <= 0) return
            modelLimits.set(`${providerId}/${modelId}`, limit)
        },
        resolve(providerId, modelId) {
            if (!providerId || !modelId) return undefined
            return modelLimits.get(`${providerId}/${modelId}`)
        },
        /**
         * Best-effort one-time seed from the host's model catalog
         * (`client.config.providers()` → `ctx.model.list()`). Never throws;
         * returns the number of model-limit entries recorded. Failures are
         * logged: returning 0 silently is what let host API drift masquerade
         * as "no models configured" for three days.
         */
        async hydrateFromClient(client: unknown): Promise<number> {
            try {
                const config = client as {
                    config?: { providers?: () => Promise<{ data?: unknown }> }
                }
                const result = await config.config?.providers?.()
                const payload = result as { data?: { providers?: unknown } } | undefined
                const providers = payload?.data?.providers
                if (!Array.isArray(providers)) return 0
                let recorded = 0
                for (const provider of providers) {
                    const { id, models } = (provider ?? {}) as {
                        id?: unknown
                        models?: Record<string, unknown>
                    }
                    if (typeof id !== "string" || !models) continue
                    for (const [modelId, model] of Object.entries(models)) {
                        const limit = (model as { limit?: { context?: unknown } } | null)?.limit
                        const context = limit?.context
                        if (typeof context === "number" && context > 0) {
                            modelLimits.set(`${id}/${modelId}`, context)
                            recorded++
                        }
                    }
                }
                return recorded
            } catch (error) {
                logger?.warn("Model limit catalog hydration failed", {
                    error: error instanceof Error ? error.message : String(error),
                })
                return 0
            }
        },
    }
}
