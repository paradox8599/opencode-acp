import assert from "node:assert/strict"
import test from "node:test"
import { sessionMessagesToInternal } from "../lib/v2/session-adapter"
import type { V2SessionMessage } from "../lib/v2/types"

const SID = "ses_test"

test("maps user, synthetic, skill and system messages with durable ids", () => {
    const messages = sessionMessagesToInternal(
        [
            { id: "msg_u1", type: "user", text: "hello", time: { created: 100 } },
            { id: "msg_s1", type: "synthetic", text: "notice", time: { created: 200 } },
            { id: "msg_k1", type: "skill", text: "skill body", time: { created: 300 } },
            { id: "msg_y1", type: "system", text: "instruction delta", time: { created: 400 } },
        ],
        SID,
    )

    assert.deepEqual(
        messages.map((message) => [message.info.id, message.info.role]),
        [
            ["msg_u1", "user"],
            ["msg_s1", "user"],
            ["msg_k1", "user"],
            ["msg_y1", "system"],
        ],
    )
    assert.deepEqual(messages[0]!.parts, [{ type: "text", text: "hello" }])
    assert.equal(messages[3]!.parts[0]!.text, "instruction delta")
})

test("maps assistant text, reasoning and tool states", () => {
    const messages = sessionMessagesToInternal(
        [
            {
                id: "msg_a1",
                type: "assistant",
                time: { created: 100 },
                model: { providerID: "test", id: "model" },
                content: [
                    { type: "text", text: "answer" },
                    { type: "reasoning", text: "thinking" },
                    {
                        type: "tool",
                        id: "call_1",
                        name: "read",
                        state: {
                            status: "completed",
                            input: { path: "a.ts" },
                            content: [{ type: "text", text: "file contents" }],
                        },
                    },
                    {
                        type: "tool",
                        id: "call_2",
                        name: "edit",
                        state: {
                            status: "error",
                            input: { path: "b.ts" },
                            error: { message: "denied" },
                        },
                    },
                    {
                        type: "tool",
                        id: "call_3",
                        name: "grep",
                        state: { status: "running", input: { pattern: "x" } },
                    },
                ],
            },
        ],
        SID,
    )

    const parts = messages[0]!.parts
    assert.deepEqual(
        parts.map((part) => part.type),
        ["text", "reasoning", "tool", "tool", "tool"],
    )
    const completed = parts[2]!
    assert.equal(completed.callID, "call_1")
    assert.equal(completed.state?.status, "completed")
    assert.equal(completed.state?.output, "file contents")
    const errored = parts[3]!
    assert.equal(errored.state?.status, "error")
    assert.equal(errored.state?.error, "denied")
    const running = parts[4]!
    assert.equal(running.state?.status, "running")
})

test("skips control messages and running compactions", () => {
    const messages = sessionMessagesToInternal(
        [
            { id: "msg_i1", type: "idle", time: { created: 1 } },
            { id: "msg_m1", type: "model-switched", time: { created: 2 } },
            { id: "msg_c1", type: "compaction", status: "running", time: { created: 3 } },
            { id: "msg_u1", type: "user", text: "kept", time: { created: 4 } },
        ],
        SID,
    )

    assert.equal(messages.length, 1)
    assert.equal(messages[0]!.info.id, "msg_u1")
})

test("maps completed compaction checkpoints to summary messages", () => {
    const messages = sessionMessagesToInternal(
        [
            {
                id: "msg_c1",
                type: "compaction",
                status: "completed",
                summary: "prior work",
                recent: "recent context",
                time: { created: 50 },
            },
        ],
        SID,
    )

    assert.equal(messages.length, 1)
    assert.equal(messages[0]!.info.role, "assistant")
    assert.equal(messages[0]!.info.summary, true)
    const text = messages[0]!.parts[0]!.text as string
    assert.ok(text.includes("prior work"))
    assert.ok(text.includes("recent context"))
})

test("shell messages render the command and output", () => {
    const messages = sessionMessagesToInternal(
        [
            {
                id: "msg_sh",
                type: "shell",
                command: "ls",
                output: { output: "a.ts" },
                time: { created: 10 },
            },
        ],
        SID,
    )

    const text = messages[0]!.parts[0]!.text as string
    assert.ok(text.includes("ls"))
    assert.ok(text.includes("a.ts"))
})

test("accepts DateTime-like time values and falls back to now", () => {
    const messages = sessionMessagesToInternal(
        [
            {
                id: "msg_u1",
                type: "user",
                text: "hello",
                time: { created: { epochMilliseconds: 123 } },
            } as V2SessionMessage,
        ],
        SID,
    )

    assert.equal(messages[0]!.info.time.created, 123)
})
