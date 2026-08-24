import { HttpError } from '../util/http.js'
import type { RealmBrowseQuery, RealmBrowseSort, RealmCharacterSummary } from '../../../shared/contract.js'
import { db, schema } from '../db/index.js'

export const RISU_REALM_ORIGIN = 'https://realm.risuai.net'
/** Realm's listing/search API and image CDN; the site itself only renders HTML. */
export const RISU_HUB_ORIGIN = 'https://sv.risuai.xyz'

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>

/**
 * Accepts either the id shown by Realm or one of its public character/download
 * URLs. Keeping this parser strict also means the server-side downloader can
 * never be turned into a general-purpose SSRF proxy.
 */
export function parseRealmCharacterId(input: string): string {
    const value = input.trim()
    if (!value) throw HttpError.badRequest('RisuRealm URL 또는 캐릭터 ID를 입력해 주세요.')

    let id = value
    if (/^https?:\/\//i.test(value)) {
        let url: URL
        try {
            url = new URL(value)
        } catch {
            throw HttpError.badRequest('올바른 RisuRealm URL이 아닙니다.')
        }
        if (url.protocol !== 'https:' || url.hostname !== 'realm.risuai.net' || url.port) {
            throw HttpError.badRequest('realm.risuai.net의 HTTPS URL만 사용할 수 있습니다.')
        }

        const pathMatch = url.pathname.match(
            /^\/(?:character|api\/v1\/download\/(?:charx-v3|dynamic))\/([^/]+)\/?$/,
        )
        id = url.searchParams.get('realm') ?? url.searchParams.get('code') ?? pathMatch?.[1] ?? ''
        try {
            id = decodeURIComponent(id)
        } catch {
            throw HttpError.badRequest('RisuRealm 캐릭터 ID를 해석할 수 없습니다.')
        }
    }

    // Current Realm ids are UUIDs or 64-character hashes. A conservative
    // superset keeps older ids working without permitting slashes or controls.
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id)) {
        throw HttpError.badRequest('올바른 RisuRealm 캐릭터 URL 또는 ID가 아닙니다.')
    }
    return id
}

/** Downloads a Realm CHARX while enforcing the same compressed-size budget as file uploads. */
export async function downloadRealmCharX(
    input: string,
    maxBytes: number,
    fetcher: Fetcher = fetch,
): Promise<{ id: string; bytes: Buffer }> {
    const id = parseRealmCharacterId(input)
    const url = `${RISU_REALM_ORIGIN}/api/v1/download/charx-v3/${encodeURIComponent(id)}`

    let response: Response
    try {
        response = await fetcher(url, {
            headers: { Accept: 'application/charx, application/zip, application/octet-stream' },
            redirect: 'error',
            signal: AbortSignal.timeout(120_000),
        })
    } catch (error) {
        if (error instanceof HttpError) throw error
        throw HttpError.upstream('RisuRealm에서 캐릭터를 다운로드하지 못했습니다.')
    }

    if (response.status === 404) throw HttpError.notFound('RisuRealm 캐릭터를 찾을 수 없습니다.')
    if (!response.ok) {
        throw HttpError.upstream(`RisuRealm 다운로드가 실패했습니다 (HTTP ${response.status}).`)
    }

    const contentLength = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw HttpError.tooLarge(`RisuRealm 카드가 ${Math.floor(maxBytes / 1024 / 1024)}MB 제한을 초과합니다.`)
    }

    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
    if (contentType && !['application/charx', 'application/zip', 'application/octet-stream'].includes(contentType)) {
        throw HttpError.unsupported('RisuRealm이 CHARX 파일 대신 예상하지 못한 응답을 반환했습니다.')
    }
    if (!response.body) throw HttpError.upstream('RisuRealm 다운로드 응답이 비어 있습니다.')

    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    while (true) {
        const { done, value: chunk } = await reader.read()
        if (done) break
        total += chunk.byteLength
        if (total > maxBytes) {
            await reader.cancel()
            throw HttpError.tooLarge(`RisuRealm 카드가 ${Math.floor(maxBytes / 1024 / 1024)}MB 제한을 초과합니다.`)
        }
        chunks.push(Buffer.from(chunk))
    }
    if (total === 0) throw HttpError.upstream('RisuRealm 다운로드 응답이 비어 있습니다.')
    return { id, bytes: Buffer.concat(chunks, total) }
}

function decodeHtml(value: string): string {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
    return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (_, entity: string) => {
        if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
        if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
        return named[entity.toLowerCase()] ?? `&${entity};`
    })
}

function plainText(value: string): string {
    return decodeHtml(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
}

export function realmImportId(card: unknown): string | null {
    const raw = card as any
    const id = raw?.data?.extensions?.risuRealmImportId
        ?? raw?.extentions?.risuRealmImportId
        ?? raw?.extensions?.risuRealmImportId
    return typeof id === 'string' ? id : null
}

export function importedRealmIds(): Set<string> {
    return new Set(db.select({ card: schema.characters.cardJson }).from(schema.characters).all()
        .map((row) => realmImportId(row.card)).filter((id): id is string => Boolean(id)))
}

/** Realm's own sort keys; "recent" is the hub's default and is spelled as an empty value. */
const REALM_SORT_KEYS: Record<RealmBrowseSort, string> = {
    downloads: 'downloads',
    trending: 'trending',
    recent: '',
    recommended: 'recommended',
    random: 'random',
}

/** Realm answers 30 cards per page and pages are zero-based on its side. */
const REALM_PAGE_SIZE = 30

export function isRealmBrowseSort(value: unknown): value is RealmBrowseSort {
    return typeof value === 'string' && value in REALM_SORT_KEYS
}

/**
 * Realm packs the whole query into one path segment delimited by `==` and `&&`,
 * so those characters must never survive user input.
 */
function realmSearchTerm(search: string): string {
    return search.replace(/[=&]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)
}

/** Realm descriptions are multi-language blocks (`# \`ko\`` … `# \`en\`` …). */
function realmDescription(desc: string): string {
    const blocks = new Map<string, string>()
    for (const match of desc.matchAll(/# `([a-z-]{2,10})`\n([\s\S]*?)(?=\n# `|$)/gi)) {
        blocks.set(match[1].toLowerCase(), match[2])
    }
    const text = blocks.get('ko') ?? blocks.get('en') ?? [...blocks.values()][0] ?? desc
    return plainText(text.replace(/[#*_`>|]+/g, ' '))
}

function toSummary(card: any, rank: number, imported: Set<string>): RealmCharacterSummary | null {
    const id = typeof card?.id === 'string' ? card.id : ''
    const name = typeof card?.name === 'string' ? card.name.trim() : ''
    if (!/^[0-9a-f-]{36}$/i.test(id) || !name) return null
    const image = typeof card?.img === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(card.img) ? card.img : null
    return {
        id,
        name,
        creatorName: typeof card?.authorname === 'string' ? card.authorname : '',
        description: realmDescription(typeof card?.desc === 'string' ? card.desc : ''),
        imageUrl: image ? `${RISU_HUB_ORIGIN}/resource/${image}` : null,
        downloads: typeof card?.download === 'string' ? card.download : '',
        tags: Array.isArray(card?.tags) ? card.tags.filter((tag: unknown) => typeof tag === 'string').slice(0, 6) : [],
        rank,
        imported: imported.has(id),
    }
}

/**
 * Queries Realm's public listing API — the same one the RisuAI client uses — so
 * the admin can browse by any of Realm's sort orders or search for a card by
 * name. No Realm account or token is required.
 */
export async function listRealmCharacters(
    query: RealmBrowseQuery = {},
    fetcher: typeof fetch = fetch,
    alreadyImported?: Set<string>,
): Promise<RealmCharacterSummary[]> {
    const sort = isRealmBrowseSort(query.sort) ? query.sort : 'downloads'
    const page = Math.min(100, Math.max(1, Math.trunc(Number(query.page) || 1)))
    const search = realmSearchTerm(query.search ?? '')
    // `__shared` is Realm's marker for publicly listed cards; the client always sends it.
    const args = `search==${search} __shared&&page==${page - 1}&&nsfw==${query.nsfw ? 'true' : 'false'}`
        + `&&sort==${REALM_SORT_KEYS[sort]}&&web==other`
    const url = `${RISU_HUB_ORIGIN}/realm/${encodeURIComponent(args)}?cache=30`

    let response: Response
    try {
        response = await fetcher(url, {
            headers: { accept: 'application/json', 'x-risuai-info': 'RisuAI-KAI;node' },
            signal: AbortSignal.timeout(15_000),
        })
    } catch {
        throw HttpError.upstream('RisuRealm 목록에 연결할 수 없습니다.')
    }
    if (!response.ok) throw HttpError.upstream(`RisuRealm 목록을 불러오지 못했습니다 (HTTP ${response.status}).`)

    let payload: unknown
    try {
        payload = await response.json()
    } catch {
        throw HttpError.upstream('RisuRealm 목록 응답을 해석할 수 없습니다.')
    }
    const cards = Array.isArray(payload) ? payload : (payload as { cards?: unknown })?.cards
    if (!Array.isArray(cards)) throw HttpError.upstream('RisuRealm 목록 형식을 해석할 수 없습니다.')

    const imported = alreadyImported ?? importedRealmIds()
    const results: RealmCharacterSummary[] = []
    for (const card of cards) {
        const summary = toSummary(card, (page - 1) * REALM_PAGE_SIZE + results.length + 1, imported)
        if (summary) results.push(summary)
    }
    return results
}
