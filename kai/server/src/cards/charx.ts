/**
 * `.charx` container handling — a plain zip, per RisuAI's
 * `src/ts/process/processzip.ts` and the writer half of `characterCards.ts`.
 *
 * Layout produced by stock RisuAI:
 *   card.json                              CCv3 card
 *   module.risum                           optional; triggers + regex scripts + lorebook
 *   assets/<type>/<kind>/<name>.<ext>      referenced as `embeded://<path>`
 *   x_meta/<name>.json                     per-asset metadata, ignored on import
 *
 * RisuAI's `charxJpeg` variant prefixes the zip with a JPEG image; fflate finds
 * the central directory from the tail, so the same reader handles both.
 */

import { unzipSync, zipSync, type Zippable } from 'fflate'
import { env } from '../env.js'
import { HttpError } from '../util/http.js'

/** Uncompressed budget for one upload. Generous, but bounded — zip bombs exist. */
const MAX_TOTAL_UNCOMPRESSED = env.maxCardUploadBytes * 2
/** RisuAI's own per-asset ceiling. */
const MAX_ASSET_BYTES = 50 * 1024 * 1024

export interface CharXExtract {
    /** Parsed `card.json`. */
    card: unknown
    /** Zip path -> bytes, for every entry the card can reference. */
    assets: Map<string, Buffer>
    /** Decoded `module.risum`, when present. */
    module: RisuModule | null
    warnings: string[]
}

export interface RisuModule {
    name?: string
    description?: string
    lorebook?: unknown[]
    regex?: unknown[]
    trigger?: unknown[]
    cjs?: string
    id?: string
    lowLevelAccess?: boolean
    namespace?: string
    customModuleToggle?: string
    assets?: [string, string, string][]
}

export function isZip(data: Uint8Array): boolean {
    return data.length > 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04
}

/**
 * A charx may be a bare zip or a JPEG with the zip appended, so the local file
 * header is not necessarily at offset 0. Look for the end-of-central-directory
 * signature instead, which is what actually makes the archive readable.
 */
export function looksLikeCharX(data: Uint8Array): boolean {
    if (isZip(data)) return true
    return findEndOfCentralDirectory(data) >= 0
}

function findEndOfCentralDirectory(data: Uint8Array): number {
    const from = Math.max(0, data.length - 66_000)
    for (let i = data.length - 22; i >= from; i--) {
        if (readU32(data, i) === 0x06054b50) return i
    }
    return -1
}

function readU32(data: Uint8Array, offset: number): number {
    if (offset < 0 || offset + 4 > data.length) return -1
    return (data[offset] | data[offset + 1] << 8 | data[offset + 2] << 16 | data[offset + 3] << 24) >>> 0
}

/**
 * RisuAI's charxJpeg format concatenates `cover.jpg + archive.zip`. ZIP entry
 * offsets remain relative to the beginning of the ZIP payload, while fflate
 * assumes they are relative to the supplied Uint8Array. Derive the prefix from
 * the central directory and pass only the ZIP portion to the decoder.
 */
function normaliseZipPayload(data: Uint8Array): Uint8Array {
    if (isZip(data)) return data
    const eocd = findEndOfCentralDirectory(data)
    if (eocd < 0) throw HttpError.badRequest('Could not find the ZIP directory')

    const centralSize = readU32(data, eocd + 12)
    const relativeCentralOffset = readU32(data, eocd + 16)
    if (centralSize === 0xffffffff || relativeCentralOffset === 0xffffffff) {
        throw HttpError.badRequest('ZIP64 CHARX archives are not supported')
    }

    const actualCentralOffset = eocd - centralSize
    const prefixBytes = actualCentralOffset - relativeCentralOffset
    if (
        prefixBytes <= 0 ||
        readU32(data, actualCentralOffset) !== 0x02014b50 ||
        readU32(data, prefixBytes) !== 0x04034b50
    ) {
        throw HttpError.badRequest('Could not locate the embedded ZIP payload')
    }
    return data.subarray(prefixBytes)
}

/** Rejects absolute paths, drive letters and any `..` segment. */
function isSafeEntryName(name: string): boolean {
    if (!name || name.length > 512) return false
    if (name.startsWith('/') || name.startsWith('\\')) return false
    if (/^[a-zA-Z]:/.test(name)) return false
    const parts = name.split(/[\\/]/)
    return !parts.some((p) => p === '..' || p === '.')
}

export function unzipCharX(data: Uint8Array): Record<string, Uint8Array> {
    let unzipped: Record<string, Uint8Array>
    try {
        unzipped = unzipSync(normaliseZipPayload(data))
    } catch (e) {
        throw HttpError.badRequest(`Could not read the archive: ${(e as Error).message}`)
    }
    let total = 0
    for (const [name, bytes] of Object.entries(unzipped)) {
        total += bytes.byteLength
        if (total > MAX_TOTAL_UNCOMPRESSED) {
            throw HttpError.tooLarge('Archive expands to more than the allowed size')
        }
        if (!isSafeEntryName(name)) {
            throw HttpError.badRequest(`Unsafe path in archive: ${name}`)
        }
    }
    return unzipped
}

export function readCharX(data: Uint8Array): CharXExtract {
    const unzipped = unzipCharX(data)
    const warnings: string[] = []
    const assets = new Map<string, Buffer>()
    let cardText: string | null = null
    let moduleBytes: Uint8Array | null = null

    for (const [name, bytes] of Object.entries(unzipped)) {
        if (name.endsWith('/')) continue
        if (name === 'card.json') {
            cardText = Buffer.from(bytes).toString('utf8')
            continue
        }
        if (name === 'module.risum') {
            moduleBytes = bytes
            continue
        }
        // x_meta/*.json and any other sidecar JSON is metadata, not an asset.
        if (name.endsWith('.json')) continue
        if (bytes.byteLength > MAX_ASSET_BYTES) {
            warnings.push(`Asset "${name}" exceeds the 50MB limit and was dropped`)
            continue
        }
        assets.set(name, Buffer.from(bytes))
    }

    if (!cardText) throw HttpError.badRequest('Archive contains no card.json')

    let card: unknown
    try {
        card = JSON.parse(cardText)
    } catch {
        throw HttpError.badRequest('card.json is not valid JSON')
    }

    let module: RisuModule | null = null
    if (moduleBytes) {
        try {
            module = readRisuModule(Buffer.from(moduleBytes))
        } catch (e) {
            warnings.push(`module.risum could not be read (${(e as Error).message}); triggers and regex scripts may be missing`)
        }
    }

    return { card, assets, module, warnings }
}

export function writeCharX(entries: Record<string, Uint8Array>): Buffer {
    // level 0 for binary assets is what RisuAI does (they are already compressed);
    // card.json and metadata are passed in pre-marked by the caller via zipSync's
    // per-file options below.
    const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {}
    for (const [name, bytes] of Object.entries(entries)) {
        const compress = name.endsWith('.json') || name.endsWith('.risum')
        files[name] = [bytes, { level: compress ? 6 : 0 }]
    }
    return Buffer.from(zipSync(files))
}

/* ------------------------------------------------------------------ *
 * module.risum
 * ------------------------------------------------------------------ */

/**
 * RisuAI wraps module payloads in "rpack", a byte-substitution obfuscation whose
 * table lives in a 512-byte binary blob in the client bundle. Only the 256-byte
 * encode half is reproduced here; the decode half is its exact inverse, so we
 * derive it rather than carrying a second copy.
 */
const RPACK_ENCODE_B64 =
    'xA0eC70rP1X8RW71ZlNPGuC7MJSGumu/QVBvm+/etxBhFyDfMomonW2ryZAADF2v0sFW5RZkkYJldJfKI9ZS0f+0oOgvilg4WmAZlknb18g7PkNLpWNHqmopkvQVz2I0eNMdPOIFjipXDhvNTC3yQCwleUgPsnq1p2w35px7VH7+h9yaAuQzouuxLgPdmaaw59WIGIN89r7hXJ/DIUYfCE7QdhJf7v2PROqjXosoCTWeacwKx4UHrUrzd+ln1NqEgJO2TXP6JyZ/BMb78XI5UcI2qWis+O3FucvOdaQ9gdlCcByVEbzYjJj5WaET9xR9s+xxwOON8AGuWzEGJCI6uA=='

let rpackDecodeMap: Uint8Array | null = null
function decodeMap(): Uint8Array {
    if (rpackDecodeMap) return rpackDecodeMap
    const encode = Buffer.from(RPACK_ENCODE_B64, 'base64')
    const decode = new Uint8Array(256)
    for (let i = 0; i < 256; i++) decode[encode[i]] = i
    rpackDecodeMap = decode
    return decode
}

function decodeRPack(data: Uint8Array): Buffer {
    const map = decodeMap()
    const out = Buffer.allocUnsafe(data.length)
    for (let i = 0; i < data.length; i++) out[i] = map[data[i]]
    return out
}

function encodeRPack(data: Uint8Array): Buffer {
    const map = Buffer.from(RPACK_ENCODE_B64, 'base64')
    const out = Buffer.allocUnsafe(data.length)
    for (let i = 0; i < data.length; i++) out[i] = map[data[i]]
    return out
}

/** The 256-byte encode table, for checking it against the client's map file. */
export function rpackEncodeTable(): Buffer {
    return Buffer.from(RPACK_ENCODE_B64, 'base64')
}

/** rpack also wraps `.risup` presets, not just module bodies. */
export function decodeRPackBytes(data: Uint8Array): Buffer {
    return decodeRPack(data)
}

/**
 * Format: magic byte 111, version byte 0, uint32LE length, rpack'd JSON body,
 * then repeating `1` + uint32LE + rpack'd asset blobs, terminated by a `0` byte.
 * Module assets are not referenced by the card, so they are skipped.
 */
export function readRisuModule(buf: Buffer): RisuModule {
    if (buf.length < 6) throw new Error('truncated')
    if (buf.readUInt8(0) !== 111) throw new Error('bad magic number')
    if (buf.readUInt8(1) !== 0) throw new Error('unsupported version')
    const mainLen = buf.readUInt32LE(2)
    if (6 + mainLen > buf.length) throw new Error('truncated body')
    const parsed = JSON.parse(decodeRPack(buf.subarray(6, 6 + mainLen)).toString('utf8')) as {
        type?: string
        module?: RisuModule
    }
    if (parsed.type !== 'risuModule' || !parsed.module) throw new Error('not a risu module')
    return parsed.module
}

/** Inverse of `readRisuModule`, without the trailing asset blobs. */
export function encodeRisuModule(module: RisuModule): Buffer {
    const body = encodeRPack(Buffer.from(JSON.stringify({ type: 'risuModule', module }), 'utf8'))
    const header = Buffer.alloc(6)
    header.writeUInt8(111, 0)
    header.writeUInt8(0, 1)
    header.writeUInt32LE(body.length, 2)
    // A single `0` byte terminates the asset section.
    return Buffer.concat([header, body, Buffer.from([0])])
}
