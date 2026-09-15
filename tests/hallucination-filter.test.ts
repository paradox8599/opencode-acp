import assert from "node:assert/strict"
import test from "node:test"
import type {
    LanguageModelV3,
    LanguageModelV3CallOptions,
    LanguageModelV3GenerateResult,
    LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import { HallucinationTagFilter, withHallucinationFilter } from "../lib/v2/hallucination-filter"
import { stripHallucinationsFromString } from "../lib/messages/utils"

const MESSAGE_TAG = `<dcp-message-id tokens="583" type="text">m00020</dcp-message-id>`

// Each sample exercises a distinct shape the stream filter must agree with the
// reference implementation on: full tags, truncated tags, orphan tags, plain
// text that merely contains `<`/`>`, case variants, nested spans and pairs.
const SAMPLES = [
    `plain text without any tags`,
    `hello ${MESSAGE_TAG} world`,
    `trailing ${MESSAGE_TAG}`,
    `${MESSAGE_TAG} leading`,
    `orphan closer </dcp-message-id> tail`,
    `orphan opener <dcp-system-reminder> tail`,
    `truncated mid-tag <dcp-message-id tokens="1" type="text">m00020`,
    `truncated opener <acp`,
    `partial name <d`,
    `partial name with closer <`,
    `nested <dcp-a>1<dcp-b>2</dcp-b>3</dcp-a>`,
    `two pairs <dcp-a>X</dcp-a>Y<dcp-b>Z`,
    `UPPER <DCP-SYSTEM-REMINDER>note</DCP-SYSTEM-REMINDER> tail`,
    `math 1 < 2 and 3 > 2, html <div>kept</div>`,
    `acp tag <acp-block-id>b3</acp-block-id> after`,
    `split-ish <dc<`,
    `split-ish a<d<dcp`,
]

function runSequence(text: string, sizes: number[]): string {
    const filter = new HallucinationTagFilter()
    let out = ""
    let index = 0
    for (const size of sizes) {
        if (index >= text.length) break
        out += filter.push(text.slice(index, index + size))
        index += size
    }
    if (index < text.length) out += filter.push(text.slice(index))
    return out + filter.flush()
}

test("stream filter matches the reference strip for every two-way split", () => {
    for (const sample of SAMPLES) {
        const expected = stripHallucinationsFromString(sample)
        for (let split = 0; split <= sample.length; split++) {
            const filter = new HallucinationTagFilter()
            let out = filter.push(sample.slice(0, split))
            out += filter.push(sample.slice(split))
            out += filter.flush()
            assert.equal(out, expected, `sample=${JSON.stringify(sample)} split=${split}`)
        }
    }
})

test("stream filter matches the reference strip for fixed-size chunks", () => {
    for (const sample of SAMPLES) {
        const expected = stripHallucinationsFromString(sample)
        for (const size of [1, 2, 3, 5, 7, 11]) {
            const sizes = Array.from({ length: Math.ceil(sample.length / size) }, () => size)
            assert.equal(
                runSequence(sample, sizes),
                expected,
                `sample=${JSON.stringify(sample)} size=${size}`,
            )
        }
    }
})

test("clean deltas pass through unchanged", () => {
    const filter = new HallucinationTagFilter()
    assert.equal(filter.push("hello world"), "hello world")
    assert.equal(filter.flush(), "")
})

// --- wrapped LanguageModelV3 ---

function streamOf(parts: LanguageModelV3StreamPart[]): ReadableStream<LanguageModelV3StreamPart> {
    return new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
            for (const part of parts) controller.enqueue(part)
            controller.close()
        },
    })
}

function fakeModel(input: {
    streamParts?: LanguageModelV3StreamPart[]
    generateResult?: LanguageModelV3GenerateResult
}): LanguageModelV3 {
    return {
        specificationVersion: "v3",
        provider: "test-provider",
        modelId: "test-model",
        supportedUrls: {},
        doGenerate: async () => input.generateResult as LanguageModelV3GenerateResult,
        doStream: async () => ({ stream: streamOf(input.streamParts ?? []) }),
    }
}

async function collect(
    stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<LanguageModelV3StreamPart[]> {
    const parts: LanguageModelV3StreamPart[] = []
    const reader = stream.getReader()
    for (;;) {
        const { done, value } = await reader.read()
        if (done) return parts
        parts.push(value)
    }
}

function textOf(parts: LanguageModelV3StreamPart[]): string {
    return parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("")
}

test("wrapped doStream strips a tag split across deltas and leaves other parts alone", async () => {
    const wrapped = withHallucinationFilter(
        fakeModel({
            streamParts: [
                { type: "text-start", id: "t1" },
                { type: "text-delta", id: "t1", delta: `answer <dcp-message-id ` },
                { type: "text-delta", id: "t1", delta: `tokens="321" type="text">m00183` },
                { type: "text-delta", id: "t1", delta: `</dcp-message-id>` },
                { type: "text-end", id: "t1" },
                { type: "reasoning-start", id: "r1" },
                { type: "reasoning-delta", id: "r1", delta: MESSAGE_TAG },
                { type: "reasoning-end", id: "r1" },
            ],
        }),
    )

    const result = await wrapped.doStream({} as LanguageModelV3CallOptions)
    const parts = await collect(result.stream)

    assert.equal(textOf(parts), "answer ")
    assert.deepEqual(
        parts.flatMap((part) => (part.type === "reasoning-delta" ? [part.delta] : [])),
        [MESSAGE_TAG],
        "reasoning deltas must pass through untouched",
    )
    assert.ok(parts.some((part) => part.type === "text-end" && part.id === "t1"))
    assert.equal(parts.at(-1)?.type, "reasoning-end")
})

test("held text is flushed as a delta before text-end", async () => {
    const wrapped = withHallucinationFilter(
        fakeModel({
            streamParts: [
                { type: "text-start", id: "t1" },
                { type: "text-delta", id: "t1", delta: `keep <dcp-message-id tokens="1">m00020` },
                { type: "text-end", id: "t1" },
            ],
        }),
    )

    const result = await wrapped.doStream({} as LanguageModelV3CallOptions)
    const parts = await collect(result.stream)

    assert.equal(textOf(parts), "keep m00020")
    assert.deepEqual(
        parts.map((part) => part.type),
        ["text-start", "text-delta", "text-delta", "text-end"],
    )
})

test("held text is flushed when the stream closes without text-end", async () => {
    const wrapped = withHallucinationFilter(
        fakeModel({
            streamParts: [
                { type: "text-start", id: "t1" },
                { type: "text-delta", id: "t1", delta: `tail <dcp-message-id tokens="1">m00020` },
            ],
        }),
    )

    const result = await wrapped.doStream({} as LanguageModelV3CallOptions)
    const parts = await collect(result.stream)

    assert.equal(textOf(parts), "tail m00020")
})

test("interleaved text ids are filtered independently", async () => {
    const wrapped = withHallucinationFilter(
        fakeModel({
            streamParts: [
                { type: "text-start", id: "a" },
                { type: "text-delta", id: "a", delta: `<dcp-a>` },
                { type: "text-start", id: "b" },
                { type: "text-delta", id: "b", delta: `visible` },
                { type: "text-delta", id: "a", delta: `hidden</dcp-a>` },
                { type: "text-end", id: "a" },
                { type: "text-end", id: "b" },
            ],
        }),
    )

    const result = await wrapped.doStream({} as LanguageModelV3CallOptions)
    const parts = await collect(result.stream)

    assert.equal(textOf(parts), "visible")
})

test("wrapped doGenerate strips text content only", async () => {
    const generateResult = {
        content: [
            { type: "text", text: `x <dcp-b>1</dcp-b> y` },
            { type: "reasoning", text: `<dcp-b>2</dcp-b>` },
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
    } as unknown as LanguageModelV3GenerateResult

    const wrapped = withHallucinationFilter(fakeModel({ generateResult }))
    const result = await wrapped.doGenerate({} as LanguageModelV3CallOptions)

    assert.deepEqual(result.content[0], { type: "text", text: "x  y" })
    assert.deepEqual(result.content[1], { type: "reasoning", text: `<dcp-b>2</dcp-b>` })
})

test("wrapper delegates model identity fields", () => {
    const result = withHallucinationFilter(fakeModel({}))
    assert.equal(result.specificationVersion, "v3")
    assert.equal(result.provider, "test-provider")
    assert.equal(result.modelId, "test-model")
})
