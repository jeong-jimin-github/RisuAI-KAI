import { env } from '../env.js'
import { db, schema } from '../db/index.js'
import { newId } from '../util/ids.js'
import { HttpError } from '../util/http.js'
import { getLatestOmniRouteModel } from '../services/omniroute.js'
import type { ChatCompletionInput, ErrorClass, RouteAttempt, RouteOptions, RouteOutcome, RoutedStream, Usage } from './types.js'

export function recordUsageLog(entry: {
    userId?: string | null
    chatId?: string | null
    providerKey: string
    upstreamModel: string
    alias?: string
    tokensIn?: number
    tokensOut?: number
    latencyMs: number
    attempts?: number
    status: string
    errorClass?: string | null
}) {
    try {
        db.insert(schema.usageLog).values({
            id: newId('log_'),
            userId: entry.userId ?? null,
            chatId: entry.chatId ?? null,
            providerKey: entry.providerKey,
            upstreamModel: entry.upstreamModel,
            alias: entry.alias ?? '',
            tokensIn: entry.tokensIn ?? 0,
            tokensOut: entry.tokensOut ?? 0,
            latencyMs: entry.latencyMs,
            attempts: entry.attempts ?? 1,
            status: entry.status,
            errorClass: entry.errorClass ?? null,
            createdAt: Date.now(),
        }).run()
    } catch (e) {
        console.warn('[usageLog] failed to record log:', e)
    }
}

/** An error from an upstream HTTP call (here: the OmniRoute sidecar). */
export class UpstreamError extends Error {
    status: number
    body: string
    retryAfterMs: number | null
    constructor(status: number, body: string, retryAfterMs: number | null = null) {
        super(`upstream ${status}: ${body.slice(0, 200)}`)
        this.status = status
        this.body = body
        this.retryAfterMs = retryAfterMs
    }
}

function isAbortError(e: unknown): boolean {
    return e instanceof DOMException && e.name === 'AbortError'
}

export function estimateTokens(messages: ChatCompletionInput['messages']): number {
    let chars = 0
    for (const m of messages) chars += typeof m.content === 'string' ? m.content.length : m.content.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 1000), 0)
    return Math.max(1, Math.ceil(chars / 3.5))
}

/**
 * The language the reply has to be in, read off the whole prompt — card,
 * persona and history included, since all three shape what comes back.
 * Kept for compatibility with gateway.ts; OmniRoute handles language routing internally.
 */
export function promptLanguage(_messages: ChatCompletionInput['messages']): string | undefined {
    return undefined
}

function classify(e: unknown): { status: number | null; kind: ErrorClass; message: string; retry: number | null } {
    if (e instanceof UpstreamError) {
        const s = e.status
        const kind: ErrorClass = s === 429 ? 'rate_limited' : s === 401 || s === 403 ? 'auth' : s === 408 ? 'timeout' : s === 400 && /context/i.test(e.body) ? 'context_length' : s >= 500 ? 'server' : s === 0 ? 'network' : 'unknown'
        return { status: s || null, kind, message: e.body.slice(0, 500), retry: e.retryAfterMs }
    }
    return { status: null, kind: 'unknown', message: e instanceof Error ? e.message : String(e), retry: null }
}

const mockResolvedModel = (alias: string) => ({
    id: alias,
    providerKey: 'omniroute',
    upstreamModel: alias,
    displayName: alias,
    enabled: true,
    tier: 'balanced' as const,
    priority: 100,
    contextLength: 128_000,
    maxOutput: 8192,
    supportsStreaming: true,
    supportsVision: true,
    supportsTools: false,
    languages: [] as string[],
    notes: 'OmniRoute',
    provider: {
        id: 'omniroute',
        key: 'omniroute',
        kind: 'openai_compatible' as const,
        label: 'OmniRoute',
        baseUrl: env.omnirouteUrl,
        auth: 'bearer' as const,
        apiKey: env.omnirouteApiKey,
        authHeaderName: null,
        enabled: true,
        priority: 100,
        rpm: null,
        rpd: null,
        concurrency: 4,
        timeoutMs: 120_000,
        notes: '',
    },
})

async function fetchOmniRoute(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const url = `${env.omnirouteUrl}${path}`
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> || {}),
    }
    if (env.omnirouteApiKey) {
        headers['Authorization'] = `Bearer ${env.omnirouteApiKey}`
    }
    try {
        const res = await fetch(url, {
            ...init,
            headers,
            signal,
        })
        if (!res.ok) {
            const body = await res.text().catch(() => '')
            throw new UpstreamError(res.status, body || `OmniRoute returned ${res.status}`)
        }
        return res
    } catch (e) {
        if (e instanceof UpstreamError) throw e
        if (isAbortError(e)) throw e
        throw new UpstreamError(500, `OmniRoute connection failed: ${e instanceof Error ? e.message : String(e)}`)
    }
}

function toOpenAIBody(input: ChatCompletionInput, stream: boolean) {
    return {
        messages: input.messages.map((m) => ({
            role: m.role,
            content: m.content,
            ...(m.name ? { name: m.name } : {}),
        })),
        temperature: input.temperature,
        top_p: input.topP,
        max_tokens: input.maxTokens,
        frequency_penalty: input.frequencyPenalty,
        presence_penalty: input.presencePenalty,
        stop: input.stop,
        stream,
    }
}

function usageFromResult(result: any, input: ChatCompletionInput, fallbackText: string): Usage {
    if (result?.usage) {
        return {
            promptTokens: result.usage.prompt_tokens ?? input.estimatedTokens,
            completionTokens: result.usage.completion_tokens ?? Math.ceil(fallbackText.length / 3.5),
            totalTokens: result.usage.total_tokens ?? (input.estimatedTokens + Math.ceil(fallbackText.length / 3.5)),
        }
    }
    return {
        promptTokens: input.estimatedTokens,
        completionTokens: Math.ceil(fallbackText.length / 3.5),
        totalTokens: input.estimatedTokens + Math.ceil(fallbackText.length / 3.5),
    }
}

function makeAttempt(modelId: string, ok: boolean, latencyMs: number, status: number | null, errorClass: ErrorClass | null, message: string | null): RouteAttempt {
    return { modelId, providerKey: 'omniroute', upstreamModel: modelId, ok, latencyMs, status, errorClass, message }
}

function extractRoutedVia(res: Response, fallback: string): string {
    const providerHeader = res.headers.get('x-omniroute-provider') || res.headers.get('x-provider')
    const modelHeader = res.headers.get('x-omniroute-model') || res.headers.get('x-model') || res.headers.get('x-upstream-model') || res.headers.get('x-selected-model') || res.headers.get('x-target-model') || res.headers.get('x-actual-model')
    const routedViaHeader = res.headers.get('x-routed-via') || res.headers.get('x-omniroute-routed-via')
    if (routedViaHeader && routedViaHeader !== 'omniroute/auto' && routedViaHeader !== 'auto') return routedViaHeader
    if (providerHeader && modelHeader && modelHeader !== 'auto' && modelHeader !== 'omniroute/auto') return `${providerHeader}/${modelHeader}`
    if (modelHeader && modelHeader !== 'auto' && modelHeader !== 'omniroute/auto') return modelHeader
    if (providerHeader && providerHeader !== 'omniroute' && providerHeader !== 'auto') return providerHeader
    return fallback
}

export async function routeChat(input: ChatCompletionInput, opts: RouteOptions): Promise<RouteOutcome> {
    if (!env.omnirouteUrl) {
        throw HttpError.internal('OmniRoute is not configured. Set KAI_OMNIROUTE_URL.')
    }

    const model = mockResolvedModel(opts.alias)
    const started = Date.now()
    try {
        const res = await fetchOmniRoute('/v1/chat/completions', {
            method: 'POST',
            body: JSON.stringify({ model: 'auto', ...toOpenAIBody(input, false) }),
        }, opts.signal)
        const json: any = await res.json()
        const latency = Date.now() - started
        const text = json.choices?.[0]?.message?.content ?? ''
        const usage = usageFromResult(json, input, text)
        const jsonModel = json.model && json.model !== 'auto' && json.model !== 'omniroute/auto' ? json.model : null
        let routedVia = jsonModel || extractRoutedVia(res, `omniroute/${opts.alias || 'auto'}`)
        if (!routedVia || routedVia === 'omniroute/auto' || routedVia === 'auto' || routedVia === 'omniroute') {
            const latest = getLatestOmniRouteModel()
            if (latest) routedVia = latest
        }
        const parts = routedVia.split('/')
        recordUsageLog({
            userId: opts.userId,
            chatId: opts.chatId,
            providerKey: parts[0] || 'omniroute',
            upstreamModel: parts[1] || opts.alias || 'auto',
            alias: opts.alias,
            tokensIn: usage.promptTokens,
            tokensOut: usage.completionTokens,
            latencyMs: latency,
            status: 'ok',
        })
        return {
            alias: opts.alias,
            model,
            text,
            usage,
            finishReason: json.choices?.[0]?.finish_reason ?? 'stop',
            routedVia,
            latencyMs: latency,
            attempts: [makeAttempt(opts.alias, true, latency, 200, null, null)],
        }
    } catch (e) {
        if (isAbortError(e)) throw e
        const latency = Date.now() - started
        const info = classify(e)
        recordUsageLog({
            userId: opts.userId,
            chatId: opts.chatId,
            providerKey: 'omniroute',
            upstreamModel: opts.alias || 'auto',
            alias: opts.alias,
            latencyMs: latency,
            status: 'error',
            errorClass: info.kind,
        })
        const attempts = [makeAttempt(opts.alias, false, latency, info.status, info.kind, info.message)]
        throw HttpError.upstream(`OmniRoute: ${info.message}`, { attempts })
    }
}

export async function routeChatStream(input: ChatCompletionInput, opts: RouteOptions): Promise<RoutedStream> {
    if (!env.omnirouteUrl) {
        throw HttpError.internal('OmniRoute is not configured. Set KAI_OMNIROUTE_URL.')
    }

    const model = mockResolvedModel(opts.alias)
    const started = Date.now()
    const res = await fetchOmniRoute('/v1/chat/completions', {
        method: 'POST',
        headers: { Accept: 'text/event-stream' },
        body: JSON.stringify({ model: 'auto', ...toOpenAIBody(input, true) }),
    }, opts.signal)

    let initialRoutedVia = extractRoutedVia(res, `omniroute/${opts.alias || 'auto'}`)
    if (!initialRoutedVia || initialRoutedVia === 'omniroute/auto' || initialRoutedVia === 'auto' || initialRoutedVia === 'omniroute') {
        const latest = getLatestOmniRouteModel()
        if (latest) initialRoutedVia = latest
    }
    let actualRoutedVia = initialRoutedVia
    const reader = res.body?.getReader()
    if (!reader) throw new UpstreamError(502, 'OmniRoute stream had no body')

    const state = { text: '', usage: null as Usage | null, finished: false, error: null as string | null }
    const successfulAttempt = makeAttempt(opts.alias, true, Date.now() - started, 200, null, null)

    const stream = (async function* () {
        const decoder = new TextDecoder()
        let buffer = ''
        try {
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })
                let nlIdx: number
                while ((nlIdx = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, nlIdx).trimEnd()
                    buffer = buffer.slice(nlIdx + 1)
                    if (!line.startsWith('data:')) continue
                    const data = line.slice(5).trim()
                    if (data === '[DONE]') continue
                    let parsed: any
                    try { parsed = JSON.parse(data) } catch { continue }
                    if (parsed.model && parsed.model !== 'auto' && parsed.model !== 'omniroute/auto') {
                        actualRoutedVia = parsed.model
                    } else if (parsed.provider && parsed.model && parsed.model !== 'auto') {
                        actualRoutedVia = `${parsed.provider}/${parsed.model}`
                    }
                    const delta = parsed.choices?.[0]?.delta?.content
                    if (delta) {
                        state.text += delta
                        yield delta
                    }
                    if (parsed.choices?.[0]?.finish_reason) {
                        state.finished = true
                        if (parsed.usage) {
                            state.usage = {
                                promptTokens: parsed.usage.prompt_tokens ?? input.estimatedTokens,
                                completionTokens: parsed.usage.completion_tokens ?? Math.ceil(state.text.length / 3.5),
                                totalTokens: parsed.usage.total_tokens ?? (input.estimatedTokens + Math.ceil(state.text.length / 3.5)),
                            }
                        }
                    }
                }
            }
            if (!state.text.trim()) throw new UpstreamError(502, 'empty streamed completion from OmniRoute')
            state.finished = true
            if (!actualRoutedVia || actualRoutedVia === 'omniroute/auto' || actualRoutedVia === 'auto' || actualRoutedVia === 'omniroute') {
                const latest = getLatestOmniRouteModel()
                if (latest) actualRoutedVia = latest
            }
            state.usage ??= {
                promptTokens: input.estimatedTokens,
                completionTokens: Math.ceil(state.text.length / 3.5),
                totalTokens: input.estimatedTokens + Math.ceil(state.text.length / 3.5),
            }
            const parts = actualRoutedVia.split('/')
            recordUsageLog({
                userId: opts.userId,
                chatId: opts.chatId,
                providerKey: parts[0] || 'omniroute',
                upstreamModel: parts[1] || parts[0] || opts.alias || 'auto',
                alias: opts.alias,
                tokensIn: state.usage.promptTokens,
                tokensOut: state.usage.completionTokens,
                latencyMs: Date.now() - started,
                status: 'ok',
            })
        } catch (e) {
            state.error = e instanceof Error ? e.message : String(e)
            successfulAttempt.ok = false
            const info = classify(e)
            successfulAttempt.status = info.status
            successfulAttempt.errorClass = info.kind
            successfulAttempt.message = info.message
            state.usage ??= {
                promptTokens: input.estimatedTokens,
                completionTokens: Math.ceil(state.text.length / 3.5),
                totalTokens: input.estimatedTokens + Math.ceil(state.text.length / 3.5),
            }
            const parts = actualRoutedVia.split('/')
            recordUsageLog({
                userId: opts.userId,
                chatId: opts.chatId,
                providerKey: parts[0] || 'omniroute',
                upstreamModel: parts[1] || parts[0] || opts.alias || 'auto',
                alias: opts.alias,
                tokensIn: state.usage.promptTokens,
                tokensOut: state.usage.completionTokens,
                latencyMs: Date.now() - started,
                status: 'error',
                errorClass: info.kind,
            })
            throw e
        }
    })()

    return {
        alias: opts.alias,
        model,
        get routedVia() { return actualRoutedVia },
        attempts: [successfulAttempt],
        stream,
        state,
    }
}
