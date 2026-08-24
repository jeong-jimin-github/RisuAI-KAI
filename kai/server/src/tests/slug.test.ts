/**
 * Korean slugs used to round-trip badly: `slugify` ran NFKD (to strip Latin
 * accents) which also splits Hangul into jamo, so `이종족은-좋아하세요` was stored
 * decomposed while the browser requested the composed form — a direct visit or
 * a refresh of a character page answered 404.
 */
import { describe, expect, it } from 'vitest'
import { slugCandidates, slugify } from '../util/ids.js'

describe('slugify', () => {
    it('returns composed Hangul, matching what a browser sends', () => {
        const slug = slugify('이종족은 좋아하세요?')

        expect(slug).toBe('이종족은-좋아하세요')
        expect(slug.normalize('NFC')).toBe(slug)
        // Decomposed jamo are letters, so a raw NFKD result would keep them.
        expect(slug).not.toContain('ᄋ')
    })

    it('still strips Latin accents rather than dashing them', () => {
        expect(slugify("Hana's Café!")).toBe('hanas-cafe')
    })

    it('keeps its existing shape for plain ASCII names', () => {
        expect(slugify('Alternate Hunters V2')).toBe('alternate-hunters-v2')
    })

    it('falls back to a random slug when nothing survives', () => {
        expect(slugify('!!!')).toMatch(/^c-[0-9a-z]{8}$/)
    })
})

describe('slugCandidates', () => {
    it('offers both normalizations so pre-fix rows still resolve', () => {
        const composed = '이종족은-좋아하세요'
        const candidates = slugCandidates(composed)

        expect(candidates).toContain(composed)
        expect(candidates).toContain(composed.normalize('NFD'))
        expect(slugCandidates(composed.normalize('NFD'))).toContain(composed)
    })

    it('collapses to a single key for ASCII ids', () => {
        expect(slugCandidates('ch_19ffe95f6ae7868b1c2e526c0ad')).toEqual(['ch_19ffe95f6ae7868b1c2e526c0ad'])
    })
})
