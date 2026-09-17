/**
 * V2 plugin setup contract tests.
 *
 * Drives the real plugin entry (`index.ts`) with a fake V2 context and
 * asserts what it registers: the context hook, the five ACP tools, the
 * `/acp`/`/dcp` commands, and the model-visible behavior of the context hook
 * (system prompt injection + message-id tags). Also covers the two disable
 * paths inherited from V1: `/bili/` proxy detection and
 * `compress.permission: "deny"`.
 */

import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const configHome = process.env.XDG_CONFIG_HOME!
mkdirSync(join(configHome, "opencode"), { recursive: true })
const acpConfigPath = join(configHome, "opencode", "acp.jsonc")

function writeAcpConfig(config: Record<string, unknown>) {
    writeFileSync(acpConfigPath, JSON.stringify({ autoUpdate: false, ...config }), "utf-8")
}
writeAcpConfig({})

const { default: plugin } = await import("../index")

interface FakeContext {
    hooks: Map<string, (event: any) => unknown>
    tools: Array<{ name: string; description: string; input: unknown }>
    commands: Array<{ name: string; description?: string; execute: (input: any) => Promise<void> }>
    synthetics: Array<{ sessionID: string; text: string; description?: string; metadata?: unknown }>
    sessionInfo: Record<string, unknown>
}

function makeContext(options: {
    providers?: Array<{ id: string; settings?: Record<string, unknown> }>
    models?: Array<{ providerID: string; id: string; limit?: { context?: number } }>
}): { ctx: any; fake: FakeContext } {
    const fake: FakeContext = {
        hooks: new Map(),
        tools: [],
        commands: [],
        synthetics: [],
        sessionInfo: { id: "ses_test" },
    }

    const ctx = {
        app: { name: "test", version: "2.0.5", channel: "test" },
        location: {
            directory: process.cwd(),
            project: { id: "proj", directory: process.cwd(), canonical: process.cwd() },
        },
        options: {},
        // @opencode/plugin 2.0.4+ host shape: `provider` and `model` are
        // top-level domains; the pre-2.0.4 `catalog` wrapper no longer exists.
        // This fixture used to mock `catalog` — i.e. it substituted ACP's own
        // wrong assumption for the real host API, which is how the drift broke
        // in production while every test stayed green.
        provider: { list: async () => ({ data: options.providers ?? [] }) },
        model: { list: async () => ({ data: options.models ?? [] }) },
        session: {
            hook: async (name: string, callback: (event: any) => unknown) => {
                fake.hooks.set(name, callback)
                return { dispose: async () => {} }
            },
            context: async () => [],
            get: async () => fake.sessionInfo,
            synthetic: async (input: {
                sessionID: string
                text: string
                description?: string
                metadata?: unknown
            }) => {
                fake.synthetics.push(input)
                return { id: `msg_synth_${fake.synthetics.length}` }
            },
        },
        tool: {
            transform: async (callback: (editor: any) => void) => {
                callback({
                    add: (tool: { name: string; description: string; input: unknown }) => {
                        fake.tools.push(tool)
                    },
                    list: () => fake.tools,
                    get: () => undefined,
                    namespace: () => {},
                    update: () => {},
                    remove: () => {},
                })
                return { dispose: async () => {} }
            },
        },
        command: {
            transform: async (callback: (editor: any) => void) => {
                callback({
                    add: (command: {
                        name: string
                        description?: string
                        execute: (input: any) => Promise<void>
                    }) => {
                        fake.commands.push(command)
                    },
                })
                return { dispose: async () => {} }
            },
        },
    }

    return { ctx, fake }
}

const ACP_TOOLS = ["compress", "decompress", "search_context", "acp_status", "acp_context_recap"]

test("setup registers context hook, ACP tools and commands", async () => {
    writeAcpConfig({})
    const { ctx, fake } = makeContext({
        models: [{ providerID: "test", id: "model", limit: { context: 100_000 } }],
    })

    await plugin.setup(ctx)

    assert.ok(fake.hooks.has("context"), "context hook must be registered")
    assert.deepEqual(
        fake.tools.map((tool) => tool.name).sort(),
        [...ACP_TOOLS].sort(),
        "all five ACP tools must be registered",
    )
    assert.deepEqual(
        fake.commands.map((command) => command.name).sort(),
        ["acp", "dcp"],
        "the /acp command plus /dcp alias must be registered",
    )

    assert.ok(
        fake.hooks.has("http.response"),
        "the provider-response hook (hallucination filter) must be registered",
    )
    for (const tool of fake.tools) {
        assert.ok(tool.description.length > 0, `${tool.name} must carry a description`)
        assert.ok(tool.input, `${tool.name} must carry an input schema`)
    }
})

const LEAKED_TAG = '<dcp-message-id tokens="104" type="text">m00041</dcp-message-id>'

test("http.response hook scrubs hallucinated tags out of provider bodies", async () => {
    writeAcpConfig({})
    const { ctx, fake } = makeContext({
        models: [{ providerID: "test", id: "model", limit: { context: 100_000 } }],
    })
    await plugin.setup(ctx)

    const responseHook = fake.hooks.get("http.response")
    assert.ok(responseHook, "the provider-response hook (hallucination filter) must be registered")

    // Production shape: the payload is JSON, so the tag's quotes arrive escaped.
    const payload = { choices: [{ delta: { content: `hello ${LEAKED_TAG} world` } }] }
    const event: any = {
        request: new Request("https://provider.test/v1/chat/completions"),
        response: new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
        }),
    }

    await responseHook(event)

    const text = await event.response.text()
    assert.equal(text.includes("dcp-message-id"), false, "tags must not reach the harness")
    assert.equal(text.includes("data: [DONE]"), true, "untouched events must survive")

    const parsed = JSON.parse(text.split("\n\n")[0].slice("data: ".length))
    assert.equal(parsed.choices[0].delta.content, "hello  world", "clean text must survive")
})

test("setup stays off when a /bili/ proxy provider is configured", async () => {
    writeAcpConfig({})
    const { ctx, fake } = makeContext({
        providers: [
            {
                id: "openai",
                settings: { baseURL: "http://127.0.0.1:8787/bili/https://api.openai.com/v1" },
            },
        ],
    })

    await plugin.setup(ctx)

    assert.equal(fake.hooks.size, 0, "no hooks may be registered behind the bili proxy")
    assert.equal(fake.tools.length, 0, "no tools may be registered behind the bili proxy")
    assert.equal(fake.commands.length, 0, "no commands may be registered behind the bili proxy")
})

test('compress.permission "deny" registers no tools or commands', async () => {
    writeAcpConfig({ compress: { permission: "deny" } })
    const { ctx, fake } = makeContext({})

    await plugin.setup(ctx)

    assert.deepEqual(
        [...fake.hooks.keys()],
        ["http.response"],
        "only the response scrubber stays active when compression tools are denied",
    )
    assert.equal(fake.tools.length, 0)
    assert.equal(fake.commands.length, 0)
})

test("context hook injects the system prompt and message-id tags", async () => {
    writeAcpConfig({})
    const { ctx, fake } = makeContext({
        models: [{ providerID: "test", id: "model", limit: { context: 100_000 } }],
    })
    await plugin.setup(ctx)

    const hook = fake.hooks.get("context")!
    const event = {
        sessionID: "ses_context",
        agent: "build",
        model: { providerID: "test", id: "model" },
        system: [{ type: "text", text: "base system prompt" }],
        messages: [{ id: "msg_1", role: "user", content: [{ type: "text", text: "hello world" }] }],
        tools: { compress: {}, other: {} },
    }

    await hook(event)

    assert.equal(event.system.length, 2, "ACP system prompt must be appended")
    assert.ok(
        event.system[1].text.toLowerCase().includes("compress"),
        "ACP system prompt must describe the compress tool",
    )
    const userText = event.messages[0].content
        .filter((part: any) => part.type === "text")
        .map((part: any) => part.text)
        .join("\n")
    assert.ok(
        userText.includes("dcp-message-id"),
        `ACP message refs must be injected, got: ${JSON.stringify(userText)}`,
    )
})

test("sub-agent sessions lose the ACP tools when allowSubAgents is false", async () => {
    writeAcpConfig({ allowSubAgents: false })
    const { ctx, fake } = makeContext({
        models: [{ providerID: "test", id: "model", limit: { context: 100_000 } }],
    })
    await plugin.setup(ctx)

    fake.sessionInfo = { id: "ses_child", parentID: "ses_parent" }

    const hook = fake.hooks.get("context")!
    const event = {
        sessionID: "ses_child",
        agent: "build",
        model: { providerID: "test", id: "model" },
        system: [{ type: "text", text: "base system prompt" }],
        messages: [{ id: "msg_1", role: "user", content: [{ type: "text", text: "child task" }] }],
        tools: {
            compress: {},
            decompress: {},
            search_context: {},
            acp_status: {},
            acp_context_recap: {},
            other: {},
        },
    }

    await hook(event)

    for (const name of ACP_TOOLS) {
        assert.equal(name in event.tools, false, `${name} must be hidden from sub-agent requests`)
    }
    assert.ok("other" in event.tools, "unrelated tools must survive")
    assert.equal(event.system.length, 1, "sub-agent requests skip the ACP system prompt")
})

test("command execute writes model-invisible synthetic output", async () => {
    writeAcpConfig({})
    const { ctx, fake } = makeContext({
        models: [{ providerID: "test", id: "model", limit: { context: 100_000 } }],
    })
    await plugin.setup(ctx)

    const command = fake.commands.find((entry) => entry.name === "acp")!
    await command.execute({ sessionID: "ses_cmd", prompt: { text: "help" }, delivery: "steer" })

    assert.equal(fake.synthetics.length, 1, "command output must be written as a synthetic message")
    assert.equal(fake.synthetics[0]!.sessionID, "ses_cmd")
    assert.ok(fake.synthetics[0]!.text.includes("/acp"), "help output must list the commands")
    assert.equal(
        fake.synthetics[0]!.description,
        fake.synthetics[0]!.text,
        "synthetic output needs a description — the V2 TUI hides rows without one",
    )
})
