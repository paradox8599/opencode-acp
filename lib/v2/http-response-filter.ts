/**
 * Strip hallucinated `dcp-*` tags out of a streaming provider response.
 *
 * The model sees ACP's `mNNNNN` refs (appended to every message as
 * `<dcp-message-id …>`) and occasionally copies that shape onto the end of its
 * own reply. Those tags must never reach the harness, because the reply text it
 * receives is what gets persisted.
 *
 * The response is an SSE stream whose `content` is delivered in small deltas:
 * a single tag arrives split across many events, with JSON framing in between
 * (`{"content":"dc"}` … `{"content":"p"}`). A regex over the raw bytes can
 * therefore never see the tag. The stream is parsed event by event, the
 * `content` deltas are re-assembled through a stateful scrubber, and the
 * scrubbed value is written back into the same event.
 */

/** Opening tag, with or without the `-message-id` suffix. */
const TAG_OPEN = /<(?:dcp|acp)(?:-message-id)?[^>]{0,200}>/gi

/** Closing tag the model writes. */
const TAG_CLOSE = /<\/(?:dcp|acp)(?:-message-id)?[^>]{0,200}>/gi

/**
 * A complete `open … close` span. The text between the tags is dropped with
 * them — it is the invented body of the hallucinated block.
 */
const TAG_PAIRED =
    /<(?:dcp|acp)(?:-message-id)?[^>]{0,200}>[\s\S]{0,4000}?<\/(?:dcp|acp)(?:-message-id)?[^>]{0,200}>/gi

/**
 * The tail of a buffer that could still grow into a tag: a dangling `<` or
 * `</`, a partial tag name (`<d`, `<dc`, `<dcp-`…), or a name followed by the
 * start of its attributes. Prose like `< b` does not match, so it is never held.
 */
const TAG_PREFIX = /^(?:\/)?(?:[da][a-z-]{0,24}(?:[\s"'][^>]*)?)?$/i

const TAG_NAME = /(?:dcp|acp)(?:-message-id)?/i

/** Cheap guard so the common (tag-free) value skips the regex work. */
const looksLikeTag = (text: string): boolean => text.includes("<") || TAG_NAME.test(text)

/** Remove every tag the model wrote, leaving the surrounding text in place. */
export function stripWireTags(text: string): string {
    if (!looksLikeTag(text)) return text
    return text.replace(TAG_PAIRED, "").replace(TAG_OPEN, "").replace(TAG_CLOSE, "")
}

/**
 * Incremental `stripWireTags`. Values arrive split at arbitrary offsets, so a
 * dangling tag opener is held back — it may still grow into a complete tag
 * whose middle text has to be dropped as well.
 */
export class WireTagScrubber {
    private pending = ""

    /** Feed the next value; returns the text that is safe to emit now. */
    push(chunk: string): string {
        if (chunk.length === 0) return ""
        this.pending += chunk

        const holdFrom = this.holdFrom()
        if (holdFrom >= this.pending.length) {
            const text = stripWireTags(this.pending)
            this.pending = ""
            return text
        }
        if (holdFrom <= 0) return ""

        const text = stripWireTags(this.pending.slice(0, holdFrom))
        this.pending = this.pending.slice(holdFrom)
        return text
    }

    /** Stream ended; returns whatever is left, stripped. */
    flush(): string {
        const pending = this.pending
        this.pending = ""
        // An unfinished tag at the very end can never be completed; drop it
        // instead of leaking the fragment.
        const partial = this.partialIndex(pending)
        if (partial < 0) return stripWireTags(pending)
        return stripWireTags(pending.slice(0, partial))
    }

    /**
     * Start of the region that has to be held back; `pending.length` when the
     * whole buffer is safe to emit.
     */
    private holdFrom(): number {
        const unmatched = this.unmatchedOpenerIndex()
        const partial = this.partialIndex()
        if (unmatched < 0) return partial < 0 ? this.pending.length : partial
        if (partial < 0) return unmatched
        return Math.min(unmatched, partial)
    }

    /**
     * Index of the trailing `<` that could still grow into a tag — the buffer
     * ends inside it, or it already carries a tag name. `-1` when the buffer
     * ends with something that can no longer become one.
     */
    private partialIndex(text: string = this.pending): number {
        const at = text.lastIndexOf("<")
        if (at < 0) return -1
        const rest = text.slice(at + 1)
        if (rest.length === 0 || rest === "/") return at
        return TAG_PREFIX.test(rest) ? at : -1
    }

    /**
     * Index of the first opener with no closing tag after it, using the same
     * non-greedy pairing as `TAG_PAIRED`: an opener pairs with the nearest
     * following closer.
     */
    private unmatchedOpenerIndex(): number {
        TAG_OPEN.lastIndex = 0
        TAG_CLOSE.lastIndex = 0
        let opener: RegExpExecArray | null
        while ((opener = TAG_OPEN.exec(this.pending)) !== null) {
            TAG_CLOSE.lastIndex = opener.index + opener[0].length
            const closer = TAG_CLOSE.exec(this.pending)
            if (!closer) return opener.index
            TAG_OPEN.lastIndex = closer.index + closer[0].length
        }
        return -1
    }
}

/** Provider bodies we rewrite; anything else passes through untouched. */
const SSE_CONTENT_TYPE = /^text\/event-stream/i

/** `data:` line, keeping the exact prefix and line ending for untouched lines. */
const DATA_LINE = /^(data:\s*)([\s\S]*?)(\r?\n)?$/

/**
 * Rewrite a provider response so hallucinated tags never reach the harness.
 * Only SSE responses carry incremental `content`, so only those are rewritten.
 */
export function scrubProviderResponseBody(response: Response): Response {
    const body = response.body
    if (!body) return response
    if (!SSE_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) return response

    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    const scrubber = new WireTagScrubber()
    let buffer = ""

    const stream = body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                buffer += decoder.decode(chunk, { stream: true })
                const lines = buffer.split("\n")
                // The final element has no newline yet: it may be a partial line.
                buffer = lines.pop() ?? ""
                let out = ""
                for (const line of lines) out += scrubLine(line + "\n", scrubber)
                if (out.length > 0) controller.enqueue(encoder.encode(out))
            },
            flush(controller) {
                buffer += decoder.decode()
                let out = buffer.length > 0 ? scrubLine(buffer, scrubber) : ""
                // Whatever the scrubber still holds is an unfinished tag; drop it
                // rather than emitting a fragment after the stream's last event.
                scrubber.flush()
                if (out.length > 0) controller.enqueue(encoder.encode(out))
            },
        }),
    )

    return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    })
}

/** Rewrite the `content` deltas of one SSE line, leaving every other line as-is. */
function scrubLine(line: string, scrubber: WireTagScrubber): string {
    const match = DATA_LINE.exec(line)
    if (!match) return line
    const [, prefix, payload, eol = ""] = match
    if (payload === "[DONE]") return line

    let parsed: unknown
    try {
        parsed = JSON.parse(payload)
    } catch {
        return line
    }

    if (!scrubContentDeltas(parsed, scrubber)) return line
    return `${prefix}${JSON.stringify(parsed)}${eol}`
}

/**
 * Run every `choices[].delta.content` / `choices[].message.content` string
 * through the response's scrubber. Returns whether anything was rewritten.
 */
function scrubContentDeltas(payload: unknown, scrubber: WireTagScrubber): boolean {
    if (typeof payload !== "object" || payload === null) return false
    const choices = (payload as { choices?: unknown }).choices
    if (!Array.isArray(choices)) return false

    let changed = false
    for (const choice of choices) {
        if (typeof choice !== "object" || choice === null) continue
        for (const holder of ["delta", "message"]) {
            const value = (choice as Record<string, unknown>)[holder]
            if (typeof value !== "object" || value === null) continue
            const content = (value as Record<string, unknown>).content
            if (typeof content !== "string") continue
            // One scrubber per response: the tag's characters are spread across
            // events, so the state has to survive from one event to the next.
            const scrubbed = scrubber.push(content)
            if (scrubbed === content) continue
            ;(value as Record<string, unknown>).content = scrubbed
            changed = true
        }
    }
    return changed
}
