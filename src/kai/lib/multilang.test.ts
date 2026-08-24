import { writable } from 'svelte/store'
import { describe, expect, it, vi } from 'vitest'

/**
 * Guards the character-description rendering path.
 *
 * Cards published for RisuAI put their creator notes in one field with a
 * `# \`code\`` heading per language, and write markdown inside each block. The
 * KAI character page printed that string verbatim, so readers saw the heading
 * markers, every language at once, and raw asterisks. These assertions fail if
 * the description stops going through the split-then-ParseMarkdown path.
 *
 * `stores.svelte` and `process/modules` are mocked exactly as in
 * `engine/render.test.ts`: their effect roots pull a module cycle that throws
 * during init under Vitest.
 */

const state = {
    db: {
        characters: [] as unknown[],
        globalChatVariables: {},
        templateDefaultVariables: '',
        presetRegex: [] as unknown[],
    } as Record<string, any>,
}

vi.mock(import('../../ts/stores.svelte'), () => ({
    DBState: state,
    selIdState: { selId: 0 },
    selectedCharID: writable(0),
    CharEmotion: writable({}),
    CurrentTriggerIdStore: writable(null),
    ReloadChatPointer: writable({}),
    ReloadGUIPointer: writable(0),
} as unknown as typeof import('../../ts/stores.svelte')))

vi.mock(import('../../ts/process/modules'), () => ({
    moduleUpdate: () => {},
    getModules: () => [],
    getModuleAssets: () => [],
    getModuleRegexScripts: () => [],
    getModuleLorebooks: () => [],
    getModuleTriggers: () => [],
    getModuleToggles: () => [],
} as unknown as typeof import('../../ts/process/modules')))

const { descriptionPreview, multiLangSections, preferredSection } = await import('./multilang')
const { ParseMarkdown } = await import('../../ts/parser/parser.svelte')

const NOTES = [
    '# `ko`',
    '**스테프**의 이야기.',
    '# `en`',
    '*Steph* and her story.',
    '',
].join('\n')

describe('multiLangSections', () => {
    it('splits a RisuAI multi-language string, in the order the author wrote it', () => {
        expect(multiLangSections(NOTES).map((s) => s.code)).toEqual(['ko', 'en'])
        expect(multiLangSections(NOTES)[0].text).toBe('**스테프**의 이야기.')
    })

    it('keeps plain notes as a single unnamed section', () => {
        const sections = multiLangSections('설명만 있는 카드')

        expect(sections).toHaveLength(1)
        expect(sections[0]).toEqual({ code: 'xx', text: '설명만 있는 카드' })
    })

    it('drops preamble text once the string has language headings', () => {
        // Upstream's display has no tab for the leftover `xx` bucket, so text
        // written above the first heading is not reachable.
        const sections = multiLangSections(`buggy preamble\n${NOTES}`)

        expect(sections.map((s) => s.code)).toEqual(['ko', 'en'])
    })

    it('has nothing to render for an empty field', () => {
        expect(multiLangSections('')).toEqual([])
        expect(multiLangSections(undefined as unknown as string)).toEqual([])
    })
})

describe('preferredSection', () => {
    const sections = multiLangSections(NOTES)

    it('follows the instance locale', () => {
        expect(preferredSection(sections, 'ko')?.code).toBe('ko')
        expect(preferredSection(sections, 'en')?.code).toBe('en')
    })

    it('matches on the base language for a regional locale', () => {
        expect(preferredSection(sections, 'ko-KR')?.code).toBe('ko')
    })

    it('falls back to English, then to the first section', () => {
        expect(preferredSection(sections, 'de')?.code).toBe('en')
        expect(preferredSection(multiLangSections('# `ko`\n한국어\n'), 'de')?.code).toBe('ko')
        expect(preferredSection([], 'ko')).toBeNull()
    })
})

describe('description rendering', () => {
    it('renders the selected section as markdown and shows no other language', async () => {
        const korean = multiLangSections(NOTES)[0]
        const html = await ParseMarkdown(korean.text)

        expect(html).toContain('<strong>스테프</strong>')
        expect(html).not.toContain('**')
        expect(html).not.toContain('# `ko`')
        expect(html).not.toContain('Steph')
    })

    it('uses the same localized description as details for a gallery preview', () => {
        expect(descriptionPreview(NOTES, 'ko')).toBe('스테프의 이야기.')
        expect(descriptionPreview(NOTES, 'en')).toBe('Steph and her story.')
    })
})
