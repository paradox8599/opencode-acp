/**
 * Host model-catalog contract (regression guard).
 *
 * @opencode/plugin 2.0.4 moved the host's model catalog from `ctx.catalog.model`
 * to the top-level `ctx.model`. ACP pinned 2.0.3, so the old path still
 * type-checked but raised a TypeError on every 2.0.4+ host — and
 * `hydrateFromClient` swallowed it. The limit catalog then stayed empty for the
 * life of the process, every session ran its thresholds against
 * `compress.contextLimitFallback` (128000), and a 1M-window model was treated
 * as critically full from ~125K on.
 *
 * These tests drive the real host facade, so they fail against the pre-fix
 * `ctx.catalog.model` call.
 */

import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import { Logger } from "../lib/logger"
import { SessionStateRegistry } from "../lib/state"
import { createModelLimitCatalog } from "../lib/state/model-limits"
import { createAcpHost, type V2HostContext } from "../lib/v2/host"

const PROVIDER_ID = "o"
const MODEL_ID = "deepseek-v4.1-flash"
const CONTEXT_LIMIT = 1_000_000

function makeLogger(): Logger {
    return new Logger(false, "error")
}

/** Minimal 2.0.4+ host context — only the `model` domain is exercised here. */
function makeHostCtx(
    models: Array<{ providerID: string; id: string; limit?: { context?: number } }>,
): V2HostContext {
    return {
        model: { list: async () => ({ location: { directory: "/tmp" }, data: models }) },
    } as unknown as V2HostContext
}

test("hydrates model limits from the top-level host model domain", async () => {
    const logger = makeLogger()
    const host = createAcpHost(
        makeHostCtx([{ providerID: PROVIDER_ID, id: MODEL_ID, limit: { context: CONTEXT_LIMIT } }]),
        logger,
        () => {},
    )
    const registry = new SessionStateRegistry(logger)

    const recorded = await registry.hydrateModelLimitsFromClient(host.client)

    assert.equal(
        recorded,
        1,
        "the host model domain must be readable (pre-2.0.4 `ctx.catalog.model` throws)",
    )
    assert.equal(
        registry.resolveModelLimit(PROVIDER_ID, MODEL_ID),
        CONTEXT_LIMIT,
        "the model's real window must reach the catalog, not the 128000 fallback",
    )
})

test("hydration failure is logged instead of silently returning 0", async () => {
    const warnings: string[] = []
    const logger = { warn: (message: string) => warnings.push(message) } as unknown as Logger
    const catalog = createModelLimitCatalog(logger)

    const recorded = await catalog.hydrateFromClient({
        config: {
            providers: async () => {
                throw new Error("host catalog unavailable")
            },
        },
    })

    assert.equal(recorded, 0)
    assert.equal(warnings.length, 1, "a failed hydration must never be invisible")
    assert.match(warnings[0]!, /Model limit catalog hydration failed/)
})
