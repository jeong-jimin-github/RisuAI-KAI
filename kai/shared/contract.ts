/**
 * RisuAI-KAI — shared contract between server (`kai/server`) and client (`src/kai`).
 *
 * This file is the single source of truth for every payload that crosses the
 * network boundary. Both sides import it directly; nothing here may import from
 * either side, and nothing here may pull in a runtime dependency.
 */

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

export type ISODate = string
export type Id = string

export interface Paged<T> {
    items: T[]
    total: number
    page: number
    pageSize: number
}

export type ApiOk<T> = { ok: true; data: T }
export type ApiErr = { ok: false; error: { code: ApiErrorCode; message: string; detail?: unknown } }
export type ApiResult<T> = ApiOk<T> | ApiErr

export const ApiErrorCodes = [
    'bad_request',
    'unauthorized',
    'forbidden',
    'not_found',
    'conflict',
    'rate_limited',
    'payload_too_large',
    'unsupported_media',
    'upstream_unavailable',
    'internal',
] as const
export type ApiErrorCode = (typeof ApiErrorCodes)[number]

/* ------------------------------------------------------------------ *
 * Administrative server status
 * ------------------------------------------------------------------ */

export interface TemperatureSensor {
    name: string
    temperatureC: number
}

export interface SystemStatus {
    sampledAt: ISODate
    cpu: {
        usagePct: number | null
        cores: number
        loadAverage: [number, number, number]
    }
    memory: {
        totalBytes: number
        usedBytes: number
        availableBytes: number
        usedPct: number
        processRssBytes: number
        processHeapUsedBytes: number
    }
    disk: {
        totalBytes: number
        usedBytes: number
        availableBytes: number
        usedPct: number
    } | null
    uptime: {
        systemSeconds: number
        processSeconds: number
    }
    temperatures: {
        highestC: number | null
        cpuC: number | null
        gpuC: number | null
        batteryC: number | null
        sensors: TemperatureSensor[]
    }
    battery: {
        available: boolean
        source: 'termux-api' | 'sysfs' | 'thermal' | 'unavailable'
        levelPct: number | null
        status: string | null
        health: string | null
        plugged: string | null
        temperatureC: number | null
        voltageV: number | null
        currentMa: number | null
    }
}

/* ------------------------------------------------------------------ *
 * Users / auth
 * ------------------------------------------------------------------ */

export type UserRole = 'user' | 'admin'
export type UserStatus = 'active' | 'suspended' | 'pending'

export interface PublicUser {
    id: Id
    email: string
    displayName: string
    avatarUrl: string | null
    role: UserRole
    status: UserStatus
    createdAt: ISODate
}

export interface RegisterBody {
    email: string
    password: string
    displayName: string
    inviteCode?: string
}

export interface LoginBody {
    email: string
    password: string
}

export interface SessionInfo {
    user: PublicUser
    /**
     * Opaque bearer token the RisuAI engine sends to the gateway as `proxyKey`.
     * Rotatable; scoped to LLM inference only, never to admin routes.
     */
    gatewayToken: string
    expiresAt: ISODate
}

/* ------------------------------------------------------------------ *
 * Characters
 * ------------------------------------------------------------------ */

export type CharacterVisibility = 'public' | 'private'
export type CardSourceFormat = 'risu_charx' | 'ccv3_png' | 'ccv2_png' | 'ccv3_json' | 'ccv2_json' | 'kai_native'

/** Card summary — what the gallery renders. Never contains the full card JSON. */
export interface CharacterSummary {
    id: Id
    slug: string
    name: string
    /** Public description shown consistently in gallery previews and details. */
    description: string
    tagline: string
    creatorName: string
    avatarUrl: string | null
    tags: string[]
    nsfw: boolean
    visibility: CharacterVisibility
    featured: boolean
    chatCount: number
    messageCount: number
    likeCount: number
    liked?: boolean
    createdAt: ISODate
    updatedAt: ISODate
}

/** Everything the client needs to open a chat with a character. */
export interface CharacterDetail extends CharacterSummary {
    /** Original creator-notes field retained for the chat info panel. */
    creatorNotes: string
    /** Greeting variants the user may switch between in the chat opening. */
    greetings: { index: number; name: string; preview: string }[]
    /**
     * The RisuAI `character` object, verbatim, so the client engine can run the
     * unmodified prompt pipeline (CBS, lorebook, triggers, regex scripts).
     * Server strips fields the client must not control (see `SANITIZED_CARD_KEYS`).
     */
    card: Record<string, unknown>
    /** Assets referenced by the card, resolved to servable URLs. */
    assets: Record<string, string>
}

/** Card fields the server always strips before handing a card to a client. */
export const SANITIZED_CARD_KEYS = [
    'chats',
    'chatFolders',
    'chatPage',
    'oaiTTSConfig',
    'gptSoVitsConfig',
    'fishSpeechConfig',
] as const

export interface CharacterListQuery {
    q?: string
    tag?: string
    sort?: 'trending' | 'newest' | 'popular' | 'name'
    nsfw?: boolean
    /** Restrict results to cards registered by the signed-in user. */
    mine?: boolean
    /** Restrict results to cards bookmarked by the signed-in user. */
    liked?: boolean
    page?: number
    pageSize?: number
}

export interface CharacterImportResult {
    character: CharacterSummary
    format: CardSourceFormat
    warnings: string[]
    assetCount: number
}

/** Fields exposed by the ordinary, prompt-first character studio. */
export interface CharacterCreateBody {
    name: string
    description: string
    scenario: string
    firstMessage: string
    systemPrompt: string
}

/** Browse orders offered by the public Realm hub. */
export type RealmBrowseSort = 'downloads' | 'trending' | 'recent' | 'recommended' | 'random'

export const REALM_BROWSE_SORTS: RealmBrowseSort[] = ['downloads', 'trending', 'recent', 'recommended', 'random']

export interface RealmBrowseQuery {
    sort?: RealmBrowseSort
    /** Free-text query passed to Realm's own search. */
    search?: string
    page?: number
    nsfw?: boolean
}

/** A public Realm result, proxied by the server so the admin never has to copy ids. */
export interface RealmCharacterSummary {
    id: string
    name: string
    creatorName: string
    description: string
    imageUrl: string | null
    /** Realm's own download label, e.g. `783.6k`. */
    downloads: string
    tags: string[]
    rank: number
    imported: boolean
}

export interface RealmBatchImportResult {
    imported: CharacterSummary[]
    skipped: { id: string; reason: string }[]
    failed: { id: string; message: string }[]
}

/* ------------------------------------------------------------------ *
 * Personas
 * ------------------------------------------------------------------ */

export interface Persona {
    id: Id
    name: string
    prompt: string
    avatarUrl: string | null
    isDefault: boolean
    createdAt: ISODate
}

export interface PersonaUpsertBody {
    name: string
    prompt: string
    isDefault?: boolean
}

/* ------------------------------------------------------------------ *
 * Chats
 * ------------------------------------------------------------------ */

export type MessageRole = 'user' | 'char'

export interface ChatMessage {
    id: Id
    idx: number
    role: MessageRole
    /** Raw message text, pre-CBS. The client engine renders it. */
    content: string
    name: string | null
    time: number
    /** Alternate generations for this slot; index 0 is `content`. */
    swipes?: string[]
    swipeIndex?: number
    model: string | null
    disabled: boolean
}

export interface ChatSummary {
    id: Id
    characterId: Id
    characterName: string
    characterAvatarUrl: string | null
    personaId: Id | null
    title: string
    lastMessagePreview: string
    messageCount: number
    pinned: boolean
    createdAt: ISODate
    updatedAt: ISODate
}

export interface ChatDetail extends ChatSummary {
    messages: ChatMessage[]
    /**
     * Opaque per-chat engine state (RisuAI `Chat.scriptstate`, memory blobs,
     * chat variables). Round-tripped verbatim so triggers keep working.
     */
    engineState: Record<string, unknown>
}

export interface ChatCreateBody {
    characterId: Id
    personaId?: Id
    /** Retained for API compatibility; the KAI UI starts with the default greeting. */
    greetingIndex?: number
}

export interface ChatGreetingBody {
    greetingIndex: number
}

export interface MessageAppendBody {
    role: MessageRole
    content: string
    name?: string
    model?: string
    /** Replace the message at this index instead of appending. */
    replaceIdx?: number
    engineState?: Record<string, unknown>
}

/** One fixed-window allowance exposed to the signed-in client. */
export interface UsageAllowance {
    limit: number
    remaining: number
    /** Null until this window has been used at least once. */
    resetAt: ISODate | null
}

/** Current per-user gateway allowance. */
export interface UsageQuota {
    minute: UsageAllowance
    daily: UsageAllowance
}

/** Data shown by the usage button on the chat screen. */
export interface ClientUsageStatus {
    /** Most recent upstream model used by this account, if any. */
    lastModel: string | null
    /** All successful and failed generations recorded for this account. */
    lifetime: {
        requests: number
        inputTokens: number
        outputTokens: number
        totalTokens: number
    }
    quota: UsageQuota
}

/* ------------------------------------------------------------------ *
 * Runtime config — server → client, delivered at boot
 * ------------------------------------------------------------------ */

/**
 * Everything the admin controls that the client must obey. The client engine
 * writes this into its RisuAI `Database` at startup and exposes no UI to edit
 * any of it. Refetched on login and whenever the server bumps `revision`.
 */
export interface RuntimeConfig {
    revision: number
    site: SiteConfig
    generation: GenerationConfig
    gateway: GatewayConfig
    features: FeatureFlags
    plugins: ClientPlugin[]
    /**
     * RisuAI modules the admin enabled, verbatim. The client puts them in
     * `db.modules` and lists their ids in `db.enabledModules`, which is where
     * the engine looks for display scripts, triggers and module lorebooks.
     * Many shared presets do nothing visible without their matching module.
     */
    modules: Record<string, unknown>[]
    /**
     * Chosen values for the toggles a preset or module declares, already keyed
     * as `toggle_<key>`. The client merges these into `globalChatVariables`,
     * which is where the preset's own CBS reads them from.
     */
    toggleVariables: Record<string, string>
    /** RisuAI `botPreset` fragment applied over the engine defaults. */
    preset: Record<string, unknown>
}

export interface SiteConfig {
    name: string
    tagline: string
    logoUrl: string | null
    faviconUrl: string | null
    accentColor: string
    defaultLocale: 'ko' | 'en' | 'ja'
    registrationOpen: boolean
    inviteOnly: boolean
    nsfwAllowed: boolean
    termsUrl: string | null
    privacyUrl: string | null
}

export interface GenerationConfig {
    /** Admin-selected routing alias, e.g. `auto`, `auto:fast`, `auto:smart`. */
    modelAlias: string
    /** Aliases the user is allowed to switch between; empty = no choice at all. */
    selectableAliases: { alias: string; label: string; description: string }[]
    maxContext: number
    maxResponse: number
    /**
     * These four are `number | null` for the same reason as the samplers below:
     * shared presets routinely turn top-p and the penalties *off* rather than
     * setting them to zero, and forcing a value back on would override what the
     * preset author tuned.
     */
    temperature: number | null
    topP: number | null
    frequencyPenalty: number | null
    presencePenalty: number | null
    streaming: boolean
    /** Hard ceiling on messages kept in the prompt window. */
    maxHistoryMessages: number

    /**
     * The rest of RisuAI's sampler knobs — the ones a desktop RisuAI user tunes
     * from the chat screen. KAI users have no settings UI, so the admin owns
     * them for everyone.
     *
     * `null` means "do not send this parameter at all", which the engine spells
     * as its `-1000` sentinel. That is not the same as sending 0: a provider
     * that rejects an unsupported field will fail the request outright, so
     * leaving a knob unset has to stay possible.
     */
    topK: number | null
    minP: number | null
    topA: number | null
    repetitionPenalty: number | null
    /** -1 minimal/none, 0 low, 1 medium, 2 high, 3 xhigh. */
    reasoningEffort: number
    /** 0 low, 1 medium, 2 high. */
    verbosity: number
    /** Thinking-token budget for models that take one; 0 disables. */
    thinkingTokens: number
    /** Fixed sampling seed, or null to let the provider choose. */
    seed: number | null

    /** RisuAI `promptPreprocess` — run the prompt through the preprocessor. */
    promptPreprocess: boolean
    /** RisuAI `jailbreakToggle` — append the preset's jailbreak prompt. */
    jailbreakToggle: boolean
    /** RisuAI `chainOfThought` — ask the model to think before answering. */
    chainOfThought: boolean

    /** Post-generation grammar pass for the Chinese-origin models. */
    proofread: ProofreadConfig
}

/**
 * A second model rewrites the reply before the user sees it.
 *
 * This exists for one measured failure mode, not as a general quality knob:
 * GLM and DeepSeek answer a Korean prompt in Korean, but drop Han characters
 * into it and bend the grammar toward Chinese word order. The fix is a cheap
 * pass by a model that is fluent in the target language.
 *
 * It costs a full extra completion and, on the streaming path, delays the reply
 * until the whole turn has been generated — so it is scoped by model, not
 * applied to everything.
 */
export interface ProofreadConfig {
    enabled: boolean
    /**
     * Lower-cased substrings matched against `provider/model`. A model is
     * proofread when any of them occurs in its reference — `glm` catches both
     * `nvidia/z-ai/glm-5.2` and `bedrock/zai.glm-5`.
     */
    models: string[]
    /**
     * Routing aliases tried in order for the correction pass. The next one runs
     * when the previous errors out or returns something that fails the
     * plausibility check (a refusal, a summary, a translation).
     */
    correctors: string[]
    /**
     * Prompt languages that trigger a pass, as detected by `detectLanguage`.
     * Empty means every detected language; a prompt whose language could not be
     * detected is never proofread.
     */
    languages: string[]
}

export interface GatewayConfig {
    /** Absolute or origin-relative URL of the OpenAI-compatible endpoint. */
    url: string
    /** Model id the engine sends; the router reinterprets it as an alias. */
    requestModel: string
}

export interface FeatureFlags {
    regenerate: boolean
    editMessage: boolean
    deleteMessage: boolean
    branchChat: boolean
    swipes: boolean
    personas: boolean
    maxPersonas: number
    characterUpload: boolean
    imageAttachments: boolean
    tts: boolean
    translate: boolean
    exportChat: boolean
}

export interface ClientPlugin {
    id: Id
    name: string
    displayName: string
    apiVersion: string
    /** Plugin source. Loaded into the RisuAI v3 iframe sandbox unmodified. */
    source: string
    args: Record<string, string | number>
    /** Admin-forced plugins cannot be disabled by the user. */
    forced: boolean
}

/* ------------------------------------------------------------------ *
 * LLM routing (admin-facing)
 * ------------------------------------------------------------------ */

export type ProviderKind =
    | 'pollinations'
    | 'llm7'
    | 'ovhcloud'
    | 'nvidia'
    | 'openrouter'
    | 'aihorde'
    | 'kilo'
    | 'openai_compatible'
    | 'gemini'
    | 'bedrock'
    | 'freellmapi'
    | 'freellmpool'

export type ProviderAuth = 'none' | 'bearer' | 'header' | 'query'

export interface ProviderConfig {
    id: Id
    key: string
    kind: ProviderKind
    label: string
    baseUrl: string
    auth: ProviderAuth
    /** Never returned to any client; presence only. */
    hasApiKey: boolean
    authHeaderName: string | null
    enabled: boolean
    priority: number
    /** null = unlimited / unknown. */
    rpm: number | null
    rpd: number | null
    concurrency: number
    timeoutMs: number
    notes: string
}

export type ModelTier = 'fast' | 'balanced' | 'smart'

export interface RoutedModel {
    id: Id
    providerKey: string
    /** Model id as the upstream expects it. */
    upstreamModel: string
    displayName: string
    enabled: boolean
    tier: ModelTier
    /** Higher wins when several models are healthy. */
    priority: number
    contextLength: number
    maxOutput: number
    supportsStreaming: boolean
    supportsVision: boolean
    supportsTools: boolean
    /**
     * BCP-47 primary subtags the model was measured to answer well in. Empty
     * means unverified — the router prefers verified models but still falls
     * back to unverified ones rather than failing the request.
     */
    languages: string[]
    /** Why the model sits at this tier/priority. Free-form, admin-facing. */
    notes: string
    /** Free-tier reality: some models 429 constantly. */
    health: ModelHealth
}

export interface ModelHealth {
    state: 'healthy' | 'degraded' | 'cooling' | 'unknown' | 'disabled'
    successCount: number
    errorCount: number
    consecutiveFailures: number
    p50LatencyMs: number | null
    lastError: string | null
    lastCheckedAt: ISODate | null
    cooldownUntil: ISODate | null
}

export interface RoutingAlias {
    alias: string
    label: string
    description: string
    /** Ordered tier preference the alias resolves through. */
    tiers: ModelTier[]
    /** Optional hard allow-list of model ids. */
    modelIds: Id[]
}

export interface ProbeResult {
    providerKey: string
    upstreamModel: string
    ok: boolean
    status: number | null
    latencyMs: number
    sample: string | null
    error: string | null
}

/* ------------------------------------------------------------------ *
 * Admin
 * ------------------------------------------------------------------ */

export interface AdminStats {
    users: { total: number; activeToday: number; newThisWeek: number }
    chats: { total: number; today: number }
    messages: { total: number; today: number }
    characters: { total: number; public: number }
    routing: {
        requestsToday: number
        successRate: number
        p50LatencyMs: number | null
        byProvider: { providerKey: string; requests: number; failures: number }[]
    }
}

export interface AdminUserRow extends PublicUser {
    chatCount: number
    messageCount: number
    lastSeenAt: ISODate | null
}

export interface AuditEntry {
    id: Id
    actorId: Id | null
    actorEmail: string | null
    action: string
    target: string | null
    detail: Record<string, unknown>
    createdAt: ISODate
}

/* ------------------------------------------------------------------ *
 * Gateway (OpenAI-compatible surface consumed by the RisuAI engine)
 * ------------------------------------------------------------------ */

export interface GatewayChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool' | 'developer'
    content: string | GatewayContentPart[]
    name?: string
}

export type GatewayContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }

export interface GatewayChatRequest {
    model: string
    messages: GatewayChatMessage[]
    stream?: boolean
    temperature?: number
    top_p?: number
    max_tokens?: number
    frequency_penalty?: number
    presence_penalty?: number
    stop?: string[]
    /** RisuAI-KAI extension: tells the router which chat this belongs to. */
    kai_chat_id?: string
}

/** Non-stream response shape; matches OpenAI so the engine parses it as-is. */
export interface GatewayChatResponse {
    id: string
    object: 'chat.completion'
    created: number
    model: string
    choices: {
        index: number
        message: { role: 'assistant'; content: string }
        finish_reason: string
    }[]
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

/** Header the gateway sets so the UI can show which free model actually served. */
export const ROUTED_VIA_HEADER = 'x-kai-routed-via'
export const ROUTE_ATTEMPTS_HEADER = 'x-kai-route-attempts'
export const MINUTE_LIMIT_HEADER = 'x-kai-minute-limit'
export const MINUTE_REMAINING_HEADER = 'x-kai-minute-remaining'
export const MINUTE_RESET_HEADER = 'x-kai-minute-reset'
export const DAILY_LIMIT_HEADER = 'x-kai-daily-limit'
export const DAILY_REMAINING_HEADER = 'x-kai-daily-remaining'
export const DAILY_RESET_HEADER = 'x-kai-daily-reset'
