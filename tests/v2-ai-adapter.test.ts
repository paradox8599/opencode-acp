import assert from "node:assert/strict"
import test from "node:test"
import { importV2Messages, type V2ImportContext } from "../lib/v2/ai-adapter"
import type { V2Message } from "../lib/v2/types"

const ctx: V2ImportContext = {
    sessionID: "ses_test",
    agent: "build",
    model: { providerID: "test", modelID: "model" },
}

const user = (id: string, text: string): V2Message => ({
    id,
    role: "user",
    content: [{ type: "text", text }],
})

const assistant = (id: string, content: V2Message["content"]): V2Message => ({
    id,
    role: "assistant",
    content,
})

const toolResult = (callID: string, name: string, value: string): V2Message => ({
    role: "tool",
    content: [{ type: "tool-result", id: callID, name, result: { type: "text", value } }],
})

test("folds tool result messages into the owning assistant message", () => {
    const imported = importV2Messages(
        [
            user("msg_1", "hi"),
            assistant("msg_2", [
                { type: "tool-call", id: "call_1", name: "read", input: { path: "a.ts" } },
            ]),
            toolResult("call_1", "read", "file contents"),
        ],
        ctx,
    )

    assert.equal(imported.messages.length, 2)
    const tool = imported.messages[1]!.parts.find((part) => part.type === "tool")!
    assert.equal(tool.callID, "call_1")
    assert.equal(tool.tool, "read")
    assert.equal(tool.state?.status, "completed")
    assert.equal(tool.state?.output, "file contents")
    assert.equal(imported.messages[1]!.parts[0]!.type, "step-start")
})

test("export round-trips untouched messages and restores the tool result message", () => {
    const input = [
        user("msg_1", "hi"),
        assistant("msg_2", [
            { type: "text", text: "reading" },
            { type: "tool-call", id: "call_1", name: "read", input: { path: "a.ts" } },
        ]),
        toolResult("call_1", "read", "file contents"),
    ]
    const imported = importV2Messages(input, ctx)
    const out = imported.exportV2Messages()

    assert.equal(out.length, 3)
    assert.equal(out[0]!.id, "msg_1")
    assert.equal(out[1]!.id, "msg_2")
    assert.deepEqual(
        out[1]!.content.map((part) => part.type),
        ["text", "tool-call"],
        "step-start markers must not leak into the request",
    )
    assert.equal(out[2]!.role, "tool")
    const result = out[2]!.content[0] as { id: string; result: unknown }
    assert.equal(result.id, "call_1")
    assert.deepEqual(result.result, { type: "text", value: "file contents" })
})

test("pruning an assistant message removes its folded tool result", () => {
    const imported = importV2Messages(
        [
            user("msg_1", "hi"),
            assistant("msg_2", [
                { type: "tool-call", id: "call_1", name: "read", input: {} },
            ]),
            toolResult("call_1", "read", "file contents"),
            user("msg_3", "next"),
        ],
        ctx,
    )

    const kept = imported.messages.filter((message) => message.info.id !== "msg_2")
    const out = imported.exportV2Messages(kept)

    assert.equal(out.length, 2)
    assert.deepEqual(
        out.map((message) => message.id),
        ["msg_1", "msg_3"],
    )
})

test("mutated text and tool output are rebuilt on export", () => {
    const imported = importV2Messages(
        [
            user("msg_1", "hi"),
            assistant("msg_2", [
                { type: "text", text: "original text" },
                { type: "tool-call", id: "call_1", name: "read", input: {} },
            ]),
            toolResult("call_1", "read", "original output"),
        ],
        ctx,
    )

    for (const part of imported.messages[1]!.parts) {
        if (part.type === "text") part.text = "rewritten text"
        if (part.type === "tool") part.state = { ...part.state!, output: "rewritten output" }
    }

    const out = imported.exportV2Messages()
    const assistantContent = out[1]!.content as Array<{ type: string; text?: string }>
    assert.equal(assistantContent[0]!.text, "rewritten text")
    const result = out[2]!.content[0] as { result: { value: string } }
    assert.equal(result.result.value, "rewritten output")
})

test("synthetic internal messages export as user messages without ids", () => {
    const imported = importV2Messages([user("msg_1", "hi")], ctx)
    imported.messages.push({
        info: {
            id: "msg_dcp_summary_abc",
            sessionID: "ses_test",
            role: "user",
            time: { created: 1 },
        },
        parts: [{ type: "text", text: "SUMMARY CONTENT" }],
    })

    const out = imported.exportV2Messages()
    assert.equal(out.length, 2)
    assert.equal(out[1]!.role, "user")
    assert.equal(out[1]!.id, undefined)
    assert.deepEqual(out[1]!.content, [{ type: "text", text: "SUMMARY CONTENT" }])
})

test("system and id-less messages pass through at their chronological anchor", () => {
    const imported = importV2Messages(
        [
            user("msg_1", "a"),
            { role: "system", content: [{ type: "text", text: "SYS UPDATE" }] },
            assistant("msg_2", [{ type: "text", text: "b" }]),
        ],
        ctx,
    )

    assert.equal(imported.messages.length, 2, "system messages are not internalized")
    const out = imported.exportV2Messages()
    assert.equal(out.length, 3)
    assert.equal(out[1]!.role, "system")
    assert.deepEqual(out[1]!.content, [{ type: "text", text: "SYS UPDATE" }])
})

test("provider-executed tool results stay inline in the assistant message", () => {
    const imported = importV2Messages(
        [
            user("msg_1", "search"),
            assistant("msg_2", [
                { type: "tool-call", id: "call_1", name: "web", input: {}, providerExecuted: true },
                {
                    type: "tool-result",
                    id: "call_1",
                    name: "web",
                    result: { type: "text", value: "hosted result" },
                    providerExecuted: true,
                },
            ]),
        ],
        ctx,
    )

    const out = imported.exportV2Messages()
    assert.equal(out.length, 2, "no separate tool message for hosted results")
    assert.deepEqual(
        out[1]!.content.map((part) => part.type),
        ["tool-call", "tool-result"],
    )
    const result = out[1]!.content[1] as { result: { value: string } }
    assert.equal(result.result.value, "hosted result")
})

test("error tool results import as errored tool parts", () => {
    const imported = importV2Messages(
        [
            user("msg_1", "go"),
            assistant("msg_2", [
                { type: "tool-call", id: "call_1", name: "read", input: {} },
            ]),
            {
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        id: "call_1",
                        name: "read",
                        result: { type: "error", value: "boom" },
                    },
                ],
            },
        ],
        ctx,
    )

    const tool = imported.messages[1]!.parts.find((part) => part.type === "tool")!
    assert.equal(tool.state?.status, "error")
    assert.equal(tool.state?.output, "boom")
})

test("compaction checkpoints become internal assistant summaries", () => {
    const imported = importV2Messages(
        [
            {
                id: "msg_cp",
                role: "user",
                content: [
                    {
                        type: "text",
                        text: "<conversation-checkpoint>\nsummary\n</conversation-checkpoint>",
                    },
                ],
            },
        ],
        ctx,
    )

    assert.equal(imported.messages.length, 1)
    assert.equal(imported.messages[0]!.info.role, "assistant")
    assert.equal(imported.messages[0]!.info.summary, true)
})
