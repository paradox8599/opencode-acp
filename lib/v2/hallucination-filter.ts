/**
 * V2 replacement for the V1 `experimental.text.complete` guard.
 *
 * The model occasionally imitates the `dcp-message-id` tags it sees appended to
 * every request message and echoes one (with an invented token count) into its
 * own reply. V1 stripped those in `experimental.text.complete`
 * (`createTextCompleteHandler`); V2 has no text-complete hook, but the `aisdk`
 * "language" hook lets a plugin replace the resolved `LanguageModelV3`, so the
 * same cleanup runs on the model output itself — before the harness persists or
 * displays it.
 */

import type {
    LanguageModelV3,
    LanguageModelV3CallOptions,
    LanguageModelV3GenerateResult,
    LanguageModelV3StreamPart,
    LanguageModelV3StreamResult,
} from "@ai-sdk/provider"
import { stripHallucinationsFromString } from "../messages/utils"

const DCP_TAG_OPENER = /<(?:dcp|acp)[^>]*>/gi
const DCP_TAG_CLOSER = /<\/(?:dcp|acp)[^>]*>/gi

/**
 * Leftmost position of a buffer tail that could still grow into a dcp/acp tag:
 * a partial tag name (`<`, `<d`, `<dc`, `<a`, `<ac`, …) or an opener whose `>`
 * has not arrived yet. Anchored with `$`, so `search` returns the earliest
 * position whose match reaches the end of the buffer.
 */
const DCP_PARTIAL_TAG_AT_END = /<\/?(?:(?:dcp|acp)[^>]*|d(?:c(?:p)?)?|a(?:c(?:p)?)?)?$/i

/**
 * Incremental form of `stripHallucinationsFromString`.
 *
 * Deltas arrive in arbitrary splits, so the filter must not decide too early:
 * a dangling tag opener may become a full tag whose middle text has to be
 * dropped as well. The filter therefore emits only the prefix that can no longer
 * participate in a match (stripped with the reference function) and holds the
 * rest until more text — or `flush()` — arrives.
 */
export class HallucinationTagFilter {
    private buffer = ""

    /** Feed the next delta; returns the text that is safe to emit now. */
    push(delta: string): string {
        this.buffer += delta

        const holdFrom = this.holdFrom()
        if (holdFrom >= this.buffer.length) {
            const text = stripHallucinationsFromString(this.buffer)
            this.buffer = ""
            return text
        }
        if (holdFrom <= 0) return ""

        const text = stripHallucinationsFromString(this.buffer.slice(0, holdFrom))
        this.buffer = this.buffer.slice(holdFrom)
        return text
    }

    /** Text block (or stream) ended; returns whatever is left, stripped. */
    flush(): string {
        const text = stripHallucinationsFromString(this.buffer)
        this.buffer = ""
        return text
    }

    /**
     * Start of the region that must be held back; `buffer.length` when the
     * whole buffer is safe to emit.
     */
    private holdFrom(): number {
        const unmatched = this.unmatchedOpenerIndex()
        const partial = this.buffer.search(DCP_PARTIAL_TAG_AT_END)
        if (unmatched < 0) return partial < 0 ? this.buffer.length : partial
        if (partial < 0) return unmatched
        return Math.min(unmatched, partial)
    }

    /**
     * Index of the first opener with no closing tag after it, using the same
     * non-greedy pairing as `DCP_PAIRED_TAG_REGEX`: an opener pairs with the
     * nearest following closer.
     */
    private unmatchedOpenerIndex(): number {
        DCP_TAG_OPENER.lastIndex = 0
        DCP_TAG_CLOSER.lastIndex = 0
        let opener: RegExpExecArray | null
        while ((opener = DCP_TAG_OPENER.exec(this.buffer)) !== null) {
            DCP_TAG_CLOSER.lastIndex = opener.index + opener[0].length
            const closer = DCP_TAG_CLOSER.exec(this.buffer)
            if (!closer) return opener.index
            DCP_TAG_OPENER.lastIndex = closer.index + closer[0].length
        }
        return -1
    }
}

/**
 * Rewrite a part stream: text deltas pass through a per-`id` filter, and any
 * held text is emitted as a synthetic delta just before `text-end` (or before
 * the stream closes) so no content is lost.
 */
function filterTextStream(
    stream: ReadableStream<LanguageModelV3StreamPart>,
): ReadableStream<LanguageModelV3StreamPart> {
    const filters = new Map<string, HallucinationTagFilter>()
    return stream.pipeThrough(
        new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
            transform(part, controller) {
                if (part.type === "text-delta") {
                    let filter = filters.get(part.id)
                    if (!filter) {
                        filter = new HallucinationTagFilter()
                        filters.set(part.id, filter)
                    }
                    const text = filter.push(part.delta)
                    if (text === part.delta) controller.enqueue(part)
                    else if (text.length > 0) controller.enqueue({ ...part, delta: text })
                    return
                }

                if (part.type === "text-end") {
                    const filter = filters.get(part.id)
                    if (filter) {
                        filters.delete(part.id)
                        const tail = filter.flush()
                        if (tail.length > 0) {
                            controller.enqueue({ type: "text-delta", id: part.id, delta: tail })
                        }
                    }
                    controller.enqueue(part)
                    return
                }

                controller.enqueue(part)
            },
            flush(controller) {
                for (const [id, filter] of filters) {
                    const tail = filter.flush()
                    if (tail.length > 0) {
                        controller.enqueue({ type: "text-delta", id, delta: tail })
                    }
                }
                filters.clear()
            },
        }),
    )
}

/**
 * Wrap a resolved model so hallucinated dcp/acp tags never reach the harness.
 * Only the output paths are replaced; every other field is delegated verbatim.
 */
export function withHallucinationFilter(language: LanguageModelV3): LanguageModelV3 {
    return {
        specificationVersion: language.specificationVersion,
        provider: language.provider,
        modelId: language.modelId,
        supportedUrls: language.supportedUrls,
        doGenerate: (
            options: LanguageModelV3CallOptions,
        ): PromiseLike<LanguageModelV3GenerateResult> =>
            Promise.resolve(language.doGenerate(options)).then((result) => ({
                ...result,
                content: result.content.map((part) =>
                    part.type === "text"
                        ? { ...part, text: stripHallucinationsFromString(part.text) }
                        : part,
                ),
            })),
        doStream: (options: LanguageModelV3CallOptions): PromiseLike<LanguageModelV3StreamResult> =>
            Promise.resolve(language.doStream(options)).then((result) => ({
                ...result,
                stream: filterTextStream(result.stream),
            })),
    }
}
