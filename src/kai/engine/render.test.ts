import { writable } from 'svelte/store'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Guards the RisuAI render pipeline that KAI's chat screen depends on.
 *
 * A KAI build once shipped with the chat bubble printing `message.data`
 * verbatim, which silently disabled every card-authored display feature at
 * once: CBS substitution (`{{user}}`), CBS conditionals (the `#if`-driven
 * per-language blocks Korean cards use), card assets, and `editdisplay` regex
 * scripts. Nothing failed loudly — the text simply arrived unparsed. These
 * assertions fail if a message ever reaches the screen without ParseMarkdown.
 *
 * `stores.svelte` is mocked, as it is in the CBS tests: its effect roots pull
 * `process/modules` -> `storage/database.svelte` -> `stores.svelte` back around
 * a cycle that throws during module init under Vitest.
 */

const CHAR_ID = 'char_render_test'

function blankCharacter() {
    return {
        type: 'character',
        chaId: CHAR_ID,
        name: '스테프',
        chats: [{ id: 'chat_render_test', name: 'test', message: [], scriptstate: {} }],
        chatPage: 0,
        emotionImages: [] as string[][],
        additionalAssets: [['scene', 'https://kai.test/assets/as_scene', 'webp']],
        customscript: [
            // Stands in for the display regex scripts cards ship with.
            { type: 'editdisplay', in: '\\[STATUS\\]', out: '<div class="status-card"></div>', ableFlag: false },
        ],
        triggerscript: [] as unknown[],
        // Cards drive their per-language blocks off chat variables, which fall
        // back to this string when the chat has not set them yet.
        defaultVariables: 'cv_lang=1',
    }
}

const state = {
    db: {
        username: '지민',
        characters: [blankCharacter()],
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

const { ParseMarkdown } = await import('../../ts/parser/parser.svelte')

beforeEach(() => {
    state.db.characters = [blankCharacter()]
})

async function render(message: string) {
    return await ParseMarkdown(message, state.db.characters[0] as any, 'notrim', 0, {
        firstmsg: true,
        chatRole: 'char',
    })
}

describe('KAI chat message rendering', () => {
    it('substitutes CBS placeholders instead of printing them', async () => {
        const html = await render('{{user}}를 본 {{char}}가 눈을 깜빡였다.')

        expect(html).toContain('지민')
        expect(html).toContain('스테프')
        expect(html).not.toContain('{{user}}')
        expect(html).not.toContain('{{char}}')
    })

    it('resolves CBS conditionals used for per-language blocks', async () => {
        const html = await render(
            '{{#if {{equal::1::1}}}}안녕하세요{{/if}}{{#if {{equal::1::2}}}}Hello{{/if}}',
        )

        expect(html).toContain('안녕하세요')
        expect(html).not.toContain('Hello')
        expect(html).not.toContain('{{#if')
    })

    it('reads chat variables from the card defaults for language blocks', async () => {
        const block =
            '{{#if {{equal::{{getvar::cv_lang}}::1}}}}한국어{{/if}}' +
            '{{#if {{equal::{{getvar::cv_lang}}::2}}}}English{{/if}}'

        expect(await render(block)).toContain('한국어')

        // Without `defaultVariables` the getvar returns 'null', both branches go
        // false, and the entire language section vanishes with no error.
        state.db.characters[0].defaultVariables = ''
        const html = await render(block)
        expect(html).not.toContain('한국어')
        expect(html).not.toContain('English')
    })

    it('resolves card assets to their hosted URL', async () => {
        const html = await render('{{img::scene}}')

        expect(html).toContain('https://kai.test/assets/as_scene')
        expect(html).not.toContain('{{img::scene}}')
    })

    it("applies the character's editdisplay regex scripts", async () => {
        const html = await render('[STATUS]')

        expect(html).toContain('status-card')
        expect(html).not.toContain('[STATUS]')
    })

    it('renders markdown emphasis rather than leaving asterisks', async () => {
        const html = await render('*조용히 말했다*')

        expect(html).toMatch(/<em>|<x-em>/)
    })
})
