import { describe, expect, it } from 'vitest'
import { resolveAuthorNoteText, resolveTemplateMainPrompt } from './promptTemplate'

describe('resolveTemplateMainPrompt', () => {
    it('uses the template main prompt when the character has no override', () => {
        expect(resolveTemplateMainPrompt('preset rules')).toBe('preset rules')
    })

    it('lets a character system prompt replace the template main prompt', () => {
        expect(resolveTemplateMainPrompt('preset rules', 'character rules')).toBe('character rules')
    })

    it('expands {{original}} with the template main prompt', () => {
        expect(resolveTemplateMainPrompt('preset rules', 'character rules\n{{original}}')).toBe(
            'character rules\npreset rules',
        )
    })
})

describe('resolveAuthorNoteText', () => {
    it('is empty when neither source has text', () => {
        expect(resolveAuthorNoteText('', '')).toBe('')
        expect(resolveAuthorNoteText(undefined, undefined)).toBe('')
        expect(resolveAuthorNoteText('  \n ', null as unknown as string)).toBe('')
    })

    it('keeps the chat note alone when the card has no post-history instructions', () => {
        expect(resolveAuthorNoteText('chat note', '')).toBe('chat note')
    })

    it('delivers card post-history instructions on a hosted chat with no note', () => {
        expect(resolveAuthorNoteText('', 'always print the status window last')).toBe(
            'always print the status window last',
        )
    })

    it('appends the card instructions after the chat note, as the migration does', () => {
        expect(resolveAuthorNoteText('chat note', 'status window rules')).toBe('chat note\nstatus window rules')
    })
})

