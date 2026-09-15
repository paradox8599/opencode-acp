import assert from "node:assert/strict"
import test from "node:test"
import { createSessionState } from "../lib/state"
import { applyUsageTotals, sumUsageTokens } from "../lib/v2/usage"

test("sumUsageTokens adds all provider counters", () => {
    assert.equal(
        sumUsageTokens({ input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 2 } }),
        157,
    )
    assert.equal(sumUsageTokens({ input: 100 }), 100)
    assert.equal(sumUsageTokens({}), 0)
    assert.equal(sumUsageTokens({ input: Number.NaN, output: 3 }), 3)
})

test("applyUsageTotals baselines the first cumulative event, then stores deltas", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000

    assert.equal(applyUsageTotals(state, 100_000_000), true)
    assert.equal(state.lastUsedTokens, undefined)

    assert.equal(applyUsageTotals(state, 100_043_000), true)
    assert.equal(state.lastUsedTokens, 43_000)
})

test("applyUsageTotals rejects deltas that cannot be a context size", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000

    applyUsageTotals(state, 100_000_000)
    // Delta (5M) exceeds the model window → poisoned value must not be stored.
    applyUsageTotals(state, 105_000_000)
    assert.equal(state.lastUsedTokens, undefined)

    // The baseline still advances, so the next plausible request is usable.
    applyUsageTotals(state, 105_030_000)
    assert.equal(state.lastUsedTokens, 30_000)
})

test("applyUsageTotals re-baselines when the cumulative counter resets", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000

    applyUsageTotals(state, 50_000_000)
    applyUsageTotals(state, 40_000_000)
    assert.equal(state.lastUsedTokens, undefined)

    applyUsageTotals(state, 40_030_000)
    assert.equal(state.lastUsedTokens, 30_000)
})

test("applyUsageTotals ignores non-positive totals", () => {
    const state = createSessionState()

    assert.equal(applyUsageTotals(state, 0), false)
    assert.equal(applyUsageTotals(state, -5), false)
    assert.equal(applyUsageTotals(state, Number.NaN), false)
    assert.equal(state.lastCumulativeUsage, undefined)
})
