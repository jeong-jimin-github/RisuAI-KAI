import { CCardLib, type CharacterCardV3 } from '@risuai/ccardlib'
import type { RisuModule } from '../cards/charx.js'
import { and, asc, count, desc, eq, inArray, like, or, sql } from 'drizzle-orm'
import type {
    CardSourceFormat,
    CharacterDetail,
    CharacterListQuery,
    CharacterSummary,
    Paged,
} from '../../../shared/contract.js'
import { SANITIZED_CARD_KEYS } from '../../../shared/contract.js'
import { db, schema } from '../db/index.js'
import type { DbCharacter } from '../db/schema.js'
import { HttpError } from '../util/http.js'
import { newId, slugCandidates, slugify } from '../util/ids.js'

const iso = (unix: number) => new Date(unix * 1000).toISOString()

/**
 * Produces a short, safe label for a greeting picker without exposing the
 * greeting prompt itself. Imported cards commonly put image commands first and
 * the actual scene name in the first Markdown heading.
 */
export function greetingName(greeting: string, index: number): string {
    const withoutComments = greeting.replace(/<!--[\s\S]*?-->/g, '')
    const lines = withoutComments.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const heading = lines.find((line) => /^#{1,6}\s+\S/.test(line))
    const candidate = heading?.replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, '').trim()
    if (!candidate) return index === 0 ? '기본 첫 장면' : `첫 장면 ${index + 1}`
    return candidate.length > 80 ? `${candidate.slice(0, 79)}…` : candidate
}

/**
 * The subset of columns needed to build a CharacterSummary. Kept in sync with
 * summaryFromRow(); DO NOT read cardJson here — it's the heaviest column and
 * pulls megabytes per page when the DB grows past a few hundred cards.
 */
export const CHARACTER_SUMMARY_COLUMNS = {
    id: schema.characters.id,
    slug: schema.characters.slug,
    name: schema.characters.name,
    tagline: schema.characters.tagline,
    creatorName: schema.characters.creatorName,
    creatorNotes: schema.characters.creatorNotes,
    avatarAssetId: schema.characters.avatarAssetId,
    tags: schema.characters.tags,
    nsfw: schema.characters.nsfw,
    visibility: schema.characters.visibility,
    featured: schema.characters.featured,
    sortOrder: schema.characters.sortOrder,
    chatCount: schema.characters.chatCount,
    messageCount: schema.characters.messageCount,
    likeCount: schema.characters.likeCount,
    createdAt: schema.characters.createdAt,
    updatedAt: schema.characters.updatedAt,
} as const

type CharacterSummaryRow = Pick<DbCharacter, keyof typeof CHARACTER_SUMMARY_COLUMNS>

function summaryFromRow(row: CharacterSummaryRow, likedIds: Set<string> | null): CharacterSummary {
    return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.creatorNotes || row.tagline,
        tagline: row.tagline,
        creatorName: row.creatorName,
        avatarUrl: row.avatarAssetId ? `/api/assets/${row.avatarAssetId}` : null,
        tags: (row.tags ?? []) as string[],
        nsfw: row.nsfw as boolean,
        visibility: row.visibility as 'public' | 'private',
        featured: row.featured as boolean,
        chatCount: row.chatCount,
        messageCount: row.messageCount,
        likeCount: row.likeCount,
        liked: likedIds ? likedIds.has(row.id) : false,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
    }
}

export function characterSummary(row: DbCharacter, userId?: string | null): CharacterSummary {
    const liked = userId
        ? !!db.select().from(schema.characterLikes).where(and(eq(schema.characterLikes.characterId, row.id), eq(schema.characterLikes.userId, userId))).get()
        : false
    return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.creatorNotes || row.tagline,
        tagline: row.tagline,
        creatorName: row.creatorName,
        avatarUrl: row.avatarAssetId ? `/api/assets/${row.avatarAssetId}` : null,
        tags: (row.tags ?? []) as string[],
        nsfw: row.nsfw,
        visibility: row.visibility,
        featured: row.featured,
        chatCount: row.chatCount,
        messageCount: row.messageCount,
        likeCount: row.likeCount,
        liked,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
    }
}

function characterWhere(q: CharacterListQuery, userId?: string | null) {
    const clauses = []
    if (q.mine) {
        if (!userId) throw HttpError.unauthorized()
        clauses.push(eq(schema.characters.createdBy, userId))
    } else {
        clauses.push(eq(schema.characters.visibility, 'public'))
    }
    if (q.q) {
        const needle = `%${q.q.trim()}%`
        clauses.push(or(like(schema.characters.name, needle), like(schema.characters.tagline, needle), like(schema.characters.creatorName, needle))!)
    }
    if (q.nsfw === false) clauses.push(eq(schema.characters.nsfw, false))
    if (q.liked) {
        if (!userId) throw HttpError.unauthorized()
        const likedIds = db
            .select({ id: schema.characterLikes.characterId })
            .from(schema.characterLikes)
            .where(eq(schema.characterLikes.userId, userId))
            .all()
            .map((row) => row.id)
        if (!likedIds.length) return null
        clauses.push(inArray(schema.characters.id, likedIds))
    }
    return and(...clauses)!
}

export function listCharacters(q: CharacterListQuery = {}, userId?: string | null): Paged<CharacterSummary> {
    const page = Math.max(1, q.page ?? 1)
    const pageSize = Math.min(60, Math.max(1, q.pageSize ?? 24))
    const where = characterWhere(q, userId)
    if (!where) return { items: [], total: 0, page, pageSize }
    let order: ReturnType<typeof desc>[] | ReturnType<typeof asc>[] = [desc(schema.characters.featured), desc(schema.characters.sortOrder)]
    if (q.sort === 'newest') order = [desc(schema.characters.createdAt)]
    else if (q.sort === 'popular') order = [desc(schema.characters.likeCount), desc(schema.characters.chatCount)]
    else if (q.sort === 'name') order = [asc(schema.characters.name)]
    else order = [desc(schema.characters.featured), desc(schema.characters.messageCount), desc(schema.characters.updatedAt)]
    const selectedTags = q.tag?.split(',').map((tag) => tag.trim()).filter(Boolean) ?? []
    // Projected select — skip card_json (largest column) so the DB does not
    // read/serialize per-row card blobs that this endpoint never returns.
    let rows: CharacterSummaryRow[]
    let total: number
    if (selectedTags.length) {
        const matching = db.select(CHARACTER_SUMMARY_COLUMNS).from(schema.characters).where(where).orderBy(...order).all()
            .filter((row) => selectedTags.some((tag) => ((row.tags ?? []) as string[]).includes(tag)))
        total = matching.length
        rows = matching.slice((page - 1) * pageSize, page * pageSize)
    } else {
        rows = db.select(CHARACTER_SUMMARY_COLUMNS).from(schema.characters).where(where).orderBy(...order).limit(pageSize).offset((page - 1) * pageSize).all()
        total = db.select({ n: count() }).from(schema.characters).where(where).get()?.n ?? 0
    }
    // Batch the likes lookup instead of N+1'ing it per row.
    let likedIds: Set<string> | null = null
    if (userId && rows.length) {
        const rowIds = rows.map((r) => r.id)
        const likedRows = db.select({ id: schema.characterLikes.characterId })
            .from(schema.characterLikes)
            .where(and(eq(schema.characterLikes.userId, userId), inArray(schema.characterLikes.characterId, rowIds)))
            .all()
        likedIds = new Set(likedRows.map((r) => r.id))
    }
    return { items: rows.map((r) => summaryFromRow(r, likedIds)), total, page, pageSize }
}

export function getCharacter(idOrSlug: string, userId?: string | null, includePrivate = false): CharacterDetail {
    // A Korean slug can arrive in either Unicode normalization depending on how
    // the link was produced, so every form is offered to the index.
    const keys = slugCandidates(idOrSlug)
    const row = db
        .select()
        .from(schema.characters)
        .where(or(inArray(schema.characters.id, keys), inArray(schema.characters.slug, keys)))
        .get()
    if (!row || (row.visibility !== 'public' && row.createdBy !== userId && !includePrivate)) throw HttpError.notFound('Character not found')
    const card = structuredClone((row.cardJson ?? {}) as Record<string, unknown>)
    for (const key of SANITIZED_CARD_KEYS) delete card[key]
    const assetRows = db
        .select({ refKey: schema.characterAssets.refKey, assetId: schema.characterAssets.assetId })
        .from(schema.characterAssets)
        .where(eq(schema.characterAssets.characterId, row.id))
        .all()
    const assets = Object.fromEntries(assetRows.map((a) => [a.refKey, `/api/assets/${a.assetId}`]))
    const first = String(card.firstMessage ?? '')
    const alternates = Array.isArray(card.alternateGreetings) ? card.alternateGreetings.map(String) : []
    return {
        ...characterSummary(row, userId),
        creatorNotes: row.creatorNotes,
        greetings: [first, ...alternates]
            .map((g, index) => ({ greeting: g, index }))
            .filter(({ greeting }) => Boolean(greeting))
            .map(({ greeting, index }) => ({
                index,
                name: greetingName(greeting, index),
                preview: greeting.slice(0, 240),
            })),
        card,
        assets,
    }
}

export function uniqueSlug(name: string, excludeId?: string): string {
    const base = slugify(name) || 'character'
    let candidate = base
    for (let i = 2; ; i++) {
        const row = db.select().from(schema.characters).where(eq(schema.characters.slug, candidate)).get()
        if (!row || row.id === excludeId) return candidate
        candidate = `${base}-${i}`
    }
}

function loreEntries(book: any): any[] {
    return (book?.entries ?? []).filter((e: any) => e?.enabled !== false).map((e: any, i: number) => ({
        key: Array.isArray(e.keys) ? e.keys.join(',') : '',
        secondkey: Array.isArray(e.secondary_keys) ? e.secondary_keys.join(',') : '',
        insertorder: Number(e.insertion_order ?? e.priority ?? i),
        comment: String(e.comment ?? e.name ?? ''),
        content: String(e.content ?? ''),
        mode: e.constant ? 'constant' : 'normal',
        alwaysActive: !!e.constant,
        selective: !!e.selective,
        useRegex: !!e.use_regex,
        extentions: { risu_case_sensitive: !!e.case_sensitive },
        id: String(e.id ?? newId('lore_')),
    }))
}

/**
 * Converts CCv1/v2/v3 into the internal RisuAI character shape.
 *
 * `module` is the decoded `module.risum` from a `.charx`. RisuAI's CHARX writer
 * *moves* the card's regex scripts, trigger scripts and lorebook out of
 * `card.json` and into that file, deleting them from the card itself — so a
 * reader that only looks at `card.json` gets a character whose display scripts
 * have silently vanished. Cards then render their raw markers (`[STATUS ...]`,
 * per-language `#en`/`#ko` blocks) as literal text. Upstream reattaches them at
 * import; see `characterCards.ts` in the client.
 */
export function toRisuCharacter(input: unknown, module?: RisuModule | null): Record<string, unknown> {
    const raw = input as any
    if (raw && typeof raw === 'object' && typeof raw.firstMessage === 'string') return structuredClone(raw)
    const version = CCardLib.character.check(raw)
    if (version === 'unknown') throw HttpError.badRequest('Unsupported character card JSON')
    const v3 = CCardLib.character.convert(raw, { from: version, to: 'v3', options: { convertRisuFields: true } }) as CharacterCardV3
    const d: any = v3.data
    const risu = d.extensions?.risuai ?? {}
    const cardAssets = Array.isArray(d.assets) ? d.assets : []
    const emotionImages: [string, string][] = []
    const additionalAssets: [string, string, string][] = []
    const ccAssets: { type: string; uri: string; name: string; ext: string }[] = []
    let image = ''

    for (const asset of cardAssets) {
        if (!asset || typeof asset.uri !== 'string') continue
        const name = String(asset.name ?? '')
        const ext = String(asset.ext ?? asset.uri.split('.').at(-1) ?? 'unknown')
        if (asset.type === 'emotion') emotionImages.push([name, asset.uri])
        else if (asset.type === 'x-risu-asset') additionalAssets.push([name, asset.uri, ext])
        else if (asset.type === 'icon' && name === 'main') image = asset.uri
        else ccAssets.push({ type: String(asset.type ?? 'asset'), uri: asset.uri, name, ext })
    }
    for (const asset of Array.isArray(risu.emotions) ? risu.emotions : []) {
        if (Array.isArray(asset) && typeof asset[0] === 'string' && typeof asset[1] === 'string') {
            emotionImages.push([asset[0], asset[1]])
        }
    }
    for (const asset of Array.isArray(risu.additionalAssets) ? risu.additionalAssets : []) {
        if (Array.isArray(asset) && typeof asset[0] === 'string' && typeof asset[1] === 'string') {
            additionalAssets.push([asset[0], asset[1], String(asset[2] ?? 'unknown')])
        }
    }
    return {
        type: 'character', name: d.name ?? '', firstMessage: d.first_mes ?? '', desc: d.description ?? '', notes: '',
        chats: [], chatFolders: [], chatPage: 0, viewScreen: risu.viewScreen ?? 'none', bias: risu.bias ?? [],
        image, emotionImages, additionalAssets, ccAssets,
        globalLore: Array.isArray(module?.lorebook) && module.lorebook.length > 0
            ? module.lorebook
            : loreEntries(d.character_book),
        chaId: newId('char_'), sdData: risu.sdData ?? [],
        customscript: module?.regex ?? risu.customScripts ?? [],
        triggerscript: module?.trigger ?? risu.triggerscript ?? [],
        utilityBot: !!risu.utilityBot,
        exampleMessage: d.mes_example ?? '', creatorNotes: d.creator_notes ?? '', systemPrompt: d.system_prompt ?? '',
        postHistoryInstructions: d.post_history_instructions ?? '', replaceGlobalNote: d.post_history_instructions ?? '',
        alternateGreetings: d.alternate_greetings ?? [], tags: d.tags ?? [], creator: d.creator ?? '',
        characterVersion: String(d.character_version ?? ''), personality: d.personality ?? '', scenario: d.scenario ?? '',
        firstMsgIndex: -1, additionalText: risu.additionalText ?? '', extentions: d.extensions ?? {},
        largePortrait: risu.largePortrait ?? true, imported: true,
        nickname: d.nickname ?? undefined,
        group_only_greetings: d.group_only_greetings ?? [],
        source: d.source ?? risu.source ?? [],
        ...engineFieldsFromRisuExtension(risu),
    }
}

/**
 * Engine-read fields carried over from the card's RisuAI extension block.
 *
 * Dropping any of these fails silently — the card just renders wrong.
 * `defaultVariables` is the one that bites hardest: it seeds the chat variables
 * `{{getvar::...}}` reads, so without it every `{{#if}}` a card uses to pick a
 * per-language block evaluates false and that whole section of the message
 * disappears with no error anywhere.
 */
function engineFieldsFromRisuExtension(risu: any): Record<string, unknown> {
    return {
        defaultVariables: risu.defaultVariables ?? '',
        backgroundHTML: risu.backgroundHTML ?? '',
        license: risu.license,
        lorePlus: risu.lorePlus ?? false,
        inlayViewScreen: risu.inlayViewScreen ?? false,
        newGenData: risu.newGenData ?? undefined,
        hideChatIcon: risu.hideChatIcon ?? false,
        prebuiltAssetCommand: risu.prebuiltAssetCommand ?? '',
        prebuiltAssetExclude: risu.prebuiltAssetExclude ?? [],
        prebuiltAssetStyle: risu.prebuiltAssetStyle ?? '',
        customModuleToggle: risu.toggles ?? {},
        moduleNamespace: risu.moduleNamespace,

        // Deliberately NOT carried over from the card:
        //   `virtualscript` — upstream RisuAI drops it too, for the same reason.
        //   `lowLevelAccess` — grants a card extra engine reach. On a shared
        //     instance that is the admin's call, not the card author's.
        virtualscript: '',
        lowLevelAccess: false,
    }
}

/**
 * Re-derives the fields above for cards imported before they were carried over.
 *
 * The original extension block survives on the stored card as `extentions`, so
 * this recovers them in place and spares operators a re-import. Idempotent: it
 * only writes rows that are actually missing something.
 */
export function backfillCardEngineFields(): number {
    const rows = db.select().from(schema.characters).all()
    let patched = 0

    for (const row of rows) {
        const card = row.cardJson as Record<string, any> | null
        if (!card) continue

        const risu = card.extentions?.risuai ?? card.extensions?.risuai
        if (!risu) continue

        const fields = engineFieldsFromRisuExtension(risu)
        // An undefined value does not survive JSON storage, so writing one would
        // leave the key "missing" forever and rewrite every row on every boot.
        const missing = Object.entries(fields).filter(([key, value]) => card[key] === undefined && value !== undefined)
        if (missing.length === 0) continue

        for (const [key, value] of missing) card[key] = value
        db.update(schema.characters).set({ cardJson: card }).where(eq(schema.characters.id, row.id)).run()
        patched++
    }

    if (patched > 0) console.log(`[kai] backfilled engine fields on ${patched} character card(s)`)
    return patched
}

export function insertCharacter(args: {
    card: unknown; sourceFormat: CardSourceFormat; createdBy: string | null; avatarAssetId?: string | null;
    visibility?: DbCharacter['visibility']; featured?: boolean; nsfw?: boolean; tagline?: string; warnings?: string[];
    /** Decoded `module.risum` from a `.charx`; carries the card's display scripts. */
    module?: RisuModule | null
}): DbCharacter {
    const card = toRisuCharacter(args.card, args.module)
    const name = String(card.name ?? '').trim()
    if (!name) throw HttpError.badRequest('Character name is required')
    const tags = Array.isArray(card.tags) ? card.tags.map(String).slice(0, 30) : []
    const now = Math.floor(Date.now() / 1000)
    return db.insert(schema.characters).values({
        id: newId('ch_'), slug: uniqueSlug(name), name,
        tagline: args.tagline ?? String(card.desc ?? '').replace(/\s+/g, ' ').slice(0, 140),
        creatorName: String(card.creator ?? ''), creatorNotes: String(card.creatorNotes ?? ''), cardJson: card,
        sourceFormat: args.sourceFormat, avatarAssetId: args.avatarAssetId ?? null, tags,
        nsfw: args.nsfw ?? false, visibility: args.visibility ?? 'public', featured: args.featured ?? false,
        greetingCount: 1 + (Array.isArray(card.alternateGreetings) ? card.alternateGreetings.length : 0),
        createdBy: args.createdBy, createdAt: now, updatedAt: now,
    }).returning().get()
}

export function toggleLike(characterId: string, userId: string, liked: boolean) {
    const row = db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).get()
    if (!row) throw HttpError.notFound('Character not found')
    db.transaction((tx) => {
        const existing = tx.select().from(schema.characterLikes).where(and(eq(schema.characterLikes.characterId, characterId), eq(schema.characterLikes.userId, userId))).get()
        if (liked && !existing) {
            tx.insert(schema.characterLikes).values({ characterId, userId }).run()
            tx.update(schema.characters).set({ likeCount: sql`${schema.characters.likeCount} + 1` }).where(eq(schema.characters.id, characterId)).run()
        } else if (!liked && existing) {
            tx.delete(schema.characterLikes).where(and(eq(schema.characterLikes.characterId, characterId), eq(schema.characterLikes.userId, userId))).run()
            tx.update(schema.characters).set({ likeCount: sql`max(0, ${schema.characters.likeCount} - 1)` }).where(eq(schema.characters.id, characterId)).run()
        }
    })
    const updated = db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).get()!
    return { liked, likeCount: updated.likeCount }
}

function isThumbnailRefKey(refKey: string): boolean {
    const k = refKey.trim().toLowerCase()
    const cleanKey = k.split('?')[0].split('#')[0]
    const baseName = cleanKey.split('/').pop() ?? cleanKey
    const nameWithoutExt = baseName.replace(/\.(png|jpe?g|webp|gif|svg|bmp)$/i, '')
    return ['icon', 'avatar', 'main', 'cover', 'thumbnail', 'chara', 'card', 'image', '0', 'image_0', 'main_image'].includes(nameWithoutExt)
}

export function hasExtraImages(
    card: unknown,
    characterAssets: Array<{ refKey: string; assetId: string }>,
    avatarAssetId?: string | null
): boolean {
    const nonThumbnailAssets = characterAssets.filter((a) => {
        if (avatarAssetId && a.assetId === avatarAssetId) return false
        if (isThumbnailRefKey(a.refKey)) return false
        return true
    })

    if (nonThumbnailAssets.length > 0) return true

    const urls = new Set<string>()
    const extractFromText = (text: unknown) => {
        if (!text || typeof text !== 'string') return

        const mdRegex = /!\[.*?\]\((https?:\/\/[^\s\)]+|\/api\/assets\/[^\s\)]+)\)/gi
        let match: RegExpExecArray | null
        while ((match = mdRegex.exec(text)) !== null) {
            if (match[1]) urls.add(match[1].trim())
        }

        const htmlRegex = /<img\s+[^>]*src=["'](https?:\/\/[^"']+|\/api\/assets\/[^"']+)["'][^>]*>/gi
        while ((match = htmlRegex.exec(text)) !== null) {
            if (match[1]) urls.add(match[1].trim())
        }

        const urlRegex = /(https?:\/\/[^\s"'<>\)]+|\/api\/assets\/[^\s"'<>\)]+)/gi
        while ((match = urlRegex.exec(text)) !== null) {
            const url = match[1].trim()
            const cleanUrl = url.split('?')[0].split('#')[0]
            if (/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(cleanUrl) || /\/api\/assets\//i.test(url)) {
                urls.add(url)
            }
        }
    }

    const walk = (obj: unknown) => {
        if (!obj) return
        if (typeof obj === 'string') {
            extractFromText(obj)
        } else if (Array.isArray(obj)) {
            for (const item of obj) walk(item)
        } else if (typeof obj === 'object') {
            for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
                if (['img', 'avatar', 'avatarUrl', 'avatarAssetId', 'mainImage', 'icon', 'cover'].includes(key)) continue
                walk(value)
            }
        }
    }

    walk(card)

    if (avatarAssetId) {
        urls.delete(`/api/assets/${avatarAssetId}`)
    }

    const nonThumbnailUrls = Array.from(urls).filter((url) => {
        const cleanUrl = url.split('?')[0].split('#')[0]
        const fileName = cleanUrl.split('/').pop() ?? ''
        return !isThumbnailRefKey(fileName)
    })

    return nonThumbnailUrls.length > 0
}

export function cleanupLowQualityCharacters(): { deletedCount: number } {
    const rows = db.select({ id: schema.characters.id, avatarAssetId: schema.characters.avatarAssetId, cardJson: schema.characters.cardJson }).from(schema.characters).all()
    let deletedCount = 0
    for (const r of rows) {
        const assets = db.select({ refKey: schema.characterAssets.refKey, assetId: schema.characterAssets.assetId })
            .from(schema.characterAssets)
            .where(eq(schema.characterAssets.characterId, r.id))
            .all()
        if (!hasExtraImages(r.cardJson, assets, r.avatarAssetId)) {
            db.delete(schema.characters).where(eq(schema.characters.id, r.id)).run()
            deletedCount++
        }
    }
    return { deletedCount }
}
