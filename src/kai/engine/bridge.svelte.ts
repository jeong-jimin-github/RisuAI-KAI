/**
 * RisuAI engine bridge.
 *
 * RisuAI-KAI keeps the upstream engine — CBS parser, lorebook activation,
 * trigger scripts, regex scripts, the v3 plugin iframe sandbox — completely
 * unmodified, because that is what makes existing RisuAI character cards and
 * plugins work. What changes is *where the engine gets its inputs from*:
 *
 *   upstream RisuAI            RisuAI-KAI
 *   ----------------------     ---------------------------------------------
 *   settings from the UI   ->  RuntimeConfig pushed by the server admin
 *   cards from local disk  ->  cards fetched from the server per chat
 *   keys typed by the user ->  a per-user gateway token, keys never leave server
 *   chats in IndexedDB     ->  IndexedDB as scratch + server as durable store
 *
 * The engine still writes its own local save (`saveDb`), which we leave alone:
 * it is a fast local cache, and letting it behave normally avoids poking at a
 * large amount of upstream code. `syncChat()` is what makes the server
 * authoritative.
 *
 * Everything here is dynamically imported so that browsing the gallery never
 * pays for the tokenizer, WASM and plugin-sandbox bundles.
 */

import {
    DAILY_LIMIT_HEADER,
    DAILY_REMAINING_HEADER,
    DAILY_RESET_HEADER,
    MINUTE_LIMIT_HEADER,
    MINUTE_REMAINING_HEADER,
    MINUTE_RESET_HEADER,
    ROUTED_VIA_HEADER,
    type CharacterDetail,
    type ChatDetail,
    type ChatMessage,
    type RuntimeConfig,
    type UsageQuota,
} from '@kai/shared/contract'
import { api } from '../api/client'
import { appConfig, session } from '../stores/app.svelte'
import { hydrateHostedCharacterAssets } from './assets'
import { hostedLoreBookTokenBudget } from './runtimeConfig'
import { KAI_ACTIVE_CHAT_ID_KEY } from '../../ts/process/request/kaiTrace'

type EngineModules = {
    db: typeof import('../../ts/storage/database.svelte')
    stores: typeof import('../../ts/stores.svelte')
    process: typeof import('../../ts/process/index.svelte')
    globalApi: typeof import('../../ts/globalApi.svelte')
    plugins: typeof import('../../ts/plugins/plugins.svelte')
    modellist: typeof import('../../ts/model/modellist')
    colorscheme: typeof import('../../ts/gui/colorscheme')
    triggers: typeof import('../../ts/process/triggers')
    scriptings: typeof import('../../ts/process/scriptings')
    openAIRequests: typeof import('../../ts/process/request/openAI/requests')
}

export interface EngineChatMessage {
    role: 'user' | 'char'
    data: string
    time?: number
    model?: string
    generationInfo?: { model?: string }
}

let modules: EngineModules | null = null
let bootPromise: Promise<EngineModules> | null = null

/** Character index inside `DBState.db.characters` for the chat we are showing. */
let activeCharIndex = -1
let activeServerChatId: string | null = null

export const engineState = $state({
    booted: false,
    booting: false,
    /** Set when boot fails; the chat screen renders this instead of the composer. */
    error: null as string | null,
    generating: false,
    /** Upstream prompt pipeline stage (0 setup, 1 prompt, 2 memory, 3 request, 4 post-process). */
    processStage: 0,
    /** Most recent upstream/engine error, copied from RisuAI's hidden alert store. */
    generationError: null as string | null,
    /** `x-kai-routed-via` from the last completion, for the "which model" hint. */
    lastRoutedVia: null as string | null,
    /** Post-request per-user allowance, refreshed by response headers/the usage API. */
    usageQuota: null as UsageQuota | null,
})

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function loadModules(): Promise<EngineModules> {
    const [db, stores, process, globalApi, plugins, modellist, colorscheme, triggers, scriptings, openAIRequests] = await Promise.all([
        import('../../ts/storage/database.svelte'),
        import('../../ts/stores.svelte'),
        import('../../ts/process/index.svelte'),
        import('../../ts/globalApi.svelte'),
        import('../../ts/plugins/plugins.svelte'),
        import('../../ts/model/modellist'),
        import('../../ts/gui/colorscheme'),
        import('../../ts/process/triggers'),
        import('../../ts/process/scriptings'),
        import('../../ts/process/request/openAI/requests'),
    ])
    return { db, stores, process, globalApi, plugins, modellist, colorscheme, triggers, scriptings, openAIRequests }
}

/**
 * A deliberately reduced version of upstream `loadData()`.
 *
 * Upstream boot also does Tauri filesystem setup, update checks, Google Drive
 * sync, service-worker registration, TOS alerts and character-URL imports —
 * none of which belong in a hosted multi-user service, and several of which
 * would pop dialogs at the user. We keep only the parts the prompt pipeline and
 * the plugin sandbox actually depend on.
 */
export async function bootEngine(): Promise<EngineModules> {
    if (bootPromise) return bootPromise
    engineState.booting = true

    bootPromise = (async () => {
        const m = await loadModules()
        modules = m

        m.process.chatProcessStage.subscribe((stage) => {
            engineState.processStage = stage
        })
        m.stores.alertStore.subscribe((alert) => {
            if (alert.type === 'error' && alert.msg) engineState.generationError = String(alert.msg)
        })
        m.openAIRequests?.openAIResponseMetadataListeners?.add?.(applyGatewayResponseMetadata)

        await m.globalApi.forageStorage.Init()

        // Start from whatever the local cache holds so plugin storage and
        // translation caches survive reloads; fall back to an empty database.
        let base: ReturnType<typeof m.db.getDatabase>
        try {
            const raw = (await m.globalApi.forageStorage.getItem(
                'database/database.bin',
            )) as unknown as Uint8Array | null
            const { decodeRisuSave, encodeRisuSaveLegacy } = await import('../../ts/storage/risuSave')
            if (!raw) {
                await m.globalApi.forageStorage.setItem('database/database.bin', encodeRisuSaveLegacy({}))
                base = m.db.getDatabase()
            } else {
                base = await decodeRisuSave(raw)
            }
        } catch (e) {
            console.warn('[kai] local engine save unreadable, starting clean', e)
            base = m.db.getDatabase()
        }

        m.db.setDatabase(applyRuntimeConfig(base, appConfig.config))

        m.modellist.registerModelDynamic()
        m.colorscheme.updateColorScheme()
        m.colorscheme.updateTextThemeAndCSS()

        // Plugins come from the admin, not from the user's local store, so they
        // are installed into the database before the loader runs.
        await installAdminPlugins(m)
        try {
            await m.plugins.loadPlugins()
        } catch (e) {
            // A broken third-party plugin must not take the chat screen down.
            console.error('[kai] plugin load failed', e)
        }

        m.stores.loadedStore.set(true)
        engineState.booted = true
        engineState.booting = false
        return m
    })()

    try {
        return await bootPromise
    } catch (e) {
        engineState.booting = false
        engineState.error = e instanceof Error ? e.message : String(e)
        bootPromise = null
        throw e
    }
}

/* ------------------------------------------------------------------ *
 * Admin config -> engine database
 * ------------------------------------------------------------------ */

/**
 * Writes the server's RuntimeConfig into the engine database.
 *
 * This is the single place where "the admin controls everything" becomes true:
 * the model is pinned to RisuAI's `reverse_proxy` provider pointed at our
 * gateway, so the engine's whole request pipeline — including plugin body
 * interceptors and `beforeRequest` replacers — runs unchanged, but no provider
 * credential ever reaches the browser.
 */
function applyRuntimeConfig<T extends Record<string, any>>(base: T, config: RuntimeConfig | null): T {
    const db: any = base
    if (!config) return db

    Object.assign(db, config.preset ?? {})

    // Stock RisuAI raises the old 800-token default during its full bootstrap.
    // KAI deliberately skips that bootstrap, so mirror the migration here or
    // large keyed entries (including mode-selection lore) can never activate.
    db.loreBookToken = hostedLoreBookTokenBudget(db.loreBookToken)

    // Modules carry the display scripts, triggers and lorebooks that shared
    // presets are built around. `db.modules` is the pool; `db.enabledModules`
    // is what `getModules()` actually reads, so both have to be set — a module
    // present but not listed does nothing at all.
    const modules = config.modules ?? []
    db.modules = modules
    db.enabledModules = modules.map((m: any) => m?.id).filter(Boolean)

    // Toggle choices are ordinary global chat variables, which is how the
    // preset's own CBS reads them (`{{getglobalvar::toggle_...}}`). Merged, not
    // replaced: the engine keeps other global variables in the same object.
    db.globalChatVariables = { ...(db.globalChatVariables ?? {}), ...(config.toggleVariables ?? {}) }

    const gen = config.generation
    db.aiModel = 'reverse_proxy'
    db.subModel = 'reverse_proxy'
    // Upstream's globalFetch constructs a URL object before calling fetch, so
    // unlike window.fetch it cannot consume an origin-relative path directly.
    // Resolve it at runtime to preserve same-origin auth behind any host/proxy.
    db.forceReplaceUrl = new URL(config.gateway.url, window.location.origin).toString()
    // 클라이언트 모델 선택은 rev 21 부로 완전히 비활성화됐다. 항상 서버가
    // 지시한 모델 별칭(현재 'auto' → Bedrock 우선)만 사용한다.
    db.customProxyRequestModel = config.gateway.requestModel
    db.proxyKey = session.gatewayToken ?? ''
    db.proxyRequestModel = 'custom'
    db.customTokenizer = 'kai-estimate'
    db.language = config.site.defaultLocale

    db.maxContext = gen.maxContext
    db.maxResponse = gen.maxResponse
    db.temperature = Math.round(gen.temperature * 100)
    db.top_p = gen.topP
    db.frequencyPenalty = Math.round(gen.frequencyPenalty * 100)
    db.PresensePenalty = Math.round(gen.presencePenalty * 100)
    db.useStreaming = gen.streaming

    // Nothing in the KAI client can reach these screens, but a stale local save
    // could still carry them enabled; force them off so the engine never tries
    // to talk to a third party directly from the browser.
    db.textTheme ??= 'standard'
    db.useAutoTranslateInput = false
    db.autoTranslate = false
    // The gateway is same-origin and must never be relayed through RisuAI's
    // public proxy service. Browser credentials/cookies stay on this instance.
    db.usePlainFetch = true
    db.account = undefined
    db.didFirstSetup = true
    db.botSettingAtStart = false
    db.classicMaxWidth = false

    return db
}

async function installAdminPlugins(m: EngineModules) {
    const config = appConfig.config
    if (!config) return
    const db: any = m.db.getDatabase()

    const wanted = config.plugins ?? []
    db.plugins = wanted.map((p) => ({
        name: p.name,
        displayName: p.displayName,
        script: p.source,
        arguments: p.args ?? {},
        realArg: p.args ?? {},
        version: p.apiVersion === '3.0' ? 3 : 2,
    }))
    db.pluginV2 ??= { newPluginList: [] }
    db.pluginV2.newPluginList = db.plugins
    m.db.setDatabaseLite(db)
}

/** Re-applies config after the admin bumps the revision, without a reload. */
export function refreshEngineConfig() {
    if (!modules || !engineState.booted) return
    const m = modules
    m.db.setDatabaseLite(applyRuntimeConfig(m.db.getDatabase(), appConfig.config))
}

/* ------------------------------------------------------------------ *
 * Loading a server chat into the engine
 * ------------------------------------------------------------------ */

function toEngineMessages(messages: ChatMessage[]) {
    return messages
        .filter((msg) => !msg.disabled)
        .map((msg) => ({
            role: msg.role,
            data: msg.content,
            time: msg.time,
            model: msg.model ?? undefined,
            chatId: msg.id,
            name: msg.name ?? undefined,
            generationInfo: msg.model ? { model: msg.model } : undefined,
        }))
}

/**
 * Materialises `character` + `chat` inside the engine database so that
 * `sendChat()` sees exactly what it would see in stock RisuAI.
 */
export async function loadChatIntoEngine(character: CharacterDetail, chat: ChatDetail) {
    const m = await bootEngine()
    const db: any = m.db.getDatabase()
    db[KAI_ACTIVE_CHAT_ID_KEY] = chat.id

    const card: any = hydrateHostedCharacterAssets(structuredClone(character.card), character.assets)
    card.chaId = character.id
    card.type ??= 'character'
    card.customscript ??= []
    card.triggerscript ??= []
    card.emotionImages ??= []
    card.additionalAssets ??= []
    card.ccAssets ??= []
    card.chats = []
    card.chatFolders = []
    card.chatPage = 0

    // Server-hosted assets are plain URLs. `getFileSrc` passes those through
    // (see the guard at the top of it — without that guard it treats every
    // reference as a local file id and resolves card images to `src=""`), so no
    // rewriting is needed beyond the portrait, which the card stores as a bare id.
    if (character.avatarUrl) card.image = character.avatarUrl

    const engineChat = {
        id: chat.id,
        name: chat.title || character.name,
        note: '',
        localLore: [],
        message: toEngineMessages(chat.messages),
        fmIndex: -1,
        lastDate: Date.parse(chat.updatedAt) || Date.now(),
        ...(chat.engineState ?? {}),
    }
    card.chats = [engineChat]

    db.characters ??= []
    const existing = db.characters.findIndex((c: any) => c?.chaId === character.id)
    if (existing >= 0) {
        db.characters[existing] = card
        activeCharIndex = existing
    } else {
        activeCharIndex = db.characters.push(card) - 1
    }

    applyPersonaFromServer(db, chat)

    m.db.setDatabase(db)
    m.stores.selectedCharID.set(activeCharIndex)
    activeServerChatId = chat.id
    engineState.lastRoutedVia = chat.messages.findLast((message) => message.role === 'char' && !!message.model)?.model ?? null
    return m
}

function applyGatewayResponseMetadata(metadata: { url: string; headers: Record<string, string> }) {
    const gateway = appConfig.config?.gateway.url
    if (!gateway) return

    try {
        const expected = new URL(gateway, window.location.origin)
        const actual = new URL(metadata.url, window.location.origin)
        if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) return
    } catch {
        return
    }

    const read = (name: string) => metadata.headers[name] ?? metadata.headers[name.toLowerCase()]
    const routedVia = read(ROUTED_VIA_HEADER)
    if (routedVia) engineState.lastRoutedVia = routedVia

    const minuteLimit = Number(read(MINUTE_LIMIT_HEADER))
    const minuteRemaining = Number(read(MINUTE_REMAINING_HEADER))
    const dailyLimit = Number(read(DAILY_LIMIT_HEADER))
    const dailyRemaining = Number(read(DAILY_REMAINING_HEADER))
    if (![minuteLimit, minuteRemaining, dailyLimit, dailyRemaining].every(Number.isFinite)) return

    engineState.usageQuota = {
        minute: {
            limit: minuteLimit,
            remaining: minuteRemaining,
            resetAt: read(MINUTE_RESET_HEADER) || null,
        },
        daily: {
            limit: dailyLimit,
            remaining: dailyRemaining,
            resetAt: read(DAILY_RESET_HEADER) || null,
        },
    }
}

function applyPersonaFromServer(db: any, chat: ChatDetail) {
    // The user's persona lives on the server; mirror the selected one into the
    // slot the engine reads (`db.username` / `db.personaPrompt`).
    const persona = chat.personaId ? (db.__kaiPersonas ?? []).find((p: any) => p.id === chat.personaId) : null
    if (persona) {
        db.username = persona.name
        db.personaPrompt = persona.prompt
        db.userIcon = persona.avatarUrl ?? ''
    }
}

/** Called by the chat screen after it fetches the persona list. */
export function setEnginePersona(persona: { id: string; name: string; prompt: string; avatarUrl: string | null }) {
    if (!modules) return
    const db: any = modules.db.getDatabase()
    db.username = persona.name
    db.personaPrompt = persona.prompt
    db.userIcon = persona.avatarUrl ?? ''
    modules.db.setDatabaseLite(db)
}

/** Runs stock RisuAI manual/Lua controls rendered inside a parsed message. */
export async function activateEngineControl(origin: Element): Promise<boolean> {
    if (!modules) return false
    const triggerName = origin.getAttribute('risu-trigger')
    const triggerId = origin.getAttribute('risu-id')
    const buttonEvent = origin.getAttribute('risu-btn')
    if (!triggerName && !buttonEvent) return false

    const currentCharacter = modules.db.getCurrentCharacter()
    if (!currentCharacter || currentCharacter.type === 'group') return false

    const result = triggerName
        ? await modules.triggers.runTrigger(currentCharacter, 'manual', {
              chat: modules.db.getCurrentChat(),
              manualName: triggerName,
              triggerId: triggerId || undefined,
          })
        : await modules.scriptings.runLuaButtonTrigger(currentCharacter, buttonEvent!)

    if (result) modules.db.setCurrentChat(result.chat)
    if (triggerName && triggerId) {
        setTimeout(() => modules?.stores.CurrentTriggerIdStore.set(null), 100)
    }
    return true
}

/* ------------------------------------------------------------------ *
 * Generation
 * ------------------------------------------------------------------ */

export interface GenerateHandle {
    abort: () => void
    done: Promise<boolean>
}

/**
 * Appends the user's turn and asks the engine to generate a reply.
 *
 * The engine mutates `DBState.db` in place as the stream arrives, which is what
 * drives the live typing effect in the UI; `onTick` lets the caller observe it
 * without reaching into engine internals.
 */
export function generate(opts: {
    continue?: boolean
    onTick?: (messages: EngineChatMessage[]) => void
}): GenerateHandle {
    if (!modules) throw new Error('engine is not booted')
    const m = modules
    const controller = new AbortController()

    const db: any = m.db.getDatabase()
    const char = db.characters[activeCharIndex]
    if (!char) throw new Error('no active character in the engine database')

    let ticker: ReturnType<typeof setInterval> | null = null
    if (opts.onTick) {
        ticker = setInterval(() => {
            const live = m.db.getDatabase().characters[activeCharIndex]?.chats?.[char.chatPage ?? 0]
            if (live) opts.onTick!(live.message as EngineChatMessage[])
        }, 60)
    }

    // The upstream UI normally clears these stores after every request. KAI
    // calls the engine directly, so a stale `doingChat=true` would make the
    // next turn return false before it even reaches a provider.
    m.process.doingChat.set(false)
    m.process.abortChat.set(false)
    engineState.generating = true
    engineState.generationError = null
    const done = m.process
        .sendChat(-1, { signal: controller.signal, continue: opts.continue })
        .then((ok) => {
            if (!ok && !controller.signal.aborted) {
                throw new Error(engineState.generationError || '답변을 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.')
            }
            return ok
        })
        .finally(() => {
            m.process.doingChat.set(false)
            m.process.abortChat.set(false)
            engineState.generating = false
            if (ticker) clearInterval(ticker)
            if (opts.onTick) {
                const live = m.db.getDatabase().characters[activeCharIndex]?.chats?.[char.chatPage ?? 0]
                if (live) opts.onTick(live.message as EngineChatMessage[])
            }
        })

    return {
        abort: () => {
            controller.abort()
            m.process.abortChat.set(true)
        },
        done,
    }
}

/** Appends a user turn locally and returns its stable message index. */
export function appendEngineUserMessage(content: string): number {
    if (!modules) throw new Error('engine is not booted')
    const db: any = modules.db.getDatabase()
    const char = db.characters[activeCharIndex]
    if (!char) throw new Error('no active character in the engine database')
    const chat = char.chats[char.chatPage ?? 0]
    chat.message.push({ role: 'user', data: content, time: Date.now() })
    modules.db.setDatabaseLite(db)
    return chat.message.length - 1
}

/** Removes only an incomplete response after a user turn, keeping that turn retryable. */
export function discardEngineMessagesAfter(index: number): void {
    if (!modules) return
    const db: any = modules.db.getDatabase()
    const char = db.characters[activeCharIndex]
    const chat = char?.chats?.[char.chatPage ?? 0]
    if (!chat?.message?.[index] || chat.message[index].role !== 'user') return
    chat.message.splice(index + 1)
    modules.db.setDatabaseLite(db)
}

/** Reads the engine's current message list, for rendering and for syncing. */
export function readEngineMessages(): EngineChatMessage[] {
    if (!modules) return []
    const db: any = modules.db.getDatabase()
    const char = db.characters?.[activeCharIndex]
    return char?.chats?.[char.chatPage ?? 0]?.message ?? []
}

/** Engine-side state we must round-trip back to the server verbatim. */
function readEngineState(): Record<string, unknown> {
    if (!modules) return {}
    const db: any = modules.db.getDatabase()
    const chat = db.characters?.[activeCharIndex]?.chats?.[0]
    if (!chat) return {}
    const { message, id, name, lastDate, ...rest } = chat
    return rest
}

/* ------------------------------------------------------------------ *
 * Server sync
 * ------------------------------------------------------------------ */

let syncTimer: ReturnType<typeof setTimeout> | null = null
let syncInFlight: Promise<void> | null = null

/**
 * Pushes the engine's message list to the server.
 *
 * The engine is the source of truth *during* a turn (it rewrites messages via
 * regex scripts and triggers), so we replay its final list rather than trying
 * to mirror each mutation. `lastSyncedCount` keeps the common case — one new
 * assistant message — to a single append.
 */
export async function syncChat(force = false): Promise<void> {
    if (!activeServerChatId || !modules) return
    if (syncInFlight && !force) return syncInFlight

    syncInFlight = (async () => {
        const chatId = activeServerChatId!
        const engineMessages = readEngineMessages()

        try {
            const remote = await api.chats.detail(chatId, { limit: 1000 })
            const remoteMessages = remote.messages

            // Truncate first when the engine dropped messages (regenerate, delete).
            if (engineMessages.length < remoteMessages.length) {
                await api.chats.truncate(chatId, engineMessages.length)
            }

            for (let i = 0; i < engineMessages.length; i++) {
                const local = engineMessages[i]
                const remoteMsg = remoteMessages[i]
                if (remoteMsg && remoteMsg.content === local.data && remoteMsg.role === local.role) continue
                const synced = await api.chats.appendMessage(chatId, {
                    role: local.role,
                    content: local.data,
                    model: local.role === 'char' ? (engineState.lastRoutedVia ?? undefined) : undefined,
                    replaceIdx: remoteMsg ? i : undefined,
                })
                if (local.role === 'char' && synced.model) local.model = synced.model
            }

            await api.chats.setState(chatId, readEngineState())
        } catch (e) {
            console.error('[kai] chat sync failed', e)
            throw e
        }
    })()

    try {
        await syncInFlight
    } finally {
        syncInFlight = null
    }
}

/** Debounced variant for edit-as-you-type paths. */
export function scheduleSync(delayMs = 800) {
    if (syncTimer) clearTimeout(syncTimer)
    syncTimer = setTimeout(() => {
        void syncChat().catch(() => {})
    }, delayMs)
}

/* ------------------------------------------------------------------ *
 * Local message edits (engine-side, then synced)
 * ------------------------------------------------------------------ */

export function editEngineMessage(index: number, content: string) {
    if (!modules) return
    const db: any = modules.db.getDatabase()
    const char = db.characters[activeCharIndex]
    const chat = char.chats[char.chatPage ?? 0]
    if (!chat.message[index]) return
    chat.message[index].data = content
    modules.db.setDatabaseLite(db)
    scheduleSync()
}

/** Updates the card greeting and its visible first message after server persistence succeeds. */
export function setEngineGreeting(greetingIndex: number, content: string) {
    if (!modules) return
    const db: any = modules.db.getDatabase()
    const char = db.characters[activeCharIndex]
    const chat = char.chats[char.chatPage ?? 0]
    chat.fmIndex = greetingIndex === 0 ? -1 : greetingIndex - 1
    if (chat.message[0]?.role === 'char') {
        chat.message[0].data = content
    } else {
        chat.message.unshift({ role: 'char', data: content, time: Date.now() })
    }
    modules.db.setDatabaseLite(db)
}

export function deleteEngineMessage(index: number) {
    if (!modules) return
    const db: any = modules.db.getDatabase()
    const char = db.characters[activeCharIndex]
    const chat = char.chats[char.chatPage ?? 0]
    chat.message.splice(index, 1)
    modules.db.setDatabaseLite(db)
    scheduleSync(0)
}

/** Drops the selected assistant message and everything after it for regeneration. */
export function truncateForRegenerate(index?: number): void {
    if (!modules) return
    const db: any = modules.db.getDatabase()
    const char = db.characters[activeCharIndex]
    const chat = char.chats[char.chatPage ?? 0]
    if (index !== undefined) {
        if (chat.message[index]?.role !== 'char') return
        chat.message.splice(index)
    } else {
        while (chat.message.length && chat.message.at(-1)?.role === 'char') chat.message.pop()
    }
    modules.db.setDatabaseLite(db)
}

export function isEngineReady() {
    return engineState.booted && activeCharIndex >= 0
}

export function currentServerChatId() {
    return activeServerChatId
}
