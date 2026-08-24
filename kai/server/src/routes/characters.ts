import { CCardLib } from '@risuai/ccardlib'
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import type { CardSourceFormat, CharacterCreateBody, CharacterImportResult, CharacterListQuery, RealmBatchImportResult } from '../../../shared/contract.js'
import { requireAdmin, requireAuth } from '../auth/middleware.js'
import { looksLikeCharX, readCharX, writeCharX, type RisuModule } from '../cards/charx.js'
import { buildCardPng, extractPngCard, isPng } from '../cards/png.js'
import { db, schema } from '../db/index.js'
import { env } from '../env.js'
import { readAsset, saveAsset, saveCharacterAssetsBatch } from '../services/assets.js'
import { characterSummary, getCharacter, hasExtraImages, insertCharacter, listCharacters, toggleLike, toRisuCharacter } from '../services/characters.js'
import { ensureGenreTags } from '../services/genreTags.js'
import { downloadRealmCharX, importedRealmIds, isRealmBrowseSort, listRealmCharacters, parseRealmCharacterId } from '../services/realm.js'
import type { KaiEnv } from '../types.js'
import { HttpError, ok } from '../util/http.js'

const app = new Hono<KaiEnv>()

app.get('/', (c) => {
    const q = c.req.query() as unknown as CharacterListQuery
    q.page = Number(q.page || 1)
    q.pageSize = Number(q.pageSize || 24)
    if (c.req.query('nsfw') !== undefined) q.nsfw = c.req.query('nsfw') === 'true'
    if (c.req.query('mine') !== undefined) q.mine = c.req.query('mine') === 'true'
    if (c.req.query('liked') !== undefined) q.liked = c.req.query('liked') === 'true'
    return ok(c, listCharacters(q, c.get('user')?.id))
})

app.post('/', requireAuth, async (c) => {
    let payload: CharacterCreateBody
    try { payload = await c.req.json<CharacterCreateBody>() }
    catch { throw HttpError.badRequest('작품 정보를 확인해 주세요.') }
    const name = String(payload.name ?? '').trim()
    const description = String(payload.description ?? '').trim()
    const firstMessage = String(payload.firstMessage ?? '').trim()
    const systemPrompt = String(payload.systemPrompt ?? '').trim()
    const scenario = String(payload.scenario ?? '').trim()
    if (!name) throw HttpError.badRequest('작품 이름을 입력해 주세요.')
    if (!description) throw HttpError.badRequest('캐릭터 설명을 입력해 주세요.')
    if (!firstMessage) throw HttpError.badRequest('첫 메시지를 입력해 주세요.')
    if (!systemPrompt) throw HttpError.badRequest('캐릭터 프롬프트를 입력해 주세요.')
    if (name.length > 120 || description.length > 12_000 || firstMessage.length > 20_000 || systemPrompt.length > 20_000 || scenario.length > 12_000) {
        throw HttpError.tooLarge('입력한 작품 정보가 허용 길이를 초과합니다.')
    }
    const user = c.get('user')!
    const card: Record<string, unknown> = {
        type: 'character', name, desc: description, firstMessage, systemPrompt, scenario,
        personality: systemPrompt, creator: user.displayName, creatorNotes: description,
        alternateGreetings: [], tags: [], chats: [], chatFolders: [], globalLore: [],
    }
    await ensureGenreTags(card)
    const row = insertCharacter({ card, sourceFormat: 'kai_native', createdBy: user.id, visibility: 'public' })
    return ok(c, characterSummary(row, user.id), 201)
})

app.post('/import', requireAdmin, async (c) => {
    const user = c.get('user')!
    const form = await c.req.parseBody({ all: false })
    const file = form.file
    if (!(file instanceof File)) throw HttpError.badRequest('Missing character card file')
    if (file.size > env.maxCardUploadBytes) {
        throw HttpError.tooLarge(`Character card exceeds the ${Math.floor(env.maxCardUploadBytes / 1024 / 1024)}MB limit`)
    }
    const result = await importCharacterBytes(Buffer.from(await file.arrayBuffer()), user.id)
    return ok(c, result, 201)
})

app.post('/import/realm', requireAdmin, async (c) => {
    let payload: unknown
    try {
        payload = await c.req.json()
    } catch {
        throw HttpError.badRequest('RisuRealm URL 또는 캐릭터 ID를 입력해 주세요.')
    }
    const input = (payload as { input?: unknown; skipLowQuality?: boolean })?.input
    const skipLowQuality = Boolean((payload as any)?.skipLowQuality)
    if (typeof input !== 'string') throw HttpError.badRequest('RisuRealm URL 또는 캐릭터 ID를 입력해 주세요.')

    const expectedId = parseRealmCharacterId(input)
    if (importedRealmIds().has(expectedId)) throw HttpError.conflict('이미 가져온 RisuRealm 작품입니다.')
    const { id, bytes } = await downloadRealmCharX(input, env.maxCardUploadBytes)
    const result = await importCharacterBytes(bytes, c.get('user')!.id, id, skipLowQuality)
    return ok(c, result, 201)
})

app.get('/import/realm/browse', requireAdmin, async (c) => {
    const sort = c.req.query('sort')
    return ok(c, await listRealmCharacters({
        sort: isRealmBrowseSort(sort) ? sort : undefined,
        search: c.req.query('search') ?? '',
        page: Number(c.req.query('page') ?? 1),
        nsfw: c.req.query('nsfw') === 'true',
    }))
})

app.post('/import/realm/batch', requireAdmin, async (c) => {
    let payload: { inputs?: unknown; skipLowQuality?: boolean } = {}
    try { payload = await c.req.json() }
    catch { throw HttpError.badRequest('가져올 Realm 작품을 선택해 주세요.') }
    const inputs = payload.inputs
    const skipLowQuality = Boolean(payload.skipLowQuality)
    if (!Array.isArray(inputs) || !inputs.length) throw HttpError.badRequest('가져올 Realm 작품을 선택해 주세요.')
    if (inputs.length > 30) throw HttpError.badRequest('한 번에 최대 30개까지 가져올 수 있습니다.')

    const result: RealmBatchImportResult = { imported: [], skipped: [], failed: [] }
    const known = importedRealmIds()
    for (const value of inputs) {
        let id = String(value ?? '')
        try { id = parseRealmCharacterId(id) }
        catch (error) {
            result.failed.push({ id, message: error instanceof Error ? error.message : '올바르지 않은 Realm ID입니다.' })
            continue
        }
        if (known.has(id)) {
            result.skipped.push({ id, reason: '이미 가져온 작품' })
            continue
        }
        try {
            const downloaded = await downloadRealmCharX(id, env.maxCardUploadBytes)
            const imported = await importCharacterBytes(downloaded.bytes, c.get('user')!.id, downloaded.id, skipLowQuality)
            result.imported.push(imported.character)
            known.add(id)
        } catch (error) {
            if (error instanceof HttpError && error.message.includes('저품질 챗')) {
                result.skipped.push({ id, reason: error.message })
            } else {
                result.failed.push({ id, message: error instanceof Error ? error.message : '가져오지 못했습니다.' })
            }
        }
    }
    return ok(c, result, 201)
})

async function importCharacterBytes(
    bytes: Buffer,
    userId: string,
    realmId?: string,
    skipLowQuality = false,
): Promise<CharacterImportResult> {
    let card: unknown
    let sourceFormat: CardSourceFormat = 'kai_native'
    let avatar: Buffer | null = null
    let warnings: string[] = []
    let extras = new Map<string, Buffer>()
    // A `.charx` keeps the card's regex/trigger scripts in `module.risum`, not
    // in `card.json` — losing it strips the card's whole display layer.
    let module: RisuModule | null = null

    if (looksLikeCharX(bytes)) {
        const parsed = readCharX(bytes)
        card = parsed.card
        sourceFormat = 'risu_charx'
        warnings = parsed.warnings
        extras = parsed.assets
        module = parsed.module
        avatar = embeddedMainIcon(card, extras)
    } else if (isPng(bytes)) {
        const parsed = extractPngCard(bytes)
        try { card = JSON.parse(parsed.cardJson) } catch { throw HttpError.badRequest('Character card JSON is invalid') }
        sourceFormat = parsed.chunk === 'ccv3' ? 'ccv3_png' : 'ccv2_png'
        avatar = parsed.image
        extras = parsed.assets
    } else {
        try { card = JSON.parse(bytes.toString('utf8')) } catch { throw HttpError.unsupported('Use a PNG, CHARX, or JSON character card') }
        const version = CCardLib.character.check(card)
        sourceFormat = version === 'v3' ? 'ccv3_json' : version === 'v2' || version === 'v1' ? 'ccv2_json' : 'kai_native'
    }

    card = toRisuCharacter(card, module)
    module = null
    await ensureGenreTags(card as Record<string, unknown>)
    if (realmId) markRealmImport(card, realmId)

    const avatarRow = avatar ? await saveAsset(avatar, sniffMime(avatar), 'card_image', userId) : null
    const row = insertCharacter({ card, sourceFormat, createdBy: userId, avatarAssetId: avatarRow?.id, visibility: 'public', warnings, module })
    const batchItems = Array.from(extras.entries()).map(([refKey, data]) => ({
        refKey,
        bytes: data,
        mime: sniffMime(data),
        kind: 'additional' as const,
    }))
    const savedExtrasCount = await saveCharacterAssetsBatch(row.id, batchItems, userId, env.maxUploadBytes)
    const savedAssets = db.select({ refKey: schema.characterAssets.refKey, assetId: schema.characterAssets.assetId })
        .from(schema.characterAssets)
        .where(eq(schema.characterAssets.characterId, row.id))
        .all()
    if (skipLowQuality && !hasExtraImages(card, savedAssets, row.avatarAssetId)) {
        db.delete(schema.characters).where(eq(schema.characters.id, row.id)).run()
        throw HttpError.badRequest('저품질 챗 (추가 이미지 없음)으로 제외되었습니다.')
    }
    const assetCount = (avatarRow ? 1 : 0) + savedExtrasCount
    return { character: characterSummary(row, userId), format: sourceFormat, warnings, assetCount }
}

app.get('/:idOrSlug', (c) => ok(c, getCharacter(c.req.param('idOrSlug'), c.get('user')?.id, c.get('user')?.role === 'admin')))

app.post('/:id/like', requireAuth, (c) => ok(c, toggleLike(c.req.param('id'), c.get('user')!.id, true)))
app.delete('/:id/like', requireAuth, (c) => ok(c, toggleLike(c.req.param('id'), c.get('user')!.id, false)))

app.patch('/:id', requireAuth, async (c) => {
    const id = c.req.param('id')
    const user = c.get('user')!
    const current = db.select().from(schema.characters).where(eq(schema.characters.id, id)).get()
    if (!current) throw HttpError.notFound('Character not found')
    if (current.createdBy !== user.id && user.role !== 'admin') throw HttpError.forbidden('작품 수정 권한이 없습니다.')

    let b: any
    try { b = await c.req.json() } catch { throw HttpError.badRequest('Expected JSON') }
    const allowed = ['name', 'tagline', 'creatorName', 'creatorNotes', 'visibility', 'featured', 'nsfw', 'sortOrder', 'tags']
    const set: any = { updatedAt: Math.floor(Date.now() / 1000) }
    for (const key of allowed) if (b[key] !== undefined) set[key] = b[key]

    if (b.card !== undefined) {
        if (!b.card || typeof b.card !== 'object' || Array.isArray(b.card)) {
            throw HttpError.badRequest('Invalid card object')
        }
        const card = structuredClone(b.card)
        if (card.name) set.name = String(card.name)
        if (card.desc) set.tagline = String(card.desc).slice(0, 160)
        if (card.tags && Array.isArray(card.tags)) set.tags = card.tags
        await ensureGenreTags(card)
        set.cardJson = card
        set.greetingCount = (Array.isArray(card.alternateGreetings) ? card.alternateGreetings.length : 0) + (card.firstMessage ? 1 : 0)
    }

    const row = db.update(schema.characters).set(set).where(eq(schema.characters.id, id)).returning().get()
    return ok(c, characterSummary(row, user.id))
})

app.post('/:id/avatar', requireAuth, async (c) => {
    const id = c.req.param('id')
    const user = c.get('user')!
    const current = db.select().from(schema.characters).where(eq(schema.characters.id, id)).get()
    if (!current) throw HttpError.notFound('Character not found')
    if (current.createdBy !== user.id && user.role !== 'admin') throw HttpError.forbidden('작품 수정 권한이 없습니다.')

    const form = await c.req.parseBody({ all: false })
    const file = form.file
    if (!(file instanceof File)) throw HttpError.badRequest('Image file required')
    const bytes = Buffer.from(await file.arrayBuffer())
    const asset = await saveAsset(bytes, sniffMime(bytes), 'card_image', user.id)
    const row = db.update(schema.characters).set({ avatarAssetId: asset.id, updatedAt: Math.floor(Date.now() / 1000) }).where(eq(schema.characters.id, id)).returning().get()
    return ok(c, characterSummary(row, user.id))
})

app.get('/:id/export', requireAdmin, async (c) => {
    const detail = getCharacter(c.req.param('id'), c.get('user')?.id, true)
    const v3 = internalToV3(detail.card)
    const format = c.req.query('format') === 'png' ? 'png' : 'charx'
    let payload: Buffer
    let mime: string
    let ext: string
    if (format === 'png') {
        const row = db.select().from(schema.characters).where(eq(schema.characters.id, detail.id)).get()!
        const image = row.avatarAssetId ? (await readAsset(row.avatarAssetId)).bytes : EMPTY_PNG
        payload = buildCardPng({ image, chunk: 'ccv3', cardJson: JSON.stringify(v3), assets: new Map() })
        mime = 'image/png'; ext = 'png'
    } else {
        payload = writeCharX({ 'card.json': Buffer.from(JSON.stringify(v3, null, 2)) })
        mime = 'application/zip'; ext = 'charx'
    }
    c.header('Content-Type', mime)
    c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(detail.name)}.${ext}`)
    return c.body(new Uint8Array(payload))
})

function embeddedMainIcon(card: unknown, assets: Map<string, Buffer>): Buffer | null {
    const data = (card as any)?.data
    const icon = Array.isArray(data?.assets)
        ? data.assets.find((asset: any) => asset?.type === 'icon' && asset?.name === 'main')
        : null
    const uri = typeof icon?.uri === 'string' ? icon.uri : ''
    if (!uri.startsWith('embeded://')) return null
    return assets.get(uri.slice('embeded://'.length)) ?? null
}

function markRealmImport(card: unknown, realmId: string) {
    const raw = card as any
    if (raw?.data && typeof raw.data === 'object') {
        raw.data.extensions = raw.data.extensions && typeof raw.data.extensions === 'object'
            ? raw.data.extensions
            : {}
        raw.data.extensions.risuRealmImportId = realmId
    } else if (raw && typeof raw === 'object') {
        raw.extentions = raw.extentions && typeof raw.extentions === 'object' ? raw.extentions : {}
        raw.extentions.risuRealmImportId = realmId
    }
}

function sniffMime(buf: Buffer | Uint8Array): string {
    if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
    if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
    if (buf.length >= 4 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'image/webp'
    return 'application/octet-stream'
}

function internalToV3(card: Record<string, unknown>) {
    const lore = Array.isArray(card.globalLore) ? (card.globalLore as any[]) : []
    return {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
            name: String(card.name ?? ''), description: String(card.desc ?? ''), personality: String(card.personality ?? ''),
            scenario: String(card.scenario ?? ''), first_mes: String(card.firstMessage ?? ''), mes_example: String(card.exampleMessage ?? ''),
            creator_notes: String(card.creatorNotes ?? ''), system_prompt: String(card.systemPrompt ?? ''),
            post_history_instructions: String(card.postHistoryInstructions ?? card.replaceGlobalNote ?? ''),
            alternate_greetings: Array.isArray(card.alternateGreetings) ? card.alternateGreetings : [],
            tags: Array.isArray(card.tags) ? card.tags : [], creator: String(card.creator ?? ''),
            character_version: String(card.characterVersion ?? ''), group_only_greetings: [], extensions: { ...(card.extentions as object ?? {}), risuai: {
                triggerscript: card.triggerscript ?? [], customScripts: card.customscript ?? [], bias: card.bias ?? [],
            } },
            character_book: { extensions: {}, entries: lore.map((e, i) => ({ keys: String(e.key ?? '').split(',').filter(Boolean), secondary_keys: String(e.secondkey ?? '').split(',').filter(Boolean), content: String(e.content ?? ''), extensions: {}, enabled: true, insertion_order: Number(e.insertorder ?? i), use_regex: !!e.useRegex, constant: !!e.alwaysActive, selective: !!e.selective, comment: String(e.comment ?? '') })) },
        },
    }
}

const EMPTY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

export default app
