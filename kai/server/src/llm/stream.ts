/**
 * Server-sent-event helpers, both directions:
 *  - frame builders for the OpenAI-compatible `text/event-stream` we emit, and
 *  - an incremental parser for the upstream streams we consume.
 *
 * No dependencies — `eventsource-parser` is not in the allowed dependency set,
 * and the wire format is small enough to own.
 */

/* ------------------------------------------------------------------ *
 * Outbound frames
 * ------------------------------------------------------------------ */

export interface ChunkFrameInit {
    id: string
    model: string
    /** Unix seconds, constant for every frame of one completion. */
    created: number
    role?: 'assistant'
    delta?: string
    finishReason?: string | null
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

/** One `chat.completion.chunk`, already framed as an SSE `data:` event. */
export function chunkFrame(init: ChunkFrameInit): string {
    const delta: Record<string, unknown> = {}
    if (init.role) delta.role = init.role
    if (init.delta !== undefined) delta.content = init.delta

    const payload: Record<string, unknown> = {
        id: init.id,
        object: 'chat.completion.chunk',
        created: init.created,
        model: init.model,
        choices: [{ index: 0, delta, finish_reason: init.finishReason ?? null }],
    }
    if (init.usage) payload.usage = init.usage
    return sseData(payload)
}

export function sseData(payload: unknown): string {
    return `data: ${JSON.stringify(payload)}\n\n`
}

/** Comments keep proxies from closing an idle connection. */
export function sseComment(text: string): string {
    return `: ${text.replace(/\n/g, ' ')}\n\n`
}

/**
 * OpenAI clients — including RisuAI's reverse-proxy path — treat a `data:`
 * frame carrying an `error` object as a fatal stream error.
 */
export function sseError(message: string, code: string): string {
    return sseData({ error: { message, type: 'upstream_error', code } })
}

export const SSE_DONE = 'data: [DONE]\n\n'

/* ------------------------------------------------------------------ *
 * Inbound parsing
 * ------------------------------------------------------------------ */

export interface SseEvent {
    event: string | null
    data: string
    id: string | null
    retry: number | null
}

/**
 * Incremental SSE parser. Chunk boundaries from the socket land anywhere —
 * mid-line, mid-UTF8, between the `data:` and its blank terminator — so the
 * parser buffers until it sees a complete line and only dispatches on a blank
 * one. Multi-line `data:` fields are joined with `\n`, per the spec.
 */
export class SseParser {
    private buffer = ''
    private data: string[] = []
    private event: string | null = null
    private id: string | null = null
    private retry: number | null = null

    push(chunk: string): SseEvent[] {
        this.buffer += chunk
        const out: SseEvent[] = []
        for (;;) {
            const nl = this.buffer.indexOf('\n')
            if (nl < 0) break
            const line = this.buffer.slice(0, nl)
            this.buffer = this.buffer.slice(nl + 1)
            const ev = this.consume(line)
            if (ev) out.push(ev)
        }
        return out
    }

    /** Dispatches whatever survived a stream that ended without a blank line. */
    flush(): SseEvent[] {
        const out: SseEvent[] = []
        if (this.buffer) {
            const line = this.buffer
            this.buffer = ''
            const ev = this.consume(line)
            if (ev) out.push(ev)
        }
        const tail = this.dispatch()
        if (tail) out.push(tail)
        return out
    }

    private consume(rawLine: string): SseEvent | null {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
        if (line === '') return this.dispatch()
        if (line.startsWith(':')) return null

        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        let value = colon < 0 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)

        switch (field) {
            case 'data':
                this.data.push(value)
                break
            case 'event':
                this.event = value
                break
            case 'id':
                this.id = value
                break
            case 'retry': {
                const n = Number(value)
                if (Number.isFinite(n)) this.retry = n
                break
            }
        }
        return null
    }

    private dispatch(): SseEvent | null {
        if (this.data.length === 0 && this.event === null) return null
        const ev: SseEvent = {
            event: this.event,
            data: this.data.join('\n'),
            id: this.id,
            retry: this.retry,
        }
        this.data = []
        this.event = null
        this.retry = null
        return ev
    }
}

/** Reads a fetch response body as a sequence of SSE events. */
export async function* iterateSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
    const reader = body.getReader()
    const decoder = new TextDecoder('utf-8')
    const parser = new SseParser()
    try {
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) yield* parser.push(decoder.decode(value, { stream: true }))
        }
        yield* parser.push(decoder.decode())
        yield* parser.flush()
    } finally {
        try {
            await reader.cancel()
        } catch {
            // The reader is already closed or errored; nothing to release.
        }
    }
}
