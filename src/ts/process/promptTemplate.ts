/**
 * Applies the same character-level system-prompt override used by the legacy
 * (non-template) prompt pipeline to a prompt template's main block.
 *
 * Character cards may include `{{original}}` to retain the preset's main
 * prompt. Without that marker, the card system prompt intentionally replaces
 * the preset main prompt, matching the existing non-template behaviour.
 */
export function resolveTemplateMainPrompt(templatePrompt: string, characterSystemPrompt?: string): string {
    return characterSystemPrompt?.replaceAll('{{original}}', templatePrompt) || templatePrompt
}

/**
 * The author-note text for a turn: the chat note plus the card's post-history
 * instructions.
 *
 * `checkCharOrder` normally appends a card's `postHistoryInstructions` to the
 * chat note once and clears the field, so a locally-migrated character reaches
 * this with nothing left to add. Hosted chats are materialised straight from the
 * server and never run that migration, which silently dropped the one slot a
 * card has for instructions that must sit *after* the chat history — where a
 * response-format rule (a status window, a mandatory footer) has to be to
 * survive a preset that defines its own response template later in the prompt.
 */
export function resolveAuthorNoteText(chatNote?: string, postHistoryInstructions?: string): string {
    return [chatNote, postHistoryInstructions]
        .filter((part) => part?.trim())
        .join('\n')
        .trim()
}
