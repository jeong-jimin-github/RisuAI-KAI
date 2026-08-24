/**
 * The hosted gateway needs `kai_chat_id` on the outgoing body to attribute usage
 * to a chat and to keep a finished reply when the browser drops mid-stream.
 * `attachKaiChatTrace` shipped with unit tests but was never called from the
 * request builder, so every hosted generation arrived unattributed. These
 * assertions fail if that call site disappears again.
 */
import { describe, expect, it, vi } from 'vitest'

import { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer } from 'src/ts/model/types'
import { KAI_ACTIVE_CHAT_ID_KEY } from '../kaiTrace'

const mocks = vi.hoisted(() => ({
    db: {
        OaiCompAPIKeys: {},
        additionalParams: [],
        autofillRequestUrl: false,
        customModels: [],
        customProxyRequestModel: 'auto',
        localNetworkMode: false,
        maxResponse: 1000,
        modelTools: [] as string[],
        newOAIHandle: true,
        proxyKey: 'gateway-token',
        proxyRequestModel: 'custom',
        requestRetrys: 0,
        seperateParametersEnabled: false,
        temperature: 90,
        __kaiActiveServerChatId: 'ch_hosted',
    } as Record<string, unknown>,
}))

// `stores.svelte` keeps a module-update effect alive during the test run, which
// reaches into the module registry; these stubs keep that effect quiet.
vi.mock('src/ts/storage/database.svelte', () => ({
    appVer: '0.0.0-test',
    getCurrentChat: () => ({ message: [], scriptstate: {} }),
    getCurrentCharacter: () => ({ type: 'character', chats: [], chatPage: 0 }),
    getDatabase: () => mocks.db,
    setDatabase: vi.fn(),
    setDatabaseLite: vi.fn(),
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    addFetchLog: vi.fn(),
    fetchNative: vi.fn(),
    globalFetch: vi.fn(),
    isSameOriginUrl: (url: string) => url.startsWith('https://kai.test/'),
    textifyReadableStream: vi.fn(),
}))

vi.mock('src/ts/stores.svelte', async () => {
    const { writable } = await import('svelte/store')
    return {
        DBState: { db: mocks.db },
        selIdState: { selId: 0 },
        selectedCharID: writable(0),
        CurrentChat: writable(null),
        CurrentCharacter: writable(null),
    }
})

vi.mock('src/lang', () => ({ language: { errors: { httpError: 'HTTP ' } } }))
vi.mock('src/ts/alert', () => ({ alertError: vi.fn() }))
vi.mock('src/ts/platform', () => ({ isNodeServer: true, isTauri: false }))
vi.mock('src/ts/network/localNetwork', () => ({ isLocalNetworkUrl: () => false }))
vi.mock('src/ts/tokenizer', () => ({ strongBan: vi.fn(), tokenizeNum: vi.fn() }))
vi.mock('src/ts/model/openrouter', () => ({ getFreeOpenRouterModels: vi.fn() }))
vi.mock('src/ts/util', () => ({
    checkPersonaBinded: () => null,
    simplifySchema: (schema: unknown) => schema,
}))
vi.mock('../../files/inlays', () => ({ supportsInlayImage: () => false }))
vi.mock('../../templates/chatTemplate', () => ({ applyChatTemplate: vi.fn() }))
vi.mock('../../templates/jsonSchema', () => ({
    extractJSON: (data: string) => data,
    getOpenAIJSONSchema: () => ({ name: 'format', strict: true, schema: {} }),
}))
vi.mock('../../mcp/mcp', () => ({
    callTool: vi.fn(),
    decodeToolCall: vi.fn(),
    encodeToolCall: vi.fn(),
}))

const { requestOpenAI } = await import('./requests')

async function previewBody(overrides: Record<string, any> = {}) {
    const res = await requestOpenAI({
        aiModel: 'reverse_proxy',
        // `requestChatDataMain` copies `db.forceReplaceUrl` onto `customURL`.
        customURL: 'https://kai.test/v1/chat/completions',
        bias: {},
        biasString: [],
        formated: [
            { role: 'system', content: 'Card rules.' },
            { role: 'user', content: 'Hello.' },
        ],
        maxTokens: 500,
        mode: 'model',
        previewBody: true,
        useStreaming: false,
        modelInfo: {
            flags: [LLMFlags.hasFullSystemPrompt],
            format: LLMFormat.OpenAICompatible,
            id: 'reverse_proxy',
            internalID: 'reverse_proxy',
            name: 'Custom API',
            parameters: ['temperature'],
            provider: LLMProvider.AsIs,
            tokenizer: LLMTokenizer.Unknown,
        },
        ...overrides,
    } as any)

    expect(res.type).toBe('success')
    return JSON.parse((res as { result: string }).result).body as Record<string, unknown>
}

describe('hosted chat trace on the outgoing request', () => {
    it('sends the active hosted chat id to the same-origin gateway', async () => {
        mocks.db[KAI_ACTIVE_CHAT_ID_KEY] = 'ch_hosted'
        expect((await previewBody()).kai_chat_id).toBe('ch_hosted')
    })

    it('never leaks the hosted chat id to a third-party reverse proxy', async () => {
        mocks.db[KAI_ACTIVE_CHAT_ID_KEY] = 'ch_hosted'
        const body = await previewBody({ customURL: 'https://someone-elses-proxy.example/v1/chat/completions' })

        expect(body).not.toHaveProperty('kai_chat_id')
    })

    it('omits the field when no hosted chat is open', async () => {
        delete mocks.db[KAI_ACTIVE_CHAT_ID_KEY]

        expect(await previewBody()).not.toHaveProperty('kai_chat_id')
    })
})
