/**
 * Regression: compaction detection must be IDENTITY-based.
 *
 * The V2 AI-message path has no per-message timestamps and used to fabricate
 * `time.created = now` for every message — including the compaction checkpoint
 * (the harness summary). The old timestamp comparison in `updatePerTurnState`
 * therefore fired "Detected compaction - reset stale state" on EVERY request:
 * nudges, message refs, the tool cache and the usage baseline were wiped once
 * per turn, and `lastCompaction` advanced to "now" — which in turn made every
 * message look compacted (symptom: /acp context showed all zeros).
 *
 * Covers:
 * - repeated turns with the same checkpoint reset state exactly once
 *   (multi-turn; asserts a planted side effect survives the second turn),
 * - the timestamp-carrying checkpoint shape the old adapter produced
 *   (fresh `created` every turn) — still reset only once,
 * - transcript-derived checkpoints (real timestamps) reconcile/repair a
 *   poisoned boundary,
 * - AI-path checkpoints (created 0) never move the boundary.
 */
import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"

import { createSessionState, updatePerTurnState } from "../lib/state"
import { isMessageCompacted, syncCompactionBoundary } from "../lib/state/utils"
import { Logger } from "../lib/logger"
import type { WithParts } from "../lib/state/types"

const logger = new Logger(false)
const SESSION = "ses_compaction_identity"

function message(
    id: string,
    role: "user" | "assistant",
    created: number,
    summary = false,
): WithParts {
    return {
        info: {
            id,
            sessionID: SESSION,
            role,
            time: { created },
            ...(summary ? { summary: true } : {}),
        },
        parts: [{ type: "text", text: `content of ${id}` }],
    } as unknown as WithParts
}

function checkpoint(id: string, created: number): WithParts {
    return message(id, "assistant", created, true)
}

test("same checkpoint across turns resets state exactly once (identity, not time)", async () => {
    const state = createSessionState()
    state.sessionId = SESSION

    // AI-path shape: checkpoints carry created 0 (adapter sentinel).
    const cp = () => checkpoint("msg_cp_fixed", 0)
    const turn = (n: number) => [
        cp(),
        message(`u${n}`, "user", Date.now()),
        message(`a${n}`, "assistant", Date.now()),
    ]

    await updatePerTurnState(state, logger, turn(1))
    assert.equal(state.lastCompactionCheckpointId, "msg_cp_fixed", "checkpoint id recorded")
    assert.equal(state.lastCompaction, 0, "AI-path checkpoint must not move the boundary")

    // Plant state that a (re-)detection would clear.
    state.nudges.lastPerMessageNudgeTokens = 54_321
    state.lastUsedTokens = 12_345

    await updatePerTurnState(state, logger, turn(2))
    assert.equal(
        state.nudges.lastPerMessageNudgeTokens,
        54_321,
        "second turn must not reset nudge baselines",
    )
    assert.equal(state.lastUsedTokens, 12_345, "second turn must not clear the usage baseline")
    assert.equal(state.lastCompaction, 0, "boundary still untouched")
})

test("timestamp-carrying checkpoint (old adapter shape) still resets only once", async () => {
    const state = createSessionState()
    state.sessionId = SESSION

    // Faithful emulation of the pre-fix adapter: the checkpoint's `created` is
    // recomputed as "now" on every request.
    const turn = () => [
        checkpoint("msg_cp_legacy", Date.now()),
        message("live", "assistant", Date.now()),
    ]

    await updatePerTurnState(state, logger, turn())
    assert.equal(state.lastCompactionCheckpointId, "msg_cp_legacy")

    state.nudges.lastPerMessageNudgeTokens = 999
    await updatePerTurnState(state, logger, turn())
    assert.equal(
        state.nudges.lastPerMessageNudgeTokens,
        999,
        "a fresh synthetic timestamp must not re-trigger detection",
    )
})

test("transcript checkpoint repairs a boundary poisoned with 'now'", () => {
    const state = createSessionState()
    state.lastCompaction = Date.now() // poisoned by the old detection

    const changed = syncCompactionBoundary(state, [
        checkpoint("msg_cp_real", 1_000),
        message("live", "assistant", 5_000),
    ])

    assert.equal(changed, true, "repair must be reported so callers can persist")
    assert.equal(state.lastCompaction, 1_000, "boundary pulled back to the real compaction time")
    assert.equal(state.lastCompactionCheckpointId, "msg_cp_real")
    assert.equal(
        isMessageCompacted(state, message("live", "assistant", 5_000)),
        false,
        "messages newer than the checkpoint are live context, not compacted history",
    )
    assert.equal(
        isMessageCompacted(state, message("old", "user", 500)),
        true,
        "messages older than the checkpoint stay compacted",
    )
})

test("AI-path checkpoint (created 0) never moves the boundary", () => {
    const state = createSessionState()
    assert.equal(syncCompactionBoundary(state, [checkpoint("msg_cp_ai", 0)]), false)
    assert.equal(state.lastCompaction, 0)
    assert.equal(state.lastCompactionCheckpointId, undefined)
})
