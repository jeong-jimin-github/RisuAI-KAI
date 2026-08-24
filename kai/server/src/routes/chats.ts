/**
 * /api/chats — the user-facing conversation store.
 *
 * Every handler resolves the chat through `getOwnedChat`, which 404s on any id
 * the caller does not own; nothing downstream re-checks ownership because
 * nothing downstream ever sees an unowned row.
 *
 * Optional client capabilities (regenerate, edit, swipes, branching, export)
 * are gated on the admin's `FeatureFlags` here as well as in the UI — the
 * client is dumb by design and is not trusted to enforce its own limits.
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { DbUser } from '../db/schema.js'
import { requireAuth } from '../auth/middleware.js'
import { getRuntimeConfig } from '../services/config.js'
import {
    addSwipe,
    appendMessage,
    branchChat,
    buildChatExport,
    chatDetail,
    chatSummary,
    createChat,
    deleteChat,
    deleteMessageAt,
    deleteMessagesFrom,
    getOwnedChat,
    listChats,
    selectSwipe,
    selectChatGreeting,
    setEngineState,
    updateChat,
    DEFAULT_MESSAGE_WINDOW,
    MAX_MESSAGE_WINDOW,
} from '../services/chat.js'
import type { KaiEnv } from '../types.js'
import { HttpError, ok } from '../util/http.js'
import type { FeatureFlags } from '../../../shared/contract.js'

const chats = new Hono<KaiEnv>()
chats.use('*', requireAuth)

/* ------------------------------- helpers ------------------------------- */

function user(c: Context<KaiEnv>): DbUser {
    const u = c.get('user')
    if (!u) throw HttpError.unauthorized()
    return u
}

type BooleanFeature = {
    [K in keyof FeatureFlags]: FeatureFlags[K] extends boolean ? K : never
}[keyof FeatureFlags]

async function requireFeature(u: DbUser, flag: BooleanFeature, label: string) {
    const config = await getRuntimeConfig(u)
    if (!config.features[flag]) throw HttpError.forbidden(`${label} is disabled on this server`)
}

async function jsonBody<T>(
    c: Context<KaiEnv>,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<T> {
    let raw: unknown
    try {
        raw = await c.req.json()
    } catch {
        throw HttpError.badRequest('Body must be valid JSON')
    }
    const parsed = schema.safeParse(raw)
    if (!parsed.success) throw HttpError.badRequest('Invalid request body', parsed.error.flatten())
    return parsed.data
}

function query<T>(c: Context<KaiEnv>, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
    const parsed = schema.safeParse(c.req.query())
    if (!parsed.success) throw HttpError.badRequest('Invalid query', parsed.error.flatten())
    return parsed.data
}

function pathIndex(c: Context<KaiEnv>, name = 'idx'): number {
    const raw = c.req.param(name)
    const n = Number.parseInt(raw ?? '', 10)
    if (!Number.isInteger(n) || n < 0) throw HttpError.badRequest(`${name} must be a non-negative integer`)
    return n
}

const boolish = z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((v) => v === true || v === 'true' || v === '1')

const engineStateSchema = z.record(z.unknown())

/* -------------------------------- routes ------------------------------- */

const listQuery = z.object({
    characterId: z.string().min(1).optional(),
    archived: boolish.optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
})

chats.get('/', (c) => {
    const u = user(c)
    const q = query(c, listQuery)
    return ok(c, listChats(u.id, q))
})

const createBody = z.object({
    characterId: z.string().min(1),
    personaId: z.string().min(1).optional(),
    greetingIndex: z.coerce.number().int().min(0).optional(),
})

chats.post('/', async (c) => {
    const u = user(c)
    const body = await jsonBody(c, createBody)
    const chat = createChat(u.id, body.characterId, body.personaId, body.greetingIndex)
    return ok(c, chatDetail(chat), 201)
})

const detailQuery = z.object({
    before: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_MESSAGE_WINDOW).optional(),
})

chats.get('/:id', (c) => {
    const u = user(c)
    const chat = getOwnedChat(c.req.param('id'), u.id)
    const q = query(c, detailQuery)
    // `total` lives on ChatSummary.messageCount, which chatDetail already fills.
    return ok(c, chatDetail(chat, { before: q.before, limit: q.limit ?? DEFAULT_MESSAGE_WINDOW }))
})

const greetingBody = z.object({ greetingIndex: z.coerce.number().int().min(0) })

chats.put('/:id/greeting', async (c) => {
    const u = user(c)
    const chat = getOwnedChat(c.req.param('id'), u.id)
    const body = await jsonBody(c, greetingBody)
    return ok(c, selectChatGreeting(chat.id, body.greetingIndex))
})

const appendBody = z.object({
    role: z.enum(['user', 'char']),
    content: z.string(),
    name: z.string().max(200).optional(),
    model: z.string().max(200).optional(),
    replaceIdx: z.coerce.number().int().min(0).optional(),
    engineState: engineStateSchema.optional(),
})

chats.post('/:id/messages', async (c) => {
    const u = user(c)
    const chat = getOwnedChat(c.req.param('id'), u.id)
    const body = await jsonBody(c, appendBody)
    if (body.replaceIdx !== undefined) await requireFeature(u, 'editMessage', 'Editing messages')
    return ok(c, appendMessage(chat.id, body))
})

chats.delete('/:id/messages/:idx', async (c) => {
    const u = user(c)
    const chat = getOwnedChat(c.req.param('id'), u.id)
    await requireFeature(u, 'deleteMessage', 'Deleting messages')
    deleteMessageAt(chat.id, pathIndex(c))
    return ok(c, chatSummary(getOwnedChat(chat.id, u.id)))
})

const truncateBody = z.object({ fromIdx: z.coerce.number().int().min(0) })

chats.post('/:id/truncate', async (c) => {
    const u = user(c)
    const chat = getOwnedChat(c.req.param('id'), u.id)
    const body = await jsonBody(c, truncateBody)
    await requireFeature(u, 'regenerate', 'Regenerating')
    deleteMessagesFrom(chat.id, body.fromIdx)
    return ok(c, chatSummary(getOwnedChat(chat.id, u.id)))
})

const swipeAddBody = z.object({ content: z.string() })

chats.post('/:id/messages/:idx/swipe', async (c) => {
    const u = user(c)
    const chat = getOwnedChat(c.req.param('id'), u.id)
    const body = await jsonBody(c, swipeAddBody)
    await requireFeature(u, 'swipes', 'Swipes')
    return ok(c, addSwipe(chat.id, pathIndex(c), body.content), 201)
})

const swipeSelectBody = z.object({ swipeIndex: z.coerce.number().int().min(0) })

chats.put('/:id/messages/:idx/swipe', async (c) => {
    const u = user(c)
    const chat = getOwnedChat(c.req.param('id'), u.id)
    const body = await jsonBody(c, swipeSelectBody)
    await requireFeature(u, 'swipes', 'Swipes')
    return ok(c, selectSwipe(chat.id, pathIndex(c), body.swipeIndex))
})

const patchBody = z
    .object({
        title: z.string().min(1).max(200).optional(),
        pinned: z.boolean().optional(),
        archived: z.boolean().optional(),
        personaId: z.string().min(1).nullable().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' })

chats.patch('/:id', async (c) => {
    const u = user(c)
    const chat = getOwnedChat(c.req.param('id'), u.id)
    const body = await jsonBody(c, patchBody)
    return ok(c, chatSummary(updateChat(chat, body)))
})

/**
 * Accepts either `{ engineState: {...} }` or the raw state object, because the
 * engine has no reason to know which envelope we prefer.
 */
const stateBody = z.union([
    // `.strict()` so a state blob that merely happens to contain an
    // `engineState` key is not mistaken for the envelope and unwrapped.
    z
        .object({ engineState: engineStateSchema })
        .strict()
        .transform((v) => v.engineState),
    engineStateSchema,
])

chats.put('/:id/state', async (c) => {
    const u = user(c)
    const chat = getOwnedChat(c.req.param('id'), u.id)
    const state = await jsonBody(c, stateBody)
    setEngineState(chat.id, state)
    return ok(c, chatSummary(getOwnedChat(chat.id, u.id)))
})

const branchBody = z.object({ uptoIdx: z.coerce.number().int().min(0) })

chats.post('/:id/branch', async (c) => {
    const u = user(c)
    const chat = getOwnedChat(c.req.param('id'), u.id)
    const body = await jsonBody(c, branchBody)
    await requireFeature(u, 'branchChat', 'Branching')
    return ok(c, chatSummary(branchChat(chat.id, body.uptoIdx)), 201)
})

chats.delete('/:id', (c) => {
    const u = user(c)
    const chat = getOwnedChat(c.req.param('id'), u.id)
    deleteChat(chat.id, u.id)
    return ok(c, { id: chat.id })
})

/**
 * A plain file download, deliberately outside the `ApiOk` envelope: the body is
 * a stock RisuAI `risuChat` v2 document so it can be dropped straight into
 * upstream RisuAI's chat importer.
 */
chats.get('/:id/export', async (c) => {
    const u = user(c)
    const chat = getOwnedChat(c.req.param('id'), u.id)
    await requireFeature(u, 'exportChat', 'Chat export')
    const { filename, payload } = buildChatExport(chat)

    const ascii = filename.replace(/[^\x20-\x7e]/g, '').replace(/"/g, '') || 'chat.json'
    c.header('Content-Type', 'application/json; charset=utf-8')
    c.header(
        'Content-Disposition',
        `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    )
    return c.body(JSON.stringify(payload, null, 2))
})

export default chats
