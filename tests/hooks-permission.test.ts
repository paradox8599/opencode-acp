import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { createChatMessageTransformHandler, createCommandHandler } from "../lib/hooks"
import { applyPendingCompressionDurations, recordCompressionDuration } from "../lib/compress/timing"
import { Logger } from "../lib/logger"
import {
    createSessionState,
    ensureSessionInitialized,
    saveSessionState,
    type WithParts,
} from "../lib/state"
import { createTestRegistry } from "./registry-stub"

function buildConfig(permission: "allow" | "ask" | "deny" = "allow"): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: {
            enabled: true,
            protectedTools: [],
        },
        experimental: {
            allowSubAgents: false,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            mode: "message",
            permission,
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
        },
    }
}

function buildMessage(id: string, role: "user" | "assistant", text: string): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: "session-1",
            agent: "assistant",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-part`,
                messageID: id,
                sessionID: "session-1",
                type: "text",
                text,
            },
        ],
    }
}

test("chat message transform strips hallucinated tags even when compress is denied", async () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig("deny")
    const handler = createChatMessageTransformHandler(
        { session: { get: async () => ({}) } } as any,
        createTestRegistry(state),
        logger,
        config,
        {
            reload() {},
            getRuntimePrompts() {
                return {} as any
            },
        } as any,
        { global: undefined, agents: {} },
    )
    const output = {
        messages: [buildMessage("assistant-1", "assistant", "alpha <dcp>beta</dcp> omega")],
    }

    await handler({}, output)

    assert.equal(output.messages[0]?.parts[0]?.type, "text")
    assert.equal((output.messages[0]?.parts[0] as any).text, "alpha  omega")
})

test("chat message transform drops messages without info instead of crashing", async () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig("deny")
    const handler = createChatMessageTransformHandler(
        { session: { get: async () => ({}) } } as any,
        createTestRegistry(state),
        logger,
        config,
        {
            reload() {},
            getRuntimePrompts() {
                return {} as any
            },
        } as any,
        { global: undefined, agents: {} },
    )
    const output = {
        messages: [
            {
                role: "user",
                time: 1,
                parts: [
                    {
                        type: "text",
                        text: "Carica le skill di laravel",
                    },
                ],
            } as any,
        ],
    }

    await handler({}, output as any)

    assert.equal(state.sessionId, null)
    assert.equal(output.messages.length, 0)
})

test("command handler runs informational commands even when compress is denied", async () => {
    let sessionMessagesCalls = 0
    const handler = createCommandHandler(
        {
            session: {
                messages: async () => {
                    sessionMessagesCalls += 1
                    return { data: [] }
                },
            },
        } as any,
        createTestRegistry(createSessionState()),
        new Logger(false),
        buildConfig("deny"),
        "/tmp",
    )

    // /acp (no args) shows compression status — works regardless of permission
    await handler({ sessionID: "session-1", text: "" })

    assert.equal(sessionMessagesCalls, 1)
})

test("command handler returns normally for the context subcommand", async () => {
    let sessionMessagesCalls = 0
    const handler = createCommandHandler(
        {
            session: {
                messages: async () => {
                    sessionMessagesCalls += 1
                    return { data: [] }
                },
            },
        } as any,
        createTestRegistry(createSessionState()),
        new Logger(false),
        buildConfig("allow"),
        "/tmp",
    )

    await handler({ sessionID: "session-1", text: "context" })

    assert.equal(sessionMessagesCalls, 1)
})

function makeBlock(blockId: number, messageId: string, callId: string) {
    return {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        topic: "topic",
        startId: "m00001",
        endId: "m00002",
        anchorMessageId: messageId,
        compressMessageId: messageId,
        compressCallId: callId,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "",
        survivedCount: 0,
    }
}

test("in-tool compression duration attaches to matching blocks by message and call id", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, makeBlock(1, "message-1", "call-1"))

    recordCompressionDuration(state, "message-1", "call-1", 42)
    const applied = applyPendingCompressionDurations(state)

    assert.equal(applied, 1)
    assert.equal(state.prune.messages.blocksById.get(1)?.durationMs, 42)
})

test("duration keys keep the same call id distinct across message ids", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, makeBlock(1, "message-1", "call-1"))
    state.prune.messages.blocksById.set(2, makeBlock(2, "message-2", "call-1"))

    recordCompressionDuration(state, "message-1", "call-1", 10)
    recordCompressionDuration(state, "message-2", "call-1", 20)
    applyPendingCompressionDurations(state)

    assert.equal(state.prune.messages.blocksById.get(1)?.durationMs, 10)
    assert.equal(state.prune.messages.blocksById.get(2)?.durationMs, 20)
})
