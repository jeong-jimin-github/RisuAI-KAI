import { Hono } from 'hono'
import { z } from 'zod'
import {
    DAILY_LIMIT_HEADER,
    DAILY_REMAINING_HEADER,
    DAILY_RESET_HEADER,
    MINUTE_LIMIT_HEADER,
    MINUTE_REMAINING_HEADER,
    MINUTE_RESET_HEADER,
    ROUTED_VIA_HEADER,
    ROUTE_ATTEMPTS_HEADER,
    type UsageQuota,
} from '../../../shared/contract.js'
import { desc, eq } from 'drizzle-orm'
import { requireGateway } from '../auth/middleware.js'
import { db, schema } from '../db/index.js'
import { chunkFrame, sseComment, SSE_DONE, sseError } from '../llm/stream.js'
import { estimateTokens, promptLanguage, routeChat, routeChatStream } from '../llm/router.js'
import {
    proofreadApplies,
    proofreadText,
    resolveProofreadConfig,
    type ProofreadDeps,
} from '../llm/proofread.js'
import { modelRef, type ChatCompletionInput } from '../llm/types.js'
import { getRuntimeConfig } from '../services/config.js'
import { appendMessage, getOwnedChat } from '../services/chat.js'
import { takeUserQuota } from '../services/userQuota.js'
import type { KaiEnv } from '../types.js'
import { HttpError } from '../util/http.js'
import { newId } from '../util/ids.js'

const app = new Hono<KaiEnv>()

const part = z.union([
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string() }) }),
])
const bodySchema = z.object({
    model: z.string().default('auto'),
    messages: z.array(z.object({ role: z.enum(['system','user','assistant','tool','developer']), content: z.union([z.string(), z.array(part)]), name: z.string().optional() })).min(1),
    stream: z.boolean().optional(), temperature: z.number().optional(), top_p: z.number().optional(), max_tokens: z.number().int().positive().optional(),
    frequency_penalty: z.number().optional(), presence_penalty: z.number().optional(), stop: z.array(z.string()).optional(), kai_chat_id: z.string().optional(),
})

app.use('*', requireGateway)

/**
 * How often a buffered stream emits an SSE comment. Well inside the 60s idle
 * timeout of a default nginx / Cloudflare hop, and invisible to the client:
 * comment lines carry no `data:` field, so an OpenAI stream reader drops them.
 */
const KEEPALIVE_MS = 15_000

/**
 * A correction pass is one ordinary routed completion, minus everything that
 * only makes sense for a roleplay turn: no vision, no sampler settings, and a
 * short attempt budget so a corrector outage costs the turn a couple of seconds
 * rather than the whole route budget.
 */
const PROOFREAD_MAX_ATTEMPTS = 2

type RouteBase = { userId: string; chatId: string | null; signal?: AbortSignal }

function proofreader(base: RouteBase, language: string | undefined): ProofreadDeps {
    return {
        async complete(alias, messages, maxTokens) {
            const out = await routeChat(
                {
                    messages,
                    // A proofreader that samples is a proofreader that rewrites.
                    temperature: 0,
                    maxTokens,
                    estimatedTokens: estimateTokens(messages),
                    requiresVision: false,
                    requiresLanguage: language,
                },
                { ...base, alias, maxAttempts: PROOFREAD_MAX_ATTEMPTS },
            )
            return out.text
        },
        onError(alias, error) {
            console.warn(`[kai] proofread via ${alias} failed: ${error instanceof Error ? error.message : String(error)}`)
        },
    }
}

/** The pass itself. Any failure inside returns `text` unchanged. */
async function runProofread(
    text: string,
    config: ReturnType<typeof resolveProofreadConfig>,
    language: string | undefined,
    base: RouteBase,
): Promise<string> {
    const outcome = await proofreadText(text, config, language, proofreader(base, language))
    if (outcome.skipped === 'rejected' || outcome.skipped === 'failed') {
        console.warn(`[kai] proofread ${outcome.skipped}; keeping the original reply`)
    }
    return outcome.text
}

app.get('/models', (c) => {
    const rows = db.select().from(schema.routingAliases).all()
    return c.json({ object: 'list', data: rows.map((r) => ({ id: r.alias, object: 'model', created: 0, owned_by: 'risuai-kai' })) })
})

app.post('/chat/completions', async (c) => {
    const user = c.get('gatewayUser')!
    const quota = takeUserQuota(user.id)
    let raw: unknown
    try { raw = await c.req.json() } catch { throw HttpError.badRequest('Expected JSON') }
    const parsed = bodySchema.safeParse(raw)
    if (!parsed.success) throw HttpError.badRequest('Invalid OpenAI request', parsed.error.flatten())
    const b = parsed.data
    if (b.kai_chat_id) getOwnedChat(b.kai_chat_id, user.id)
    const config = await getRuntimeConfig(user)
    // RisuAI's reverse-proxy request builder can emit a provider placeholder
    // such as `gpt-3.5-turbo` even when customProxyRequestModel is configured.
    // The browser must never select an arbitrary upstream model anyway: accept
    // only aliases the admin exposed and fall back to the configured default.
    const selectableAliases = new Set([
        config.generation.modelAlias,
        ...config.generation.selectableAliases.map((item) => item.alias),
    ])
    const alias = selectableAliases.has(b.model) ? b.model : config.generation.modelAlias
    const input: ChatCompletionInput = {
        messages: b.messages,
        // A null in the admin config means "this instance does not send the
        // parameter"; the upstream input treats absent as exactly that.
        temperature: b.temperature ?? config.generation.temperature ?? undefined,
        topP: b.top_p ?? config.generation.topP ?? undefined,
        maxTokens: Math.min(b.max_tokens ?? config.generation.maxResponse, config.generation.maxResponse),
        frequencyPenalty: b.frequency_penalty ?? config.generation.frequencyPenalty ?? undefined,
        presencePenalty: b.presence_penalty ?? config.generation.presencePenalty ?? undefined,
        stop: b.stop,
        estimatedTokens: 0,
        requiresVision: b.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')),
        // The card, the persona and the history all ride in this prompt, so its
        // script is the language the reply has to come back in.
        requiresLanguage: promptLanguage(b.messages),
    }
    input.estimatedTokens = estimateTokens(input.messages)
    if (input.estimatedTokens > config.generation.maxContext) throw HttpError.badRequest('Prompt exceeds the configured context window')

    const opts = { alias, userId: user.id, chatId: b.kai_chat_id ?? null, signal: b.kai_chat_id ? undefined : c.req.raw.signal }
    const proofread = resolveProofreadConfig(config.generation.proofread)
    if (!b.stream) {
        const out = await routeChat(input, opts)
        const text = proofreadApplies(proofread, modelRef(out.model), input.requiresLanguage)
            ? await runProofread(out.text, proofread, input.requiresLanguage, opts)
            : out.text
        c.header(ROUTED_VIA_HEADER, out.routedVia)
        c.header(ROUTE_ATTEMPTS_HEADER, String(out.attempts.length))
        applyQuotaHeaders((name, value) => c.header(name, value), quota)
        return c.json({ id: newId('chatcmpl_'), object: 'chat.completion', created: Math.floor(Date.now()/1000), model: out.routedVia, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: out.finishReason }], usage: { prompt_tokens: out.usage.promptTokens, completion_tokens: out.usage.completionTokens, total_tokens: out.usage.totalTokens } })
    }

    const routed = await routeChatStream(input, { ...opts, requireStreaming: true })
    const id = newId('chatcmpl_'), created = Math.floor(Date.now()/1000), encoder = new TextEncoder()
    // A correction rewrites the whole reply, so on this path the deltas cannot
    // go out as they arrive: once text is on the wire there is no way to retract
    // it, and OpenAI's stream format has no "replace" frame. For the models that
    // need the pass the reply is buffered instead and sent once, corrected.
    const correcting = proofreadApplies(proofread, modelRef(routed.model), input.requiresLanguage)
    let fullAssistantText = ''
    let clientDisconnected = false

    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const send = (frame: string) => {
                if (clientDisconnected) return
                try {
                    controller.enqueue(encoder.encode(frame))
                } catch {
                    clientDisconnected = true
                }
            }
            send(chunkFrame({ id, model: routed.routedVia, created, role: 'assistant' }))
            // Buffering emits nothing for as long as the turn takes to generate,
            // and an idle connection is what a reverse proxy closes first.
            const keepalive = correcting
                ? setInterval(() => send(sseComment('kai-proofread')), KEEPALIVE_MS)
                : null

            try {
                for await (const delta of routed.stream) {
                    fullAssistantText += delta
                    if (!correcting) send(chunkFrame({ id, model: routed.routedVia, created, delta }))
                }

                if (correcting) {
                    fullAssistantText = await runProofread(fullAssistantText, proofread, input.requiresLanguage, opts)
                    if (fullAssistantText) send(chunkFrame({ id, model: routed.routedVia, created, delta: fullAssistantText }))
                }

                if (!clientDisconnected) {
                    try {
                        const usage = routed.state.usage
                        controller.enqueue(encoder.encode(chunkFrame({ id, model: routed.routedVia, created, finishReason: 'stop', usage: usage ? { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens } : undefined })))
                        controller.enqueue(encoder.encode(SSE_DONE))
                        controller.close()
                    } catch {
                        clientDisconnected = true
                    }
                }
            } catch (e) {
                if (!clientDisconnected) {
                    try {
                        controller.enqueue(encoder.encode(sseError(e instanceof Error ? e.message : String(e), 'upstream_unavailable')))
                        controller.enqueue(encoder.encode(SSE_DONE))
                        controller.close()
                    } catch {
                        // ignore
                    }
                }
            } finally {
                if (keepalive) clearInterval(keepalive)
                // If client was disconnected mid-stream and we have a valid chatId,
                // persist completed message to chat DB so reloads don't lose the generation.
                if (b.kai_chat_id && clientDisconnected && fullAssistantText.trim()) {
                    try {
                        const last = db.select().from(schema.messages).where(eq(schema.messages.chatId, b.kai_chat_id)).orderBy(desc(schema.messages.idx)).limit(1).get()
                        if (!last || last.role !== 'char' || last.content !== fullAssistantText) {
                            appendMessage(b.kai_chat_id, {
                                role: 'char',
                                content: fullAssistantText,
                                model: routed.routedVia,
                            })
                        }
                    } catch {
                        // ignore persistence errors in cleanup
                    }
                }
            }
        },
    })
    const quotaHeaders: Record<string, string> = {}
    applyQuotaHeaders((name, value) => { quotaHeaders[name] = value }, quota)
    return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', [ROUTED_VIA_HEADER]: routed.routedVia, [ROUTE_ATTEMPTS_HEADER]: String(routed.attempts.length), ...quotaHeaders } })
})

function applyQuotaHeaders(set: (name: string, value: string) => void, quota: UsageQuota) {
    set(MINUTE_LIMIT_HEADER, String(quota.minute.limit))
    set(MINUTE_REMAINING_HEADER, String(quota.minute.remaining))
    if (quota.minute.resetAt) set(MINUTE_RESET_HEADER, quota.minute.resetAt)
    set(DAILY_LIMIT_HEADER, String(quota.daily.limit))
    set(DAILY_REMAINING_HEADER, String(quota.daily.remaining))
    if (quota.daily.resetAt) set(DAILY_RESET_HEADER, quota.daily.resetAt)
}

export default app
