/**
 * Admin-owned settings.
 *
 * Everything the client obeys but cannot change lives here as a handful of JSON
 * blobs in the `settings` table, plus a monotonic `revision` counter the client
 * polls. Reads go through a process-local cache; there is exactly one writer
 * process, so invalidating on write is enough.
 */

import { eq } from 'drizzle-orm'
import type { FeatureFlags, GenerationConfig, SiteConfig } from '../../../shared/contract.js'
import { db, schema } from '../db/index.js'
import { DEFAULT_PROOFREAD } from '../llm/proofread.js'

export const SETTING_KEYS = {
    site: 'site',
    generation: 'generation',
    features: 'features',
    revision: 'revision',
    /** One HypaV3 memory preset, applied to every user's engine. */
    hypaPreset: 'hypaPreset',
    /** Admin choices for the preset/module toggles, keyed by toggle key. */
    toggleValues: 'toggleValues',
} as const

export const DEFAULT_SITE: SiteConfig = {
    name: 'RisuAI-KAI',
    tagline: 'AI 캐릭터와 나누는 이야기',
    logoUrl: null,
    faviconUrl: null,
    accentColor: '#7c5cff',
    defaultLocale: 'ko',
    registrationOpen: true,
    inviteOnly: false,
    nsfwAllowed: false,
    termsUrl: null,
    privacyUrl: null,
}

export const DEFAULT_GENERATION: GenerationConfig = {
    modelAlias: 'auto',
    selectableAliases: [],
    maxContext: 32768,
    maxResponse: 1024,
    temperature: 0.85,
    topP: 0.9,
    frequencyPenalty: 0,
    presencePenalty: 0,
    streaming: true,
    maxHistoryMessages: 60,
    topK: null,
    minP: null,
    topA: null,
    repetitionPenalty: null,
    reasoningEffort: 1,
    verbosity: 1,
    thinkingTokens: 0,
    seed: null,
    promptPreprocess: false,
    jailbreakToggle: true,
    chainOfThought: false,
    proofread: DEFAULT_PROOFREAD,
}

export const DEFAULT_FEATURES: FeatureFlags = {
    regenerate: true,
    editMessage: true,
    deleteMessage: true,
    branchChat: true,
    swipes: true,
    personas: true,
    maxPersonas: 5,
    // A curated service: cards arrive through the admin importer, not from users.
    characterUpload: false,
    imageAttachments: false,
    tts: false,
    translate: false,
    exportChat: true,
}

/** `undefined` is cached too, so a missing row does not re-query on every read. */
const cache = new Map<string, unknown>()

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Stored blobs are merged *over* the defaults, so adding a field to SiteConfig /
 * GenerationConfig / FeatureFlags does not need a data migration — old rows just
 * inherit the new default.
 */
function withDefaults<T>(stored: unknown, fallback: T): T {
    if (stored === undefined || stored === null) return fallback
    if (isPlainObject(stored) && isPlainObject(fallback)) return { ...fallback, ...stored } as T
    return stored as T
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
    if (!cache.has(key)) {
        const row = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get()
        cache.set(key, row?.value)
    }
    return withDefaults(cache.get(key), fallback)
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
    const updatedAt = Math.floor(Date.now() / 1000)
    db.insert(schema.settings)
        .values({ key, value, updatedAt })
        .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt } })
        .run()
    cache.set(key, value)
}

/** Drops one key (or everything) from the read cache. */
export function invalidateSettingsCache(key?: string): void {
    if (key === undefined) cache.clear()
    else cache.delete(key)
}

/** Convenience readers used by the runtime-config assembler and the admin API. */
export const getSiteConfig = () => getSetting<SiteConfig>(SETTING_KEYS.site, DEFAULT_SITE)
export const getGenerationConfig = () =>
    getSetting<GenerationConfig>(SETTING_KEYS.generation, DEFAULT_GENERATION)
export const getFeatureFlags = () => getSetting<FeatureFlags>(SETTING_KEYS.features, DEFAULT_FEATURES)
export const getRevision = () => getSetting<number>(SETTING_KEYS.revision, 0)
