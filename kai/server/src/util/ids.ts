import { randomBytes, randomUUID } from 'node:crypto'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** URL-safe, sortable-ish id: 8 hex chars of time + 12 random. */
export function newId(prefix = ''): string {
    const t = Date.now().toString(16).padStart(11, '0').slice(-11)
    const r = randomBytes(8).toString('hex')
    return `${prefix}${t}${r}`
}

export const uuid = () => randomUUID()

/** Opaque high-entropy token (sessions, gateway tokens, invite codes). */
export function newToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url')
}

/** `Hana's Diner!` -> `hanas-diner`. Collisions are resolved by the caller. */
export function slugify(input: string): string {
    const base = input
        // NFKD splits an accent off its letter so the combining mark is dropped
        // by the filter below (`café` -> `cafe`). It also splits Hangul into
        // jamo, which are letters and therefore survive — so the result is
        // recomposed at the end, or the slug would be a decomposed twin of the
        // name that never matches a URL the browser composed.
        .normalize('NFKD')
        .toLowerCase()
        .replace(/['’]/g, '')
        // Keep CJK: they are legitimate slug content for a Korean-first service.
        .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48)
        .normalize('NFC')
    if (base) return base
    let out = ''
    for (let i = 0; i < 8; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
    return `c-${out}`
}

/**
 * The forms a slug from a URL may legitimately take.
 *
 * Hangul survives a round trip through a URL in either normalization, and rows
 * created before `slugify` recomposed its output still hold the decomposed
 * form, so a lookup that compares the raw string alone answers 404 for a link
 * that is perfectly valid. Latin ids are unaffected: all three forms collapse
 * to one entry.
 */
export function slugCandidates(value: string): string[] {
    return [...new Set([value, value.normalize('NFC'), value.normalize('NFD')])]
}
