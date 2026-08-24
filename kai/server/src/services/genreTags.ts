import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { estimateTokens, routeChat } from '../llm/router.js'
import { getGenerationConfig } from './settings.js'

export const GENRE_TAGS = [
    '시뮬레이션',
    '로맨스',
    '판타지/SF',
    '드라마',
    '무협/사극',
    '공포/추리',
    '액션',
    '코믹/일상',
    '스포츠/학원',
    'BL',
    'GL',
    '기타',
] as const

const genreSet = new Set<string>(GENRE_TAGS)

export function hasGenreTag(tags: unknown): boolean {
    return Array.isArray(tags) && tags.some((tag) => genreSet.has(String(tag)))
}

function cleanTags(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return [...new Set(value.map(String).map((tag) => tag.trim()).filter(Boolean))].slice(0, 3)
}

function fallbackGenres(text: string): string[] {
    const rules: [RegExp, (typeof GENRE_TAGS)[number]][] = [
        [/\b(bl|boys?\s*love|yaoi)\b|보이즈\s*러브|남남\s*연애/i, 'BL'],
        [/\b(gl|girls?\s*love|yuri)\b|걸즈\s*러브|여여\s*연애/i, 'GL'],
        [/romance|love|연애|로맨스|결혼|연인/i, '로맨스'],
        [/fantasy|sci[- ]?fi|magic|isekai|판타지|마법|이세계|우주|미래|사이버펑크/i, '판타지/SF'],
        [/simulat|rpg|game|management|시뮬|육성|경영|게임/i, '시뮬레이션'],
        [/horror|mystery|thriller|괴담|공포|추리|미스터리|스릴러/i, '공포/추리'],
        [/action|battle|war|combat|액션|전투|전쟁|헌터/i, '액션'],
        [/comedy|daily|slice of life|코믹|개그|일상|힐링/i, '코믹/일상'],
        [/wuxia|murim|historical|무협|무림|사극|조선|궁중/i, '무협/사극'],
        [/sport|school|academy|스포츠|학원|학교|아카데미/i, '스포츠/학원'],
        [/drama|family|드라마|가족|성장|비극/i, '드라마'],
    ]
    const result = rules.filter(([pattern]) => pattern.test(text)).map(([, genre]) => genre)
    return [...new Set(result)].slice(0, 3).length ? [...new Set(result)].slice(0, 3) : ['기타']
}

function classificationText(card: Record<string, unknown>): string {
    return [
        card.name,
        card.desc,
        card.personality,
        card.scenario,
        card.firstMessage,
        card.creatorNotes,
        Array.isArray(card.tags) ? card.tags.join(', ') : '',
    ].map((value) => String(value ?? '')).join('\n').slice(0, 7_000)
}

/** Adds one to three canonical Korean genre tags while preserving source tags. */
export async function ensureGenreTags(card: Record<string, unknown>): Promise<string[]> {
    const existing = cleanTags(card.tags)
    const allExisting = Array.isArray(card.tags)
        ? [...new Set(card.tags.map(String).map((tag) => tag.trim()).filter(Boolean))]
        : []
    if (hasGenreTag(allExisting)) return allExisting.slice(0, 30)

    const source = classificationText(card)
    let genres: string[] = []
    try {
        const config = await getGenerationConfig()
        const messages = [
            {
                role: 'system' as const,
                content: `당신은 AI 캐릭터 작품의 장르 분류기입니다. 다음 허용 목록에서 가장 알맞은 장르 1~3개만 JSON 배열로 답하세요. 허용 목록: ${GENRE_TAGS.join(', ')}. 설명이나 마크다운은 금지합니다.`,
            },
            { role: 'user' as const, content: source || String(card.name ?? '') },
        ]
        const out = await routeChat({
            messages,
            maxTokens: 80,
            temperature: 0,
            estimatedTokens: estimateTokens(messages),
            requiresVision: false,
            requiresLanguage: 'ko',
        }, { alias: config.modelAlias, maxAttempts: 3, signal: AbortSignal.timeout(20_000) })
        const match = out.text.match(/\[[\s\S]*?\]/)
        genres = cleanTags(match ? JSON.parse(match[0]) : [])
            .filter((tag) => genreSet.has(tag))
    } catch (error) {
        console.warn('[kai] genre classifier fell back to keyword matching:', error instanceof Error ? error.message : error)
    }

    if (!genres.length) genres = fallbackGenres(`${source}\n${existing.join(' ')}`)
    const next = [...allExisting.filter((tag) => !genreSet.has(tag)).slice(0, 27), ...genres]
    card.tags = next
    return next
}

/** One-time/idempotent repair for cards created before automatic classification. */
export async function backfillMissingGenreTags(): Promise<number> {
    const rows = db.select({ id: schema.characters.id, card: schema.characters.cardJson, tags: schema.characters.tags })
        .from(schema.characters).all()
        .filter((row) => !hasGenreTag(row.tags))
    let updated = 0
    for (const row of rows) {
        const card = structuredClone(row.card) as Record<string, unknown>
        const tags = await ensureGenreTags(card)
        db.update(schema.characters).set({ cardJson: card, tags }).where(eq(schema.characters.id, row.id)).run()
        updated++
    }
    if (updated) console.log(`[kai] added genre tags to ${updated} existing character(s)`)
    return updated
}
