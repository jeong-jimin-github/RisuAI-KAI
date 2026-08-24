/**
 * Internal routing types.
 *
 * Nothing here crosses the network boundary — the contract owns that. These are
 * the shapes the router, the health tracker and the provider adapters pass
 * between themselves, with provider API keys already decrypted.
 */

import type {
    GatewayContentPart,
    Id,
    ModelTier,
    ProviderAuth,
    ProviderKind,
} from '../../../shared/contract.js'

/* ------------------------------------------------------------------ *
 * Resolved database rows
 * ------------------------------------------------------------------ */

/** A `providers` row with its API key decrypted. Never serialised to a client. */
export interface ResolvedProvider {
    id: Id
    key: string
    kind: ProviderKind
    label: string
    baseUrl: string
    auth: ProviderAuth
    /** Plaintext key, or null for the keyless free providers. */
    apiKey: string | null
    authHeaderName: string | null
    enabled: boolean
    /** Higher wins, matching `RoutedModel.priority`. */
    priority: number
    rpm: number | null
    rpd: number | null
    concurrency: number
    timeoutMs: number
}

/** A `routed_models` row joined with its owning provider. */
export interface ResolvedModel {
    id: Id
    providerKey: string
    upstreamModel: string
    displayName: string
    enabled: boolean
    tier: ModelTier
    priority: number
    contextLength: number
    maxOutput: number
    supportsStreaming: boolean
    supportsVision: boolean
    supportsTools: boolean
    /** Measured-good languages, BCP-47 primary subtags. Empty = unverified. */
    languages: string[]
    notes: string
    provider: ResolvedProvider
}

/** `provider/model` — the stable human-facing name for a routed model. */
export function modelRef(m: ResolvedModel): string {
    return `${m.providerKey}/${m.upstreamModel}`
}

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

/** Everything the catalog needs to seed one `routed_models` row. */
export interface DiscoveredModel {
    upstreamModel: string
    displayName: string
    /**
     * Adapter's guess, set only when the upstream advertises something the
     * adapter can map directly. The catalog falls back to `tierFor()`, which is
     * where the heuristic table lives.
     */
    tier?: ModelTier
    contextLength: number
    maxOutput: number
    supportsStreaming: boolean
    supportsVision: boolean
    supportsTools: boolean
    /** Upstream's "this model thinks before answering" flag; feeds `tierFor`. */
    reasoning?: boolean
    description?: string
}

/* ------------------------------------------------------------------ *
 * Chat
 * ------------------------------------------------------------------ */

export interface NormalisedMessage {
    role: 'system' | 'user' | 'assistant' | 'tool' | 'developer'
    content: string | GatewayContentPart[]
    name?: string
}

/** Provider-agnostic completion request, already clamped by the gateway. */
export interface ChatCompletionInput {
    messages: NormalisedMessage[]
    temperature?: number
    topP?: number
    maxTokens?: number
    frequencyPenalty?: number
    presencePenalty?: number
    stop?: string[]
    /** Conservative prompt-size estimate; see `estimateTokens` in router.ts. */
    estimatedTokens: number
    /** True when any message carries an image part. */
    requiresVision: boolean
    /**
     * Language the reply needs to be in, detected from the prompt's script by
     * `detectLanguage`. Undefined for Latin-script prompts, where every model
     * is adequate and the ranking has nothing to add.
     */
    requiresLanguage?: string
}

export interface Usage {
    promptTokens: number
    completionTokens: number
    totalTokens: number
}

export interface ChatResult {
    text: string
    usage?: Usage
    finishReason?: string
    /**
     * The sidecar routers (freellmapi) report the platform/model they picked in
     * an `x-routed-via` header; we forward it so the UI shows the real model.
     */
    routedVia?: string
    raw?: unknown
}

export interface StreamChunk {
    delta: string
    usage?: Usage
    finishReason?: string
    routedVia?: string
}

/* ------------------------------------------------------------------ *
 * Routing
 * ------------------------------------------------------------------ */

export type ErrorClass =
    | 'rate_limited'
    | 'auth'
    | 'context_length'
    | 'server'
    | 'network'
    | 'timeout'
    | 'content_filter'
    | 'unknown'

export interface RouteAttempt {
    modelId: Id
    providerKey: string
    upstreamModel: string
    ok: boolean
    latencyMs: number
    status: number | null
    errorClass: ErrorClass | null
    message: string | null
}

export interface RouteOutcome {
    alias: string
    model: ResolvedModel
    text: string
    usage: Usage
    finishReason: string
    routedVia: string
    latencyMs: number
    attempts: RouteAttempt[]
}

export interface RouteOptions {
    /** Routing alias, a routed-model id, or a `provider/model` pin. */
    alias: string
    userId?: string | null
    chatId?: string | null
    /** Aborts the upstream request when the client disconnects. */
    signal?: AbortSignal
    maxAttempts?: number
    /** Restrict candidates to models that can stream. */
    requireStreaming?: boolean
}

/** Live view of an in-flight streamed completion. */
export interface RoutedStream {
    alias: string
    model: ResolvedModel
    routedVia: string
    /** Attempts made before the first delta arrived. */
    attempts: RouteAttempt[]
    /**
     * Deltas in order, starting with the one that proved the connection. Throws
     * if the upstream dies mid-sentence — by then we are committed to a model.
     */
    stream: AsyncIterable<string>
    /** Mutated as the stream is consumed; final once `finished` is true. */
    state: { text: string; usage: Usage | null; finished: boolean; error: string | null }
}

/* ------------------------------------------------------------------ *
 * Adapters
 * ------------------------------------------------------------------ */

export interface ProviderAdapter {
    kind: ProviderKind
    listModels(p: ResolvedProvider, signal?: AbortSignal): Promise<DiscoveredModel[]>
    chat(m: ResolvedModel, input: ChatCompletionInput, signal?: AbortSignal): Promise<ChatResult>
    chatStream(
        m: ResolvedModel,
        input: ChatCompletionInput,
        signal?: AbortSignal,
    ): AsyncIterable<StreamChunk>
}
