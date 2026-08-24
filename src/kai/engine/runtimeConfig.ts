/** Stock RisuAI raises the legacy 800-token default to this during bootstrap. */
export const KAI_MIN_LOREBOOK_TOKENS = 8_000

/**
 * KAI uses a reduced bootstrap path, so reproduce stock RisuAI's lorebook
 * budget migration while preserving any larger value selected by a preset.
 */
export function hostedLoreBookTokenBudget(value: unknown): number {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.max(parsed, KAI_MIN_LOREBOOK_TOKENS) : KAI_MIN_LOREBOOK_TOKENS
}
