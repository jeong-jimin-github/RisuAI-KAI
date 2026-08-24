/**
 * PNG container handling for character cards.
 *
 * Ported from RisuAI's `src/ts/pngChunk.ts`, optimized for server-side memory
 * and throughput. The chunk keys RisuAI actually writes are:
 *   - `chara`                  base64 CCv2 JSON
 *   - `ccv3`                   base64 CCv3 JSON
 *   - `chara-ext-asset_:<n>`   base64 asset bytes, referenced as `__asset:<n>`
 *   - `persona`                base64 persona card (written by persona.ts)
 *
 * Reading is deliberately more permissive than writing: cards in the wild come
 * from a dozen different tools and some of them get CRCs wrong, so a strict
 * parse failure falls back to a lenient scan rather than rejecting the card.
 */

import { createDecipheriv, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { inflateSync } from 'node:zlib'
import { HttpError } from '../util/http.js'

export interface PngChunkEntry {
    name: string
    data: Uint8Array
}

const nodeRequire = createRequire(import.meta.url)
const extractChunks = nodeRequire('png-chunks-extract') as (data: Uint8Array) => PngChunkEntry[]
const encodeChunks = nodeRequire('png-chunks-encode') as (chunks: PngChunkEntry[]) => Uint8Array
const pngTextChunk = nodeRequire('png-chunk-text') as {
    encode(keyword: string, content: string): PngChunkEntry
    decode(data: Uint8Array): { keyword: string; text: string }
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** RisuAI caps each embedded card blob at 5MB while reading; mirror that. */
const MAX_CARD_CHUNK_BYTES = 5 * 1024 * 1024

const TEXT_CHUNK_NAMES = new Set(['tEXt', 'zTXt', 'iTXt'])

export function isPng(data: Uint8Array): boolean {
    if (data.length < 8) return false
    for (let i = 0; i < 8; i++) if (data[i] !== PNG_MAGIC[i]) return false
    return true
}

/* ------------------------------------------------------------------ *
 * Chunk level
 * ------------------------------------------------------------------ */

/**
 * Lenient scanner used when png-chunks-extract rejects the file. Mirrors
 * RisuAI's reader: walk length-prefixed chunks, ignore CRCs, stop at IEND.
 */
function scanChunks(data: Uint8Array): PngChunkEntry[] {
    const out: PngChunkEntry[] = []
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    let pos = 8
    while (pos + 8 <= data.length) {
        const len = view.getUint32(pos)
        const name = String.fromCharCode(data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7])
        if (name === 'IEND') {
            out.push({ name, data: new Uint8Array(0) })
            return out
        }
        const end = pos + 8 + len
        if (len < 0 || end > data.length) break
        out.push({ name, data: data.subarray(pos + 8, end) })
        pos = end + 4
    }
    out.push({ name: 'IEND', data: new Uint8Array(0) })
    return out
}

export function readPngChunks(data: Uint8Array): PngChunkEntry[] {
    if (!isPng(data)) throw HttpError.badRequest('Not a PNG file')
    try {
        return extractChunks(data)
    } catch {
        return scanChunks(data)
    }
}

/* ------------------------------------------------------------------ *
 * Text chunks
 * ------------------------------------------------------------------ */

function splitAtNull(data: Uint8Array, from: number): { end: number; value: string } {
    let i = from
    while (i < data.length && data[i] !== 0) i++
    return { end: i, value: Buffer.from(data.subarray(from, i)).toString('utf8') }
}

function decodeTextChunk(chunk: PngChunkEntry): { keyword: string; text: string } | null {
    const d = chunk.data
    if (chunk.name === 'tEXt') {
        const kw = splitAtNull(d, 0)
        if (kw.end >= d.length) return null
        return { keyword: kw.value, text: Buffer.from(d.subarray(kw.end + 1)).toString('utf8') }
    }
    if (chunk.name === 'zTXt') {
        const kw = splitAtNull(d, 0)
        if (kw.end + 1 >= d.length) return null
        if (d[kw.end + 1] !== 0) return null
        try {
            const raw = inflateSync(Buffer.from(d.subarray(kw.end + 2)))
            return { keyword: kw.value, text: raw.toString('utf8') }
        } catch {
            return null
        }
    }
    if (chunk.name === 'iTXt') {
        const kw = splitAtNull(d, 0)
        if (kw.end + 2 >= d.length) return null
        const compressed = d[kw.end + 1] === 1
        const method = d[kw.end + 2]
        const lang = splitAtNull(d, kw.end + 3)
        const translated = splitAtNull(d, lang.end + 1)
        const body = d.subarray(translated.end + 1)
        if (!compressed) return { keyword: kw.value, text: Buffer.from(body).toString('utf8') }
        if (method !== 0) return null
        try {
            return { keyword: kw.value, text: inflateSync(Buffer.from(body)).toString('utf8') }
        } catch {
            return null
        }
    }
    return null
}

export function readPngTextChunks(data: Uint8Array): Record<string, string> {
    const out: Record<string, string> = {}
    for (const chunk of readPngChunks(data)) {
        if (!TEXT_CHUNK_NAMES.has(chunk.name)) continue
        const decoded = decodeTextChunk(chunk)
        if (decoded && decoded.keyword) out[decoded.keyword] = decoded.text
    }
    return out
}

export function writePngTextChunks(image: Uint8Array, entries: Record<string, string>): Buffer {
    const kept = readPngChunks(image).filter((c) => !TEXT_CHUNK_NAMES.has(c.name))
    const iendIdx = kept.findIndex((c) => c.name === 'IEND')
    const head = iendIdx === -1 ? kept : kept.slice(0, iendIdx)
    const added = Object.entries(entries).map(([k, v]) => pngTextChunk.encode(k, v))
    return Buffer.from(encodeChunks([...head, ...added, { name: 'IEND', data: new Uint8Array(0) }]))
}

export function stripPngTextChunks(image: Uint8Array): Buffer {
    return writePngTextChunks(image, {})
}

/* ------------------------------------------------------------------ *
 * Card level
 * ------------------------------------------------------------------ */

export interface PngCardExtract {
    /** Raw card JSON text, already base64-decoded. */
    cardJson: string
    /** Which chunk it came from. */
    chunk: 'ccv3' | 'chara'
    /** `__asset:<key>` payloads, keyed by the bare index. */
    assets: Map<string, Buffer>
    /** The PNG with all text chunks removed — this is the character avatar. */
    image: Buffer
    /** Non-card text chunks (Stable Diffusion `parameters`, EXIF-ish keys). */
    meta: Record<string, string>
}

/** `rcc||rccv1||<b64 ct>||<sha256 hex>||<b64 meta>` — RisuAI's encrypted card. */
const RCC_PREFIX = 'rcc||'

function decodeCardPayload(payload: string): string {
    if (!payload.startsWith(RCC_PREFIX)) {
        return Buffer.from(payload, 'base64').toString('utf8')
    }
    const parts = payload.split('||')
    if (parts[1] !== 'rccv1' || parts.length !== 5) {
        throw HttpError.unsupported('Unsupported encrypted card format')
    }
    const meta = JSON.parse(Buffer.from(parts[4], 'base64').toString('utf8')) as {
        usePassword?: boolean
    }
    if (meta.usePassword) {
        throw HttpError.unsupported('Password-protected cards cannot be imported')
    }
    const encrypted = Buffer.from(parts[2], 'base64')
    const key = createHash('sha256').update('RISU_NONE').digest()
    const tag = encrypted.subarray(encrypted.length - 16)
    const body = encrypted.subarray(0, encrypted.length - 16)
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.alloc(12))
    decipher.setAuthTag(tag)
    try {
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
    } catch {
        throw HttpError.unsupported('Encrypted card could not be decrypted')
    }
}

/**
 * High-performance, streaming-friendly card extraction from a PNG.
 * Parses chunks in a single pass without large intermediate UTF-16 string allocations,
 * and directly splices non-text chunks to reconstruct the trimmed avatar image.
 */
export function extractPngCard(data: Uint8Array): PngCardExtract {
    if (!isPng(data)) throw HttpError.badRequest('Not a PNG file')

    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    let pos = 8

    let chara = ''
    let ccv3 = ''
    const assets = new Map<string, Buffer>()
    const meta: Record<string, string> = {}
    const keptSlices: Uint8Array[] = [buf.subarray(0, 8)]

    while (pos + 8 <= buf.length) {
        const len = view.getUint32(pos)
        const name = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7])
        const chunkEnd = pos + 8 + len + 4
        if (chunkEnd > buf.length) break

        if (name === 'tEXt' || name === 'zTXt' || name === 'iTXt') {
            const dataStart = pos + 8
            let nullPos = dataStart
            const maxPos = pos + 8 + len
            while (nullPos < maxPos && buf[nullPos] !== 0) nullPos++;
            const keyword = buf.subarray(dataStart, nullPos).toString('latin1')

            let textBuffer: Buffer | Uint8Array | null = null
            if (name === 'tEXt') {
                textBuffer = buf.subarray(nullPos + 1, maxPos)
            } else if (name === 'zTXt') {
                if (nullPos + 2 <= maxPos && buf[nullPos + 1] === 0) {
                    try { textBuffer = inflateSync(buf.subarray(nullPos + 2, maxPos)) } catch {}
                }
            } else if (name === 'iTXt') {
                const comp = buf[nullPos + 1] === 1
                let bodyStart = nullPos + 3
                while (bodyStart < maxPos && buf[bodyStart] !== 0) bodyStart++
                bodyStart++
                while (bodyStart < maxPos && buf[bodyStart] !== 0) bodyStart++
                bodyStart++
                if (bodyStart <= maxPos) {
                    const rawBody = buf.subarray(bodyStart, maxPos)
                    if (comp) {
                        try { textBuffer = inflateSync(rawBody) } catch {}
                    } else {
                        textBuffer = rawBody
                    }
                }
            }

            if (textBuffer) {
                if (keyword === 'chara') {
                    if (textBuffer.length <= MAX_CARD_CHUNK_BYTES) {
                        chara = Buffer.from(textBuffer).toString('utf8')
                    }
                } else if (keyword === 'ccv3') {
                    if (textBuffer.length <= MAX_CARD_CHUNK_BYTES) {
                        ccv3 = Buffer.from(textBuffer).toString('utf8')
                    }
                } else if (keyword.startsWith('chara-ext-asset_')) {
                    const key = keyword.replace('chara-ext-asset_:', '').replace('chara-ext-asset_', '')
                    assets.set(key, Buffer.from(textBuffer.toString('latin1'), 'base64'))
                } else {
                    meta[keyword] = Buffer.from(textBuffer).toString('utf8')
                }
            }
        } else {
            keptSlices.push(buf.subarray(pos, chunkEnd))
        }

        if (name === 'IEND') break
        pos = chunkEnd
    }

    const payload = ccv3 || chara
    if (!payload) throw HttpError.badRequest('No character card found in this PNG')

    const image = Buffer.concat(keptSlices)

    return {
        cardJson: decodeCardPayload(payload),
        chunk: ccv3 ? 'ccv3' : 'chara',
        assets,
        image,
        meta,
    }
}

/**
 * Builds a card PNG: `image` carries the pixels, `cardJson` goes into the
 * `ccv3`/`chara` chunk and `assets` become `chara-ext-asset_:<n>` chunks whose
 * indices the caller has already written into the card as `__asset:<n>`.
 */
export function buildCardPng(args: {
    image: Uint8Array
    chunk: 'ccv3' | 'chara'
    cardJson: string
    assets: Map<string, Uint8Array>
}): Buffer {
    const entries: Record<string, string> = {}
    for (const [key, value] of args.assets) {
        if (value.byteLength === 0) continue
        entries[`chara-ext-asset_:${key}`] = Buffer.from(value).toString('base64')
    }
    entries[args.chunk] = Buffer.from(args.cardJson, 'utf8').toString('base64')
    return writePngTextChunks(args.image, entries)
}
