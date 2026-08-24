import { writable } from 'svelte/store'
import { describe, expect, it, vi } from 'vitest'

vi.mock(import('../stores.svelte'), () => ({
    DBState: { db: { characters: [] } },
    selIdState: { selId: 0 },
    selectedCharID: writable(0),
    CharEmotion: writable({}),
    CurrentTriggerIdStore: writable(null),
    ReloadChatPointer: writable({}),
    ReloadGUIPointer: writable(0),
} as unknown as typeof import('../stores.svelte')))

// `globalApi.svelte` pulls in the whole store/module graph on import, and
// `stores.svelte` installs an effect root that cycles back through
// `process/modules` -> `storage/database.svelte`. Only pure URL handling is
// under test here, so that leaf is stubbed out.
vi.mock(import('../process/modules'), () => ({
    moduleUpdate: () => {},
    getModules: () => [],
    getModuleAssets: () => [],
    getModuleRegexScripts: () => [],
    getModuleLorebooks: () => [],
    getModuleTriggers: () => [],
    getModuleToggles: () => [],
} as unknown as typeof import('../process/modules')))

const { isSameOriginUrl, getFileSrc } = await import('../globalApi.svelte')

/**
 * RisuAI blocks loopback targets on the web build, because a browser cannot
 * reach another machine's private network. A self-hosted RisuAI-KAI instance is
 * the exception: its LLM gateway is the very origin that served the page, so
 * the request is an ordinary same-origin fetch. Both the `globalFetch` block
 * and the "turn off streaming" guard in the OpenAI request path defer to this.
 */
describe('isSameOriginUrl', () => {
    it('accepts the page origin, in absolute and relative form', () => {
        expect(isSameOriginUrl(`${location.origin}/v1/chat/completions`)).toBe(true)
        expect(isSameOriginUrl('/v1/chat/completions')).toBe(true)
    })

    it('rejects other loopback ports and hosts', () => {
        expect(isSameOriginUrl('http://localhost:11434/v1/chat/completions')).toBe(false)
        expect(isSameOriginUrl('http://192.168.0.10:8080/v1')).toBe(false)
        expect(isSameOriginUrl('https://api.openai.com/v1/chat/completions')).toBe(false)
    })

    it('rejects malformed input rather than throwing', () => {
        expect(isSameOriginUrl('')).toBe(false)
        expect(isSameOriginUrl('not a url')).toBe(false)
    })
})

/**
 * KAI serves character assets as `/api/assets/<id>`. Without a passthrough,
 * `getFileSrc` treats every reference as a locally stored file id, the lookup
 * misses, and each card image renders as `<img src="">`.
 */
describe('getFileSrc', () => {
    it('returns already-resolvable sources untouched', async () => {
        await expect(getFileSrc('/api/assets/as_scene')).resolves.toBe('/api/assets/as_scene')
        await expect(getFileSrc('https://cdn.example/a.png')).resolves.toBe('https://cdn.example/a.png')
        await expect(getFileSrc('data:image/png;base64,AAAA')).resolves.toBe('data:image/png;base64,AAAA')
        await expect(getFileSrc('blob:http://x/y')).resolves.toBe('blob:http://x/y')
    })
})
