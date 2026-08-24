/**
 * Chat store — the durable half of the conversation loop.
 *
 * The RisuAI engine runs in the browser and owns prompt construction, CBS,
 * lorebooks and triggers. This module owns nothing but persistence:
 *
 *  - `engineState` (RisuAI `Chat.scriptstate`, memory blobs, chat variables) is
 *    round-tripped byte-for-byte. It is never parsed or reshaped; only its
 *    serialized size is checked.
 *  - `messages.idx` is dense and 0-based per chat. Every mutation that can open
 *    a hole renumbers inside the same transaction that made it.
 *  - `chats.messageCount`, `chats.updatedAt` and `characters.messageCount` /
 *    `characters.chatCount` are denormalised counters, so they are only ever
 *    touched in the same transaction as the rows they count.
 */

import { and, asc, count, desc, eq, gt, gte, lt, sql } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import type { DbChat, DbCharacter, DbMessage } from '../db/schema.js'
import { HttpError } from '../util/http.js'
import { newId } from '../util/ids.js'
import { getLatestOmniRouteModel } from './omniroute.js'
import type {
    ChatDetail,
    ChatMessage,
    ChatSummary,
    MessageAppendBody,
    Paged,
} from '../../../shared/contract.js'

const { characters, chats, messages, personas } = schema

/** Transaction handle type, borrowed from drizzle's own callback signature. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Serialized engine state above this is refused outright. */
export const MAX_ENGINE_STATE_BYTES = 256 * 1024
/** A single message body above this is refused outright. */
export const MAX_MESSAGE_CHARS = 200_000
export const DEFAULT_MESSAGE_WINDOW = 200
export const MAX_MESSAGE_WINDOW = 1000

const nowSec = () => Math.floor(Date.now() / 1000)
const iso = (unix: number) => new Date(unix * 1000).toISOString()

/**
 * Asset URLs are built here rather than imported so this module has no
 * compile-time dependency on the asset service. Keep in sync with the asset
 * route's mount point.
 */
export function assetUrl(assetId: string | null | undefined): string | null {
    return assetId ? `/api/assets/${assetId}` : null
}

function condense(text: string, max: number): string {
    const flat = text.replace(/\s+/g, ' ').trim()
    return flat.length > max ? flat.slice(0, max) : flat
}

export function defaultChatTitle(characterName: string): string {
    return characterName.trim() || 'New chat'
}

/* ------------------------------------------------------------------ *
 * Validation of the opaque blobs
 * ------------------------------------------------------------------ */

/** Rejects oversized engine state and returns the value unchanged otherwise. */
export function assertEngineStateSize(state: unknown): Record<string, unknown> {
    let serialized: string
    try {
        serialized = JSON.stringify(state ?? {})
    } catch {
        throw HttpError.badRequest('Engine state is not serializable')
    }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_ENGINE_STATE_BYTES) {
        throw HttpError.tooLarge(
            `Engine state exceeds ${Math.floor(MAX_ENGINE_STATE_BYTES / 1024)} KB`,
        )
    }
    return (state ?? {}) as Record<string, unknown>
}

function assertMessageSize(content: string): string {
    if (content.length > MAX_MESSAGE_CHARS) {
        throw HttpError.tooLarge(`Message exceeds ${MAX_MESSAGE_CHARS} characters`)
    }
    return content
}

/* ------------------------------------------------------------------ *
 * Ownership
 * ------------------------------------------------------------------ */

/**
 * Loads a chat only if it belongs to `userId`. Guessing another user's chat id
 * is indistinguishable from guessing a nonexistent one.
 */
export function getOwnedChat(chatId: string, userId: string): DbChat {
    const chat = db.select().from(chats).where(eq(chats.id, chatId)).get()
    if (!chat || chat.userId !== userId) throw HttpError.notFound('Chat not found')
    return chat
}

function getCharacter(characterId: string): DbCharacter {
    const character = db.select().from(characters).where(eq(characters.id, characterId)).get()
    if (!character) throw HttpError.notFound('Character not found')
    return character
}

/* ------------------------------------------------------------------ *
 * Contract projections
 * ------------------------------------------------------------------ */

export function toChatMessage(row: DbMessage): ChatMessage {
    const swipes = Array.isArray(row.swipes) ? (row.swipes as string[]) : undefined
    let model = row.model
    if (row.role === 'char' && (!model || model === 'omniroute/auto' || model === 'auto' || model === 'omniroute')) {
        const latest = getLatestOmniRouteModel()
        if (latest) model = latest
    }
    return {
        id: row.id,
        idx: row.idx,
        role: row.role,
        content: row.content,
        name: row.name,
        time: row.time,
        swipes,
        swipeIndex: swipes ? row.swipeIndex : undefined,
        model,
        disabled: row.disabled,
    }
}

export function toChatSummary(
    chat: DbChat,
    character: Pick<DbCharacter, 'name' | 'avatarAssetId'>,
    lastMessage: string | null,
): ChatSummary {
    return {
        id: chat.id,
        characterId: chat.characterId,
        characterName: character.name,
        characterAvatarUrl: assetUrl(character.avatarAssetId),
        personaId: chat.personaId,
        title: chat.title || defaultChatTitle(character.name),
        lastMessagePreview: lastMessage ? condense(lastMessage, 120) : '',
        messageCount: chat.messageCount,
        pinned: chat.pinned,
        createdAt: iso(chat.createdAt),
        updatedAt: iso(chat.updatedAt),
    }
}

/** Summary for a chat already known to be owned by the caller. */
export function chatSummary(chat: DbChat): ChatSummary {
    const character = db
        .select({ name: characters.name, avatarAssetId: characters.avatarAssetId })
        .from(characters)
        .where(eq(characters.id, chat.characterId))
        .get()
    const last = db
        .select({ content: messages.content })
        .from(messages)
        .where(eq(messages.chatId, chat.id))
        .orderBy(desc(messages.idx))
        .limit(1)
        .get()
    return toChatSummary(chat, character ?? { name: '', avatarAssetId: null }, last?.content ?? null)
}

export interface MessageWindow {
    /** Return messages with `idx` strictly below this. Omit for the newest page. */
    before?: number
    limit?: number
}

export function loadMessages(chatId: string, window: MessageWindow = {}): DbMessage[] {
    const limit = Math.min(Math.max(window.limit ?? DEFAULT_MESSAGE_WINDOW, 1), MAX_MESSAGE_WINDOW)
    const where =
        window.before === undefined
            ? eq(messages.chatId, chatId)
            : and(eq(messages.chatId, chatId), lt(messages.idx, window.before))
    // Take the newest slice, then flip it so callers always see ascending idx.
    const rows = db
        .select()
        .from(messages)
        .where(where)
        .orderBy(desc(messages.idx))
        .limit(limit)
        .all()
    return rows.reverse()
}

export function chatDetail(chat: DbChat, window: MessageWindow = {}): ChatDetail {
    return {
        ...chatSummary(chat),
        messages: loadMessages(chat.id, window).map(toChatMessage),
        engineState: (chat.engineState ?? {}) as Record<string, unknown>,
    }
}

/* ------------------------------------------------------------------ *
 * Listing
 * ------------------------------------------------------------------ */

export interface ChatListOptions {
    characterId?: string
    archived?: boolean
    page?: number
    pageSize?: number
}

export function listChats(userId: string, opts: ChatListOptions = {}): Paged<ChatSummary> {
    const page = Math.max(opts.page ?? 1, 1)
    const pageSize = Math.min(Math.max(opts.pageSize ?? 30, 1), 100)
    const filters = [eq(chats.userId, userId), eq(chats.archived, opts.archived ?? false)]
    if (opts.characterId) filters.push(eq(chats.characterId, opts.characterId))
    const where = and(...filters)

    const total = db.select({ n: count() }).from(chats).where(where).get()?.n ?? 0

    const rows = db
        .select({
            chat: chats,
            characterName: characters.name,
            characterAvatar: characters.avatarAssetId,
            lastMessage: sql<string | null>`(
                SELECT m.content FROM messages m
                WHERE m.chat_id = ${chats.id}
                ORDER BY m.idx DESC LIMIT 1
            )`,
        })
        .from(chats)
        .innerJoin(characters, eq(characters.id, chats.characterId))
        .where(where)
        .orderBy(desc(chats.pinned), desc(chats.updatedAt), desc(chats.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .all()

    return {
        items: rows.map((r) =>
            toChatSummary(
                r.chat,
                { name: r.characterName, avatarAssetId: r.characterAvatar },
                r.lastMessage,
            ),
        ),
        total,
        page,
        pageSize,
    }
}

/* ------------------------------------------------------------------ *
 * Creation
 * ------------------------------------------------------------------ */

function cardOf(character: DbCharacter): Record<string, unknown> {
    const card = character.cardJson
    return card && typeof card === 'object' ? (card as Record<string, unknown>) : {}
}

/** `[firstMessage, ...alternateGreetings]` — index 0 is the default greeting. */
export function greetingsOf(character: DbCharacter): string[] {
    const card = cardOf(character)
    const first = typeof card.firstMessage === 'string' ? card.firstMessage : ''
    const alts = Array.isArray(card.alternateGreetings)
        ? (card.alternateGreetings as unknown[]).filter((g): g is string => typeof g === 'string')
        : []
    return [first, ...alts]
}

function assertVisible(character: DbCharacter, userId: string) {
    const open = character.visibility === 'public'
    if (!open && character.createdBy !== userId) throw HttpError.notFound('Character not found')
}

function assertPersona(personaId: string | undefined | null, userId: string): string | null {
    if (!personaId) return null
    const persona = db.select().from(personas).where(eq(personas.id, personaId)).get()
    if (!persona || persona.userId !== userId) throw HttpError.notFound('Persona not found')
    return persona.id
}

export function createChat(
    userId: string,
    characterId: string,
    personaId?: string,
    greetingIndex?: number,
): DbChat {
    const character = getCharacter(characterId)
    assertVisible(character, userId)
    const persona = assertPersona(personaId, userId)

    const greetings = greetingsOf(character)
    const gi = greetingIndex ?? 0
    if (!Number.isInteger(gi) || gi < 0 || gi >= greetings.length) {
        throw HttpError.badRequest(`greetingIndex must be between 0 and ${greetings.length - 1}`)
    }
    const greeting = greetings[gi] ?? ''

    const ts = nowSec()
    const chatId = newId('ch_')

    return db.transaction((tx) => {
        tx.insert(chats)
            .values({
                id: chatId,
                userId,
                characterId,
                personaId: persona,
                title: defaultChatTitle(character.name),
                engineState: {},
                messageCount: greeting ? 1 : 0,
                pinned: false,
                archived: false,
                createdAt: ts,
                updatedAt: ts,
            })
            .run()

        // An empty greeting is not seeded: a phantom blank message at idx 0
        // would make every later index off-by-one for no gain.
        if (greeting) {
            tx.insert(messages)
                .values({
                    id: newId('ms_'),
                    chatId,
                    idx: 0,
                    role: 'char',
                    content: greeting,
                    name: null,
                    swipes: null,
                    swipeIndex: 0,
                    model: null,
                    disabled: false,
                    time: ts,
                })
                .run()
        }

        tx.update(characters)
            .set({
                chatCount: sql`${characters.chatCount} + 1`,
                messageCount: sql`${characters.messageCount} + ${greeting ? 1 : 0}`,
            })
            .where(eq(characters.id, characterId))
            .run()

        return tx.select().from(chats).where(eq(chats.id, chatId)).get()!
    })
}

/** Selects one of the character card's greetings for the chat's opening scene. */
export function selectChatGreeting(chatId: string, greetingIndex: number): ChatMessage {
    const chat = db.select().from(chats).where(eq(chats.id, chatId)).get()
    if (!chat) throw HttpError.notFound('Chat not found')

    const greetings = greetingsOf(getCharacter(chat.characterId))
    if (!Number.isInteger(greetingIndex) || greetingIndex < 0 || greetingIndex >= greetings.length) {
        throw HttpError.badRequest(`greetingIndex must be between 0 and ${greetings.length - 1}`)
    }
    const content = greetings[greetingIndex]
    if (!content) throw HttpError.badRequest('The selected greeting is empty')

    const state = assertEngineStateSize({
        ...((chat.engineState ?? {}) as Record<string, unknown>),
        fmIndex: greetingIndex === 0 ? -1 : greetingIndex - 1,
    })
    const ts = nowSec()

    return db.transaction((tx) => {
        const existing = tx
            .select()
            .from(messages)
            .where(and(eq(messages.chatId, chatId), eq(messages.idx, 0)))
            .get()

        let row: DbMessage
        if (existing) {
            if (existing.role !== 'char' || !greetings.includes(existing.content)) {
                throw HttpError.conflict('The opening scene is no longer available in this chat')
            }
            row = tx
                .update(messages)
                .set({ content, swipes: null, swipeIndex: 0, model: null })
                .where(eq(messages.id, existing.id))
                .returning()
                .get()
        } else {
            row = tx
                .insert(messages)
                .values({
                    id: newId('ms_'),
                    chatId,
                    idx: 0,
                    role: 'char',
                    content,
                    name: null,
                    swipes: null,
                    swipeIndex: 0,
                    model: null,
                    disabled: false,
                    time: ts,
                })
                .returning()
                .get()
            bumpCounters(tx, chat, 1, ts)
        }

        tx.update(chats)
            .set({ engineState: state, updatedAt: ts })
            .where(eq(chats.id, chatId))
            .run()
        return toChatMessage(row)
    })
}

/* ------------------------------------------------------------------ *
 * Mutation primitives
 * ------------------------------------------------------------------ */

function bumpCounters(tx: Tx, chat: Pick<DbChat, 'id' | 'characterId'>, delta: number, ts: number) {
    tx.update(chats)
        .set({
            messageCount: sql`max(0, ${chats.messageCount} + ${delta})`,
            updatedAt: ts,
        })
        .where(eq(chats.id, chat.id))
        .run()
    if (delta !== 0) {
        tx.update(characters)
            .set({ messageCount: sql`max(0, ${characters.messageCount} + ${delta})` })
            .where(eq(characters.id, chat.characterId))
            .run()
    }
}

function nextIdx(tx: Tx, chatId: string): number {
    const row = tx
        .select({ idx: messages.idx })
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(desc(messages.idx))
        .limit(1)
        .get()
    return row ? row.idx + 1 : 0
}

function messageAt(tx: Tx, chatId: string, idx: number): DbMessage {
    const row = tx
        .select()
        .from(messages)
        .where(and(eq(messages.chatId, chatId), eq(messages.idx, idx)))
        .get()
    if (!row) throw HttpError.notFound('Message not found')
    return row
}

/**
 * Closes the hole left at `fromIdx` by shifting everything after it down by
 * one. Rows are moved in ascending order so the unique (chat_id, idx) index
 * never sees a collision mid-flight.
 */
function renumberFrom(tx: Tx, chatId: string, fromIdx: number) {
    const after = tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.chatId, chatId), gt(messages.idx, fromIdx)))
        .orderBy(asc(messages.idx))
        .all()
    let slot = fromIdx
    for (const row of after) {
        tx.update(messages).set({ idx: slot++ }).where(eq(messages.id, row.id)).run()
    }
}

/** Reads the swipe array, materialising the implicit `[content]` when absent. */
function swipesOf(row: DbMessage): string[] {
    const raw = row.swipes
    if (Array.isArray(raw) && raw.length > 0) {
        return (raw as unknown[]).map((s) => (typeof s === 'string' ? s : String(s ?? '')))
    }
    return [row.content]
}

/* ------------------------------------------------------------------ *
 * Appending / editing
 * ------------------------------------------------------------------ */

export function appendMessage(chatId: string, body: MessageAppendBody): ChatMessage {
    if (body.replaceIdx !== undefined) {
        return replaceMessage(chatId, body.replaceIdx, body.content, body.model, body.engineState)
    }
    assertMessageSize(body.content)
    const state = body.engineState === undefined ? undefined : assertEngineStateSize(body.engineState)

    const chat = db.select().from(chats).where(eq(chats.id, chatId)).get()
    if (!chat) throw HttpError.notFound('Chat not found')
    const ts = nowSec()

    let modelToSave = body.model ?? null
    if (body.role === 'char' && (!modelToSave || modelToSave === 'omniroute/auto' || modelToSave === 'auto' || modelToSave === 'omniroute')) {
        const latest = getLatestOmniRouteModel()
        if (latest) modelToSave = latest
    }

    return db.transaction((tx) => {
        const idx = nextIdx(tx, chatId)
        const row = tx
            .insert(messages)
            .values({
                id: newId('ms_'),
                chatId,
                idx,
                role: body.role,
                content: body.content,
                name: body.name ?? null,
                swipes: null,
                swipeIndex: 0,
                model: modelToSave,
                disabled: false,
                time: ts,
            })
            .returning()
            .get()

        bumpCounters(tx, chat, 1, ts)
        if (state !== undefined) {
            tx.update(chats).set({ engineState: state }).where(eq(chats.id, chatId)).run()
        }
        if (body.role === 'user') autoTitleTx(tx, chat)
        return toChatMessage(row)
    })
}

export function replaceMessage(
    chatId: string,
    idx: number,
    content: string,
    model?: string,
    engineState?: Record<string, unknown>,
): ChatMessage {
    assertMessageSize(content)
    const state = engineState === undefined ? undefined : assertEngineStateSize(engineState)
    const ts = nowSec()

    return db.transaction((tx) => {
        const existing = messageAt(tx, chatId, idx)
        // Editing the visible text also rewrites the swipe it came from, so
        // `swipes[swipeIndex]` never drifts away from `content`.
        let swipes: string[] | null = null
        if (Array.isArray(existing.swipes)) {
            swipes = swipesOf(existing)
            const at = Math.min(Math.max(existing.swipeIndex, 0), swipes.length - 1)
            swipes[at] = content
        }
        let modelToSave = model ?? existing.model ?? null
        if (existing.role === 'char' && (!modelToSave || modelToSave === 'omniroute/auto' || modelToSave === 'auto' || modelToSave === 'omniroute')) {
            const latest = getLatestOmniRouteModel()
            if (latest) modelToSave = latest
        }
        const row = tx
            .update(messages)
            .set({
                content,
                swipes,
                model: modelToSave,
                time: ts,
            })
            .where(eq(messages.id, existing.id))
            .returning()
            .get()

        tx.update(chats).set({ updatedAt: ts }).where(eq(chats.id, chatId)).run()
        if (state !== undefined) {
            tx.update(chats).set({ engineState: state }).where(eq(chats.id, chatId)).run()
        }
        return toChatMessage(row)
    })
}

/* ------------------------------------------------------------------ *
 * Deletion
 * ------------------------------------------------------------------ */

/** Removes one message and closes the gap. Returns the new message count. */
export function deleteMessageAt(chatId: string, idx: number): number {
    const chat = db.select().from(chats).where(eq(chats.id, chatId)).get()
    if (!chat) throw HttpError.notFound('Chat not found')
    const ts = nowSec()

    return db.transaction((tx) => {
        const existing = messageAt(tx, chatId, idx)
        tx.delete(messages).where(eq(messages.id, existing.id)).run()
        renumberFrom(tx, chatId, idx)
        bumpCounters(tx, chat, -1, ts)
        return tx.select({ n: count() }).from(messages).where(eq(messages.chatId, chatId)).get()?.n ?? 0
    })
}

/** Regenerate support: drops `idx` and everything after it. */
export function deleteMessagesFrom(chatId: string, idx: number): number {
    if (!Number.isInteger(idx) || idx < 0) throw HttpError.badRequest('fromIdx must be >= 0')
    const chat = db.select().from(chats).where(eq(chats.id, chatId)).get()
    if (!chat) throw HttpError.notFound('Chat not found')
    const ts = nowSec()

    return db.transaction((tx) => {
        const doomed = tx
            .select({ n: count() })
            .from(messages)
            .where(and(eq(messages.chatId, chatId), gte(messages.idx, idx)))
            .get()?.n ?? 0
        if (doomed > 0) {
            tx.delete(messages)
                .where(and(eq(messages.chatId, chatId), gte(messages.idx, idx)))
                .run()
            bumpCounters(tx, chat, -doomed, ts)
        } else {
            tx.update(chats).set({ updatedAt: ts }).where(eq(chats.id, chatId)).run()
        }
        return doomed
    })
}

export function deleteChat(chatId: string, userId: string): void {
    const chat = getOwnedChat(chatId, userId)
    db.transaction((tx) => {
        tx.delete(chats).where(eq(chats.id, chatId)).run()
        tx.update(characters)
            .set({
                chatCount: sql`max(0, ${characters.chatCount} - 1)`,
                messageCount: sql`max(0, ${characters.messageCount} - ${chat.messageCount})`,
            })
            .where(eq(characters.id, chat.characterId))
            .run()
    })
}

/* ------------------------------------------------------------------ *
 * Swipes
 * ------------------------------------------------------------------ */

/** Adds an alternate generation for a slot and makes it the visible one. */
export function addSwipe(chatId: string, idx: number, content: string): ChatMessage {
    assertMessageSize(content)
    const ts = nowSec()
    return db.transaction((tx) => {
        const existing = messageAt(tx, chatId, idx)
        const swipes = swipesOf(existing)
        swipes.push(content)
        const row = tx
            .update(messages)
            .set({ swipes, swipeIndex: swipes.length - 1, content, time: ts })
            .where(eq(messages.id, existing.id))
            .returning()
            .get()
        tx.update(chats).set({ updatedAt: ts }).where(eq(chats.id, chatId)).run()
        return toChatMessage(row)
    })
}

export function selectSwipe(chatId: string, idx: number, swipeIndex: number): ChatMessage {
    const ts = nowSec()
    return db.transaction((tx) => {
        const existing = messageAt(tx, chatId, idx)
        const swipes = swipesOf(existing)
        if (!Number.isInteger(swipeIndex) || swipeIndex < 0 || swipeIndex >= swipes.length) {
            throw HttpError.badRequest(`swipeIndex must be between 0 and ${swipes.length - 1}`)
        }
        const row = tx
            .update(messages)
            .set({ swipes, swipeIndex, content: swipes[swipeIndex], time: ts })
            .where(eq(messages.id, existing.id))
            .returning()
            .get()
        tx.update(chats).set({ updatedAt: ts }).where(eq(chats.id, chatId)).run()
        return toChatMessage(row)
    })
}

/* ------------------------------------------------------------------ *
 * Chat metadata
 * ------------------------------------------------------------------ */

export function setEngineState(chatId: string, state: unknown): void {
    const checked = assertEngineStateSize(state)
    db.update(chats)
        .set({ engineState: checked, updatedAt: nowSec() })
        .where(eq(chats.id, chatId))
        .run()
}

export function touchChat(chatId: string): void {
    db.update(chats).set({ updatedAt: nowSec() }).where(eq(chats.id, chatId)).run()
}

export interface ChatPatch {
    title?: string
    pinned?: boolean
    archived?: boolean
    personaId?: string | null
}

export function updateChat(chat: DbChat, patch: ChatPatch): DbChat {
    const set: { title?: string; pinned?: boolean; archived?: boolean; personaId?: string | null } =
        {}
    if (patch.title !== undefined) {
        const title = condense(patch.title, 120)
        if (!title) throw HttpError.badRequest('Title cannot be empty')
        set.title = title
    }
    if (patch.pinned !== undefined) set.pinned = patch.pinned
    if (patch.archived !== undefined) set.archived = patch.archived
    if (patch.personaId !== undefined) {
        set.personaId = patch.personaId === null ? null : assertPersona(patch.personaId, chat.userId)
    }
    if (Object.keys(set).length === 0) return chat
    // Metadata edits deliberately do not move the chat up the activity list.
    return db.update(chats).set(set).where(eq(chats.id, chat.id)).returning().get()!
}

/**
 * Names an untouched chat after its first user turn. Runs on every user
 * message; it is a no-op once the title has diverged from the default.
 */
export function autoTitle(chat: DbChat): string {
    return db.transaction((tx) => autoTitleTx(tx, chat))
}

function autoTitleTx(tx: Tx, chat: DbChat): string {
    const character = tx
        .select({ name: characters.name })
        .from(characters)
        .where(eq(characters.id, chat.characterId))
        .get()
    const fallback = defaultChatTitle(character?.name ?? '')
    if (chat.title && chat.title !== fallback) return chat.title

    const firstUser = tx
        .select({ content: messages.content })
        .from(messages)
        .where(and(eq(messages.chatId, chat.id), eq(messages.role, 'user')))
        .orderBy(asc(messages.idx))
        .limit(1)
        .get()
    if (!firstUser) return chat.title

    const title = condense(firstUser.content, 40)
    if (!title) return chat.title
    tx.update(chats).set({ title }).where(eq(chats.id, chat.id)).run()
    return title
}

/* ------------------------------------------------------------------ *
 * Branching
 * ------------------------------------------------------------------ */

/** Deep-copies a chat and its messages up to and including `uptoIdx`. */
export function branchChat(chatId: string, uptoIdx: number): DbChat {
    if (!Number.isInteger(uptoIdx) || uptoIdx < 0) throw HttpError.badRequest('uptoIdx must be >= 0')
    const source = db.select().from(chats).where(eq(chats.id, chatId)).get()
    if (!source) throw HttpError.notFound('Chat not found')

    const ts = nowSec()
    const newChatId = newId('ch_')

    return db.transaction((tx) => {
        const kept = tx
            .select()
            .from(messages)
            .where(and(eq(messages.chatId, chatId), lt(messages.idx, uptoIdx + 1)))
            .orderBy(asc(messages.idx))
            .all()

        tx.insert(chats)
            .values({
                id: newChatId,
                userId: source.userId,
                characterId: source.characterId,
                personaId: source.personaId,
                title: condense(`${source.title} (branch)`, 120),
                engineState: (source.engineState ?? {}) as Record<string, unknown>,
                messageCount: kept.length,
                pinned: false,
                archived: false,
                createdAt: ts,
                updatedAt: ts,
            })
            .run()

        for (const m of kept) {
            tx.insert(messages)
                .values({
                    id: newId('ms_'),
                    chatId: newChatId,
                    idx: m.idx,
                    role: m.role,
                    content: m.content,
                    name: m.name,
                    swipes: m.swipes,
                    swipeIndex: m.swipeIndex,
                    model: m.model,
                    tokensIn: m.tokensIn,
                    tokensOut: m.tokensOut,
                    disabled: m.disabled,
                    time: m.time,
                })
                .run()
        }

        tx.update(characters)
            .set({
                chatCount: sql`${characters.chatCount} + 1`,
                messageCount: sql`${characters.messageCount} + ${kept.length}`,
            })
            .where(eq(characters.id, source.characterId))
            .run()

        return tx.select().from(chats).where(eq(chats.id, newChatId)).get()!
    })
}

/* ------------------------------------------------------------------ *
 * Export — stock RisuAI `risuChat` v2 envelope
 * ------------------------------------------------------------------ */

/** Mirrors RisuAI's `Message` (src/ts/storage/database.svelte.ts). */
interface RisuExportMessage {
    role: 'user' | 'char'
    data: string
    time?: number
    name?: string
    chatId?: string
    disabled?: boolean
    generationInfo?: { model?: string; inputTokens?: number; outputTokens?: number }
}

export interface ChatExport {
    filename: string
    payload: Record<string, unknown>
}

/**
 * Stock RisuAI keeps the greeting out of `Chat.message` — it re-renders it from
 * the card using `fmIndex` (-1 meaning `firstMessage`). We store the greeting as
 * message 0, so it is lifted back out when it still matches a card greeting
 * verbatim; if the user edited it, it stays in `message` and `fmIndex` falls
 * back to -1 rather than silently losing the edit.
 */
export function buildChatExport(chat: DbChat): ChatExport {
    const character = getCharacter(chat.characterId)
    const rows = db
        .select()
        .from(messages)
        .where(eq(messages.chatId, chat.id))
        .orderBy(asc(messages.idx))
        .all()

    let fmIndex = -1
    let body = rows
    if (rows.length > 0 && rows[0].role === 'char') {
        const at = greetingsOf(character).indexOf(rows[0].content)
        if (at >= 0) {
            fmIndex = at === 0 ? -1 : at - 1
            body = rows.slice(1)
        }
    }

    const state = (chat.engineState ?? {}) as Record<string, unknown>
    const message: RisuExportMessage[] = body.map((m) => ({
        role: m.role,
        data: m.content,
        // RisuAI stores milliseconds; our column is unix seconds.
        time: m.time * 1000,
        name: m.name ?? undefined,
        chatId: m.id,
        disabled: m.disabled || undefined,
        generationInfo:
            m.model || m.tokensIn || m.tokensOut
                ? {
                      model: m.model ?? undefined,
                      inputTokens: m.tokensIn ?? undefined,
                      outputTokens: m.tokensOut ?? undefined,
                  }
                : undefined,
    }))

    const data: Record<string, unknown> = {
        // Engine state first: scriptstate, supaMemoryData, hypaV3Data and any
        // other RisuAI chat field the client parked there rides along verbatim.
        ...state,
        message,
        note: typeof state.note === 'string' ? state.note : '',
        name: chat.title || defaultChatTitle(character.name),
        localLore: Array.isArray(state.localLore) ? state.localLore : [],
        fmIndex,
        id: chat.id,
        lastDate: chat.updatedAt * 1000,
    }

    const stamp = new Date().toISOString()
    const filename = `${character.name}_${stamp}_chat`.replace(/[<>:"/\\|?*.,]/g, '') + '.json'

    return { filename, payload: { type: 'risuChat', ver: 2, data, folders: [] } }
}
