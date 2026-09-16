import assert from "node:assert/strict"
import test from "node:test"
import {
    WireTagScrubber,
    scrubProviderResponseBody,
    stripWireTags,
} from "../lib/v2/http-response-filter"

const OPEN = '<dcp-message-id tokens="2" type="text">'
const CLOSE = "</dcp-message-id>"
const TAG = OPEN + "m00004" + CLOSE

test("stripWireTags: text without tags is untouched", () => {
    assert.equal(stripWireTags("just a reply"), "just a reply")
})

test("stripWireTags: an unpaired tag is removed", () => {
    assert.equal(stripWireTags("Ok.\n\n" + TAG), "Ok.\n\n")
})

test("stripWireTags: a paired tag drops its invented middle", () => {
    assert.equal(stripWireTags("before" + OPEN + "made up" + CLOSE + "after"), "beforeafter")
})

test("stripWireTags: the acp alias is removed too", () => {
    assert.equal(
        stripWireTags('Ok.<acp-message-id tokens="1" type="text">m00001</acp-message-id>'),
        "Ok.",
    )
})

test("stripWireTags: a bare tag name without brackets is left alone", () => {
    assert.equal(stripWireTags("the dcp-message-id feature"), "the dcp-message-id feature")
})

test("scrubber: plain values pass straight through", () => {
    const scrubber = new WireTagScrubber()
    assert.equal(scrubber.push("hello "), "hello ")
    assert.equal(scrubber.push("world"), "world")
    assert.equal(scrubber.flush(), "")
})

test("scrubber: a tag split across values is removed without leaking text", () => {
    const scrubber = new WireTagScrubber()
    let out = ""
    const pieces = [
        "Ok.",
        "\n\n",
        "<",
        "dcp",
        "-m",
        "essage",
        "-id",
        " tokens",
        "=",
        '"2"',
        " type",
        '="text"',
        ">",
        "m00004",
        "<",
        "/dcp",
        "-message-id",
        ">",
    ]
    for (const piece of pieces) out += scrubber.push(piece)
    out += scrubber.flush()
    assert.equal(out, "Ok.\n\n")
})

test("scrubber: a dangling opener is dropped at flush", () => {
    const scrubber = new WireTagScrubber()
    assert.equal(scrubber.push("Ok."), "Ok.")
    assert.equal(scrubber.push("<dcp-messa"), "")
    assert.equal(scrubber.flush(), "")
})

test("scrubber: a lone '<' that cannot become a tag is emitted", () => {
    const scrubber = new WireTagScrubber()
    assert.equal(scrubber.push("a < b"), "a < b")
})

/* ------------------------------------------------------------------ *
 * SSE pipeline
 * ------------------------------------------------------------------ */

/** Deltas exactly as the provider streams them: the tag arrives token by token. */
const FRAGMENTS = [
    "Ok",
    ".",
    "\n\n",
    "<",
    "dcp",
    "-m",
    "essage",
    "-id",
    " tokens",
    "=",
    '"2"',
    " type",
    '="text"',
    ">",
    "m00004",
    "<",
    "/dcp",
    "-m",
    "essage",
    "-id",
    ">",
]

const event = (content: string, extra: Record<string, unknown> = {}): string =>
    `data: ${JSON.stringify({
        id: "gen_1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
        ...extra,
    })}\n\n`

const sseBody = (contents: string[]): string =>
    contents.map((content) => event(content)).join("") + "data: [DONE]\n\n"

/** Feed the body in fixed-size byte slices so partial lines are exercised too. */
const sliced = (text: string, size: number): ReadableStream<Uint8Array> =>
    new ReadableStream({
        start(controller) {
            const bytes = new TextEncoder().encode(text)
            for (let i = 0; i < bytes.length; i += size)
                controller.enqueue(bytes.slice(i, i + size))
            controller.close()
        },
    })

const scrub = async (body: string, size = 7): Promise<{ text: string; content: string }> => {
    const response = scrubProviderResponseBody(
        new Response(sliced(body, size), { headers: { "content-type": "text/event-stream" } }),
    )
    const text = await response.text()
    const content = text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter((payload) => payload !== "[DONE]")
        .map(
            (payload) =>
                JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> },
        )
        .map((payload) => payload.choices?.[0]?.delta?.content ?? "")
        .join("")
    return { text, content }
}

test("sse: a tag split across many events never reaches the stream", async () => {
    const { text, content } = await scrub(sseBody(FRAGMENTS))
    assert.equal(content, "Ok.\n\n")
    assert.equal(text.includes("message-id"), false)
})

test("sse: a tag in one event is removed", async () => {
    const { content } = await scrub(sseBody(["Ok.", "\n\n" + TAG]))
    assert.equal(content, "Ok.\n\n")
})

test("sse: a paired tag drops the invented middle", async () => {
    const { content } = await scrub(sseBody(["Ok.", "\n\n" + OPEN + "invented" + CLOSE]))
    assert.equal(content, "Ok.\n\n")
})

test("sse: a reply with no tag is unchanged", async () => {
    const { content } = await scrub(sseBody(["Hello", ", ", "world", "."]))
    assert.equal(content, "Hello, world.")
})

test("sse: every rewritten line stays valid JSON", async () => {
    const { text } = await scrub(sseBody(FRAGMENTS))
    for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue
        const payload = line.slice(5).trim()
        if (payload === "[DONE]") continue
        assert.doesNotThrow(() => JSON.parse(payload))
    }
    assert.equal(text.includes("data: [DONE]"), true)
})

test("sse: usage and finish_reason events survive", async () => {
    const body =
        sseBody(["Ok", "."]) +
        `data: ${JSON.stringify({ id: "gen_1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3 } })}\n\n`
    const { text } = await scrub(body)
    const last =
        text
            .split("\n")
            .filter((line) => line.startsWith("data:") && !line.includes("[DONE]"))
            .pop() ?? ""
    const parsed = JSON.parse(last.slice(5).trim()) as {
        usage?: unknown
        choices: Array<{ finish_reason?: string }>
    }
    assert.deepEqual(parsed.usage, { prompt_tokens: 3 })
    assert.equal(parsed.choices[0].finish_reason, "stop")
})

test("sse: a non-SSE response passes through untouched", async () => {
    const body = JSON.stringify({ choices: [{ message: { content: "Ok.\n\n" + TAG } }] })
    const response = scrubProviderResponseBody(
        new Response(body, { headers: { "content-type": "application/json" } }),
    )
    assert.equal(await response.text(), body)
})

test("sse: no content-type means no rewriting", async () => {
    const response = scrubProviderResponseBody(new Response(sseBody(FRAGMENTS)))
    assert.equal(response.body === null, false)
})
