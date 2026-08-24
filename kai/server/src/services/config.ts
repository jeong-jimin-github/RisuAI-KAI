/**
 * Runtime config assembly — the one payload that makes the client obedient.
 *
 * The client engine writes this into its RisuAI `Database` at boot and exposes
 * no UI for any of it. It is identical for every signed-in user, so it is built
 * once per `revision` and served from memory; anonymous callers get a variant
 * with the plugin list and every gateway credential stripped.
 */

import { asc, desc, eq } from 'drizzle-orm'
import type {
    ClientPlugin,
    GatewayConfig,
    GenerationConfig,
    ModelTier,
    RuntimeConfig,
} from '../../../shared/contract.js'
import { db, schema } from '../db/index.js'
import { enabledModules } from './modules.js'
import { toggleVariables } from './toggles.js'
import type { DbUser } from '../db/schema.js'
import { env } from '../env.js'
import {
    DEFAULT_FEATURES,
    DEFAULT_GENERATION,
    DEFAULT_SITE,
    SETTING_KEYS,
    getSetting,
    setSetting,
} from './settings.js'

/** `LLMFormat.OpenAICompatible` in the RisuAI engine. */
const LLM_FORMAT_OPENAI_COMPATIBLE = 0
const REVERSE_PROXY_MODEL = 'reverse_proxy'

interface Built {
    revision: number
    full: RuntimeConfig
    anon: RuntimeConfig
}

let cached: Built | null = null

export async function getRuntimeConfig(user?: DbUser): Promise<RuntimeConfig> {
    const revision = await getSetting<number>(SETTING_KEYS.revision, 0)
    if (!cached || cached.revision !== revision) cached = await build(revision)
    return user ? cached.full : cached.anon
}

/**
 * Every setting / plugin / model mutation calls this. The client polls
 * `/api/config/revision` and refetches when the number moves.
 */
export async function bumpRevision(): Promise<number> {
    const next = (await getSetting<number>(SETTING_KEYS.revision, 0)) + 1
    await setSetting(SETTING_KEYS.revision, next)
    cached = null
    return next
}

/** Forces the next read to rebuild without moving the revision the client sees. */
export function invalidateRuntimeConfig(): void {
    cached = null
}

async function build(revision: number): Promise<Built> {
    const site = await getSetting(SETTING_KEYS.site, DEFAULT_SITE)
    const features = await getSetting(SETTING_KEYS.features, DEFAULT_FEATURES)
    const stored = await getSetting(SETTING_KEYS.generation, DEFAULT_GENERATION)

    const aliasRows = db
        .select()
        .from(schema.routingAliases)
        .orderBy(asc(schema.routingAliases.sortOrder), asc(schema.routingAliases.alias))
        .all()
    const aliasByName = new Map(aliasRows.map((a) => [a.alias, a]))

    // Labels live on the routing_aliases row, so an alias renamed in the routing
    // panel does not need the generation blob rewritten; aliases the admin later
    // deleted simply drop out of the user's picker.
    const selectableAliases = (stored.selectableAliases && stored.selectableAliases.length > 0)
        ? stored.selectableAliases
              .filter((s) => aliasByName.has(s.alias))
              .map((s) => {
                  const row = aliasByName.get(s.alias)!
                  return { alias: row.alias, label: row.label, description: row.description }
              })
        : aliasRows.map((row) => ({
              alias: row.alias,
              label: row.label,
              description: row.description,
          }))

    const generation: GenerationConfig = { ...stored, selectableAliases }

    const gateway: GatewayConfig = {
        // Same-origin by construction. Absolute KAI_PUBLIC_URL values break
        // browser auth/CORS when the instance is reached through a reverse
        // proxy, a LAN hostname, or 127.0.0.1 instead of localhost.
        url: '/v1/chat/completions',
        requestModel: generation.modelAlias,
    }

    const plugins = db
        .select()
        .from(schema.plugins)
        .where(eq(schema.plugins.enabled, true))
        .orderBy(asc(schema.plugins.sortOrder), asc(schema.plugins.name))
        .all()
        .map<ClientPlugin>((p) => ({
            id: p.id,
            name: p.name,
            displayName: p.displayName,
            apiVersion: p.apiVersion,
            source: p.source,
            args: (p.argValues ?? {}) as Record<string, string | number>,
            forced: p.forced,
        }))

    const preset = await buildPreset(generation, gateway)
    const modules = enabledModules()
    const toggles = toggleVariables(
        await getSetting<Record<string, string>>(SETTING_KEYS.toggleValues, {}),
    )

    const full: RuntimeConfig = {
        revision, site, generation, gateway, features, plugins, modules,
        toggleVariables: toggles, preset,
    }

    const anon: RuntimeConfig = {
        ...full,
        plugins: [],
        modules: [],
        toggleVariables: {},
        gateway: { url: '', requestModel: '' },
        preset: { ...preset, forceReplaceUrl: '', customProxyRequestModel: '', proxyKey: '' },
    }

    return { revision, full, anon }
}

/**
 * The admin-curated `botPreset` blob, with the fields that the routing panel owns
 * forced on top. RisuAI stores temperature and the two penalties as integers
 * scaled by 100, which is why they are multiplied here.
 */
async function buildPreset(generation: GenerationConfig, gateway: GatewayConfig): Promise<Record<string, unknown>> {
    const row =
        db.select().from(schema.promptPresets).where(eq(schema.promptPresets.isDefault, true)).get() ??
        db
            .select()
            .from(schema.promptPresets)
            .orderBy(desc(schema.promptPresets.createdAt))
            .limit(1)
            .get()

    const base = (row?.preset ?? {}) as Record<string, unknown>

    // A HypaV3 memory preset is a `botPreset` field like any other, so it rides
    // along here rather than needing its own delivery path.
    const hypa = await getSetting<Record<string, unknown> | null>(SETTING_KEYS.hypaPreset, null)
    const hypaFields = hypa
        ? { hypaV3: true, hypaV3Presets: [hypa], hypaV3PresetId: 0 }
        : {}

    return {
        ...base,
        ...hypaFields,
        apiType: REVERSE_PROXY_MODEL,
        aiModel: REVERSE_PROXY_MODEL,
        subModel: REVERSE_PROXY_MODEL,
        customAPIFormat: LLM_FORMAT_OPENAI_COMPATIBLE,
        proxyRequestModel: 'custom',
        customProxyRequestModel: gateway.requestModel,
        forceReplaceUrl: gateway.url,
        customTokenizer: 'kai-estimate',
        maxContext: generation.maxContext,
        maxResponse: generation.maxResponse,
        temperature: scaledOrOff(generation.temperature),
        top_p: orOff(generation.topP),
        frequencyPenalty: scaledOrOff(generation.frequencyPenalty),
        PresensePenalty: scaledOrOff(generation.presencePenalty),
        useStreaming: generation.streaming,

        // Samplers the admin left unset are sent as RisuAI's OFF sentinel so the
        // engine omits the field entirely. Sending 0 instead would be a real
        // value, and a provider that rejects the parameter fails the request.
        top_k: orOff(generation.topK),
        min_p: orOff(generation.minP),
        top_a: orOff(generation.topA),
        repetition_penalty: orOff(generation.repetitionPenalty),
        generationSeed: generation.seed ?? -1,

        reasoningEffort: generation.reasoningEffort,
        verbosity: generation.verbosity,
        thinkingTokens: generation.thinkingTokens,

        promptPreprocess: generation.promptPreprocess,
        jailbreakToggle: generation.jailbreakToggle,
        chainOfThought: generation.chainOfThought,
    }
}

/** RisuAI's "this parameter is disabled" value. */
const PARAMETER_OFF = -1000
const orOff = (v: number | null | undefined) => (v === null || v === undefined ? PARAMETER_OFF : v)
/** RisuAI stores temperature and the two penalties as integers scaled by 100. */
const scaledOrOff = (v: number | null | undefined) =>
    v === null || v === undefined ? PARAMETER_OFF : Math.round(v * 100)

/** Tier order a routing alias resolves through; used by the admin alias editor. */
export const MODEL_TIERS: ModelTier[] = ['fast', 'balanced', 'smart']
