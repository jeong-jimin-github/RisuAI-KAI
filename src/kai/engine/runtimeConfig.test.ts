import { describe, expect, it } from 'vitest'
import { hostedLoreBookTokenBudget, KAI_MIN_LOREBOOK_TOKENS } from './runtimeConfig'

describe('hostedLoreBookTokenBudget', () => {
    it('raises the legacy default to the stock RisuAI minimum', () => {
        expect(hostedLoreBookTokenBudget(800)).toBe(KAI_MIN_LOREBOOK_TOKENS)
    })

    it('uses the minimum when no valid value exists', () => {
        expect(hostedLoreBookTokenBudget(undefined)).toBe(KAI_MIN_LOREBOOK_TOKENS)
        expect(hostedLoreBookTokenBudget('invalid')).toBe(KAI_MIN_LOREBOOK_TOKENS)
    })

    it('preserves a larger preset budget', () => {
        expect(hostedLoreBookTokenBudget(12_000)).toBe(12_000)
    })
})
