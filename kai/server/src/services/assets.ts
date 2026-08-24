import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { env } from '../env.js'
import { sha256 } from '../util/crypto.js'
import { newId } from '../util/ids.js'
import { HttpError } from '../util/http.js'

type AssetKind = typeof schema.assets.$inferInsert['kind']

const MIME_EXT: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'application/json': '.json',
    'application/zip': '.zip',
}

export interface BatchAssetItem {
    refKey: string
    bytes: Buffer | Uint8Array
    mime: string
    kind: AssetKind
}

export async function saveAsset(
    bytes: Uint8Array,
    mime: string,
    kind: AssetKind,
    ownerUserId: string | null,
) {
    if (bytes.byteLength > env.maxUploadBytes) throw HttpError.tooLarge()
    const hash = sha256(Buffer.from(bytes))
    const existing = db.select().from(schema.assets).where(eq(schema.assets.sha256, hash)).get()
    if (existing) return existing

    const id = newId('as_')
    const suffix = MIME_EXT[mime] ?? extname(kind) ?? '.bin'
    const relativePath = `${id}${suffix}`
    await mkdir(env.assetsDir, { recursive: true })
    await writeFile(resolve(env.assetsDir, relativePath), bytes)
    return db
        .insert(schema.assets)
        .values({ id, path: relativePath, mime, size: bytes.byteLength, sha256: hash, kind, ownerUserId })
        .returning()
        .get()
}

/**
 * Batched, high-throughput asset persistence for character imports.
 * Groups hash checks, writes files in parallel with controlled concurrency,
 * and bulk-inserts all DB records within a single SQLite transaction.
 */
export async function saveCharacterAssetsBatch(
    characterId: string,
    items: BatchAssetItem[],
    ownerUserId: string | null,
    maxBytesPerAsset = env.maxUploadBytes,
): Promise<number> {
    if (!items.length) return 0
    await mkdir(env.assetsDir, { recursive: true })

    const validItems: Array<{ refKey: string; bytes: Uint8Array; mime: string; kind: AssetKind; hash: string }> = []
    for (const item of items) {
        if (!item.bytes.byteLength || item.bytes.byteLength > maxBytesPerAsset) continue
        const bytes = item.bytes instanceof Uint8Array ? item.bytes : new Uint8Array(item.bytes)
        const hash = sha256(Buffer.from(bytes))
        validItems.push({ refKey: item.refKey, bytes, mime: item.mime, kind: item.kind, hash })
    }
    if (!validItems.length) return 0

    const uniqueByHash = new Map<string, { bytes: Uint8Array; mime: string; kind: AssetKind }>()
    for (const item of validItems) {
        if (!uniqueByHash.has(item.hash)) {
            uniqueByHash.set(item.hash, item)
        }
    }

    const hashToAssetId = new Map<string, string>()
    const uniqueHashes = Array.from(uniqueByHash.keys())
    for (let i = 0; i < uniqueHashes.length; i += 500) {
        const slice = uniqueHashes.slice(i, i + 500)
        const rows = db.select().from(schema.assets).where(inArray(schema.assets.sha256, slice)).all()
        for (const row of rows) {
            hashToAssetId.set(row.sha256, row.id)
        }
    }

    const newAssetsToInsert: Array<typeof schema.assets.$inferInsert> = []
    const pendingWrites: Array<{ path: string; bytes: Uint8Array }> = []

    for (const [hash, data] of uniqueByHash.entries()) {
        if (hashToAssetId.has(hash)) continue
        const id = newId('as_')
        const suffix = MIME_EXT[data.mime] ?? extname(data.kind) ?? '.bin'
        const relativePath = `${id}${suffix}`
        hashToAssetId.set(hash, id)
        newAssetsToInsert.push({
            id,
            path: relativePath,
            mime: data.mime,
            size: data.bytes.byteLength,
            sha256: hash,
            kind: data.kind,
            ownerUserId,
        })
        pendingWrites.push({
            path: resolve(env.assetsDir, relativePath),
            bytes: data.bytes,
        })
    }

    const concurrency = 20
    for (let i = 0; i < pendingWrites.length; i += concurrency) {
        const batch = pendingWrites.slice(i, i + concurrency)
        await Promise.all(batch.map((w) => writeFile(w.path, w.bytes)))
    }

    db.transaction((tx) => {
        if (newAssetsToInsert.length) {
            for (let i = 0; i < newAssetsToInsert.length; i += 500) {
                tx.insert(schema.assets).values(newAssetsToInsert.slice(i, i + 500)).run()
            }
        }

        const charAssetRows: Array<typeof schema.characterAssets.$inferInsert> = []
        for (const item of validItems) {
            const assetId = hashToAssetId.get(item.hash)
            if (assetId) {
                charAssetRows.push({
                    characterId,
                    assetId,
                    refKey: item.refKey,
                })
            }
        }

        for (let i = 0; i < charAssetRows.length; i += 500) {
            tx.insert(schema.characterAssets)
                .values(charAssetRows.slice(i, i + 500))
                .onConflictDoNothing()
                .run()
        }
    })

    return validItems.length
}

export function getAsset(id: string) {
    const row = db.select().from(schema.assets).where(eq(schema.assets.id, id)).get()
    if (!row) throw HttpError.notFound('Asset not found')
    return row
}

export async function readAsset(id: string) {
    const row = getAsset(id)
    return { row, bytes: await readFile(resolve(env.assetsDir, row.path)) }
}
