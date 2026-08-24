import { describe, expect, it, vi } from 'vitest'
import { downloadRealmCharX, listRealmCharacters, parseRealmCharacterId } from '../services/realm.js'
import { HttpError } from '../util/http.js'

describe('parseRealmCharacterId', () => {
    const uuid = '488a29d9-66c8-4a35-8c82-5c9cfbc3fb04'

    it('accepts a raw id and Realm character/download URLs', () => {
        expect(parseRealmCharacterId(uuid)).toBe(uuid)
        expect(parseRealmCharacterId(`https://realm.risuai.net/character/${uuid}`)).toBe(uuid)
        expect(parseRealmCharacterId(`https://realm.risuai.net/api/v1/download/charx-v3/${uuid}`)).toBe(uuid)
        expect(parseRealmCharacterId(`https://realm.risuai.net/?realm=${uuid}`)).toBe(uuid)
    })

    it('rejects non-Realm hosts and unsafe ids', () => {
        expect(() => parseRealmCharacterId(`https://realm.risuai.net.example/character/${uuid}`)).toThrow(HttpError)
        expect(() => parseRealmCharacterId('https://realm.risuai.net/character/../../admin')).toThrow(HttpError)
        expect(() => parseRealmCharacterId('short')).toThrow(HttpError)
    })
})

describe('downloadRealmCharX', () => {
    const id = '488a29d9-66c8-4a35-8c82-5c9cfbc3fb04'

    it('downloads from the fixed Realm CHARX endpoint', async () => {
        const fetcher = vi.fn(async () => new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
            status: 200,
            headers: { 'content-type': 'application/charx', 'content-length': '4' },
        }))
        const result = await downloadRealmCharX(id, 1024, fetcher)
        expect(result.id).toBe(id)
        expect([...result.bytes]).toEqual([0x50, 0x4b, 0x03, 0x04])
        expect(fetcher).toHaveBeenCalledWith(
            `https://realm.risuai.net/api/v1/download/charx-v3/${id}`,
            expect.objectContaining({ redirect: 'error' }),
        )
    })

    it('rejects oversized responses before buffering them', async () => {
        const fetcher = vi.fn(async () => new Response(new Uint8Array([1]), {
            status: 200,
            headers: { 'content-type': 'application/charx', 'content-length': '2048' },
        }))
        await expect(downloadRealmCharX(id, 1024, fetcher)).rejects.toMatchObject({ status: 413 })
    })
})

describe('listRealmCharacters', () => {
    const id = '488a29d9-66c8-4a35-8c82-5c9cfbc3fb04'
    const card = {
        id,
        name: '테스트 카드',
        desc: '# `ko`\n한국어 **설명**\n# `en`\nEnglish description\n',
        img: '7833baf2bc9df19abb3cf5e0fca3548eb43b97f6041c18099400908e5435dddd',
        download: '783.6k',
        tags: ['판타지', 42],
        authorname: 'milim',
    }
    const respond = (payload: unknown) =>
        vi.fn(async (_url: string | URL | Request) => Response.json(payload))
    const args = (fetcher: ReturnType<typeof respond>) =>
        decodeURIComponent(new URL(String(fetcher.mock.calls[0][0])).pathname.replace('/realm/', ''))

    it('asks Realm for the requested sort, page and search term', async () => {
        const fetcher = respond({ cards: [] })
        await listRealmCharacters({ sort: 'trending', page: 3, search: '학원', nsfw: true }, fetcher, new Set())
        expect(args(fetcher)).toBe('search==학원 __shared&&page==2&&nsfw==true&&sort==trending&&web==other')
    })

    it('defaults to the downloads ranking and strips Realm query separators from the search', async () => {
        const fetcher = respond({ cards: [] })
        await listRealmCharacters({ sort: 'nope' as never, search: 'a==b&&c' }, fetcher, new Set())
        expect(args(fetcher)).toBe('search==a b c __shared&&page==0&&nsfw==false&&sort==downloads&&web==other')
    })

    it('sends the empty sort key Realm uses for its newest feed', async () => {
        const fetcher = respond([])
        await listRealmCharacters({ sort: 'recent' }, fetcher, new Set())
        expect(args(fetcher)).toContain('&&sort==&&web==other')
    })

    it('maps cards to summaries and flags the ones already imported', async () => {
        const fetcher = respond({ cards: [card, { id: 'not-a-uuid', name: 'skip' }] })
        const [summary, ...rest] = await listRealmCharacters({ page: 2 }, fetcher, new Set([id]))
        expect(rest).toEqual([])
        expect(summary).toEqual({
            id,
            name: '테스트 카드',
            creatorName: 'milim',
            description: '한국어 설명',
            imageUrl: `https://sv.risuai.xyz/resource/${card.img}`,
            downloads: '783.6k',
            tags: ['판타지'],
            rank: 31,
            imported: true,
        })
    })

    it('reports upstream failures instead of returning a partial list', async () => {
        const failing = vi.fn(async () => new Response('nope', { status: 502 }))
        await expect(listRealmCharacters({}, failing, new Set())).rejects.toMatchObject({ status: 503 })
    })
})
