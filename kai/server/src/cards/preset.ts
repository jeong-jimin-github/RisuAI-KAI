/**
 * RisuAI prompt-preset and HypaV3-preset files.
 *
 * Mirrors the reader half of `downloadPreset`/`importPreset` in the client's
 * `src/ts/storage/database.svelte.ts`:
 *
 *   .risupreset  gzip( msgpack{ presetVersion, type:'preset', pres|preset } )
 *                where the inner field is AES-GCM( msgpack(preset) )
 *   .risup       the same, wrapped once more in rpack
 *   .json        the preset object in the clear
 *
 * The AES key is SHA-256 of the literal string `risupreset` with a zero IV.
 * That is obfuscation, not secrecy — it is the same for every RisuAI install —
 * so it protects nothing and is reproduced here only for compatibility.
 */

import { webcrypto } from 'node:crypto'
import { gunzipSync, inflateSync } from 'node:zlib'
import { decode as decodeMsgpack } from 'msgpackr'
import { decodeRPackBytes } from './charx.js'
import { HttpError } from '../util/http.js'

/**
 * Preset fields that carry credentials or point the engine somewhere other than
 * this instance's gateway. A preset shared online should already have these
 * blank, but an arbitrary upload might not, and the engine would happily use
 * them — sending user traffic straight to a third party with someone else's key.
 */
const CREDENTIAL_FIELDS = [
    'openAIKey', 'openAIKey2', 'proxyKey', 'mancerHeader', 'claudeAPIKey', 'palmAPIKey',
    'googleClaudeAPIKey', 'deeplKey', 'deeplXKey', 'novellistAPIKey', 'novelaiSettings',
    'forceReplaceUrl', 'forceReplaceUrl2', 'textgenWebUIStreamURL', 'textgenWebUIBlockingURL',
    'koboldURL', 'openrouterKey', 'mistralKey', 'cohereAPIKey', 'ainconfig',
    'customProxyRequestModel', 'reverseProxyOobaArgs', 'hordeConfig',
]

export interface DecodedPreset {
    name: string
    /** The preset body, credential fields removed. */
    preset: Record<string, unknown>
}

/** RisuAI's "parameter disabled" sentinel. */
const PARAMETER_OFF = -1000

function optional(v: unknown): number | null | undefined {
    if (typeof v !== 'number' || Number.isNaN(v)) return undefined
    return v === PARAMETER_OFF ? null : v
}

function scaled(v: unknown): number | null | undefined {
    const n = optional(v)
    return n === null || n === undefined ? n : n / 100
}

function bool(v: unknown): boolean | undefined {
    return typeof v === 'boolean' ? v : undefined
}

function whole(v: unknown): number | undefined {
    return typeof v === 'number' && !Number.isNaN(v) && v !== PARAMETER_OFF ? v : undefined
}

/**
 * The generation settings a preset brings with it.
 *
 * A shared preset is tuned as a whole: its author picked a context size, a
 * temperature, and — just as deliberately — turned top-p and the penalties
 * *off*. Keeping the admin's previous numbers on top of an imported preset
 * would quietly override those choices, so importing adopts whatever the preset
 * actually specifies and leaves the rest alone.
 *
 * Only keys the preset defines are returned; `undefined` means "not specified,
 * keep what the admin already had", while `null` means "the preset explicitly
 * disables this".
 */
export function generationFromPreset(preset: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {
        maxContext: whole(preset.maxContext),
        maxResponse: whole(preset.maxResponse),
        temperature: scaled(preset.temperature),
        topP: optional(preset.top_p),
        topK: optional(preset.top_k),
        minP: optional(preset.min_p),
        topA: optional(preset.top_a),
        repetitionPenalty: optional(preset.repetition_penalty),
        frequencyPenalty: scaled(preset.frequencyPenalty),
        presencePenalty: scaled(preset.PresensePenalty),
        reasoningEffort: whole(preset.reasoningEffort),
        verbosity: whole(preset.verbosity),
        thinkingTokens: whole(preset.thinkingTokens),
        // `generationSeed` <= 0 is how RisuAI spells "let the provider choose".
        seed: typeof preset.generationSeed === 'number' && preset.generationSeed > 0 ? preset.generationSeed : undefined,
        streaming: bool(preset.useStreaming),
        promptPreprocess: bool(preset.promptPreprocess),
        jailbreakToggle: bool(preset.jailbreakToggle),
        chainOfThought: bool(preset.chainOfThought),
    }
    for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key]
    return out
}

function stripCredentials(preset: Record<string, unknown>): Record<string, unknown> {
    const out = { ...preset }
    for (const field of CREDENTIAL_FIELDS) delete out[field]
    return out
}

async function decryptPresetBody(data: Uint8Array): Promise<Buffer> {
    const keyBytes = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('risupreset'))
    const key = await webcrypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt'])
    const plain = await webcrypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(12) },
        key,
        data as unknown as ArrayBuffer,
    )
    return Buffer.from(plain)
}

/** gzip and raw-deflate have both been used by RisuAI's exporter over time. */
function decompress(data: Uint8Array): Buffer {
    try {
        return gunzipSync(data)
    } catch {
        return inflateSync(data)
    }
}

export async function readPresetFile(name: string, data: Uint8Array): Promise<DecodedPreset> {
    const lower = name.toLowerCase()
    let preset: Record<string, unknown>

    if (lower.endsWith('.risupreset') || lower.endsWith('.risup')) {
        const raw = lower.endsWith('.risup') ? decodeRPackBytes(data) : data
        let outer: any
        try {
            outer = decodeMsgpack(decompress(raw))
        } catch (e) {
            throw HttpError.badRequest(`Could not read the preset file: ${(e as Error).message}`)
        }
        if (outer?.type !== 'preset') throw HttpError.badRequest('File is not a RisuAI preset')
        const body = outer.pres ?? outer.preset
        if (!body) throw HttpError.badRequest('Preset file has no preset body')
        try {
            preset = decodeMsgpack(await decryptPresetBody(body)) as Record<string, unknown>
        } catch (e) {
            throw HttpError.badRequest(`Preset body could not be decoded: ${(e as Error).message}`)
        }
    } else {
        try {
            preset = JSON.parse(Buffer.from(data).toString('utf8'))
        } catch {
            throw HttpError.badRequest('Preset JSON is invalid')
        }
    }

    if (!preset || typeof preset !== 'object') throw HttpError.badRequest('Preset is empty')

    return {
        name: String(preset.name ?? name.replace(/\.[^.]+$/, '')).trim() || 'Imported preset',
        preset: stripCredentials(preset),
    }
}

export interface DecodedHypaPreset {
    name: string
    /** One entry of RisuAI's `hypaV3Presets` array. */
    data: Record<string, unknown>
}

/**
 * HypaV3 memory presets export as plain JSON: `{ type:'risu', ver:1, data:{…} }`.
 * A bare preset object is accepted too, since older exports lack the envelope.
 */
export function readHypaPresetFile(name: string, data: Uint8Array): DecodedHypaPreset {
    let parsed: any
    try {
        parsed = JSON.parse(Buffer.from(data).toString('utf8'))
    } catch {
        throw HttpError.badRequest('HypaV3 preset JSON is invalid')
    }

    const body = parsed?.type === 'risu' ? parsed.data : parsed
    if (!body || typeof body !== 'object' || !body.settings) {
        throw HttpError.badRequest('File is not a HypaV3 preset export')
    }

    return {
        name: String(body.name ?? name.replace(/\.[^.]+$/, '')).trim() || 'Imported HypaV3 preset',
        data: body as Record<string, unknown>,
    }
}
