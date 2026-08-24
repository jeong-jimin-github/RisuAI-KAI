/**
 * /api/personas — the user's own "who am I in this chat" cards.
 *
 * Invariant: at most one persona per user carries `isDefault`, and a user who
 * owns any persona always has exactly one. Both halves are maintained inside
 * the transaction that could break them.
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { and, asc, count, eq, ne } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '../db/index.js'
import type { DbUser } from '../db/schema.js'
import { requireAuth } from '../auth/middleware.js'
import { saveAsset } from '../services/assets.js'
import { assetUrl } from '../services/chat.js'
import { getRuntimeConfig } from '../services/config.js'
import type { KaiEnv } from '../types.js'
import { env } from '../env.js'
import { HttpError, ok } from '../util/http.js'
import { newId } from '../util/ids.js'
import type { Persona } from '../../../shared/contract.js'

const { personas } = schema

const app = new Hono<KaiEnv>()
app.use('*', requireAuth)

type DbPersona = typeof personas.$inferSelect

const MAX_PROMPT_CHARS = 20_000

/* ------------------------------- helpers ------------------------------- */

function user(c: Context<KaiEnv>): DbUser {
    const u = c.get('user')
    if (!u) throw HttpError.unauthorized()
    return u
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

function toPersona(row: DbPersona, profileAvatarAssetId?: string | null): Persona {
    return {
        id: row.id,
        name: row.name,
        prompt: row.prompt,
        avatarUrl: assetUrl(row.avatarAssetId ?? (row.isDefault ? profileAvatarAssetId : null)),
        isDefault: row.isDefault,
        createdAt: new Date(row.createdAt * 1000).toISOString(),
    }
}

function owned(id: string, userId: string): DbPersona {
    const row = db.select().from(personas).where(eq(personas.id, id)).get()
    if (!row || row.userId !== userId) throw HttpError.notFound('Persona not found')
    return row
}

function personaCount(userId: string): number {
    return db.select({ n: count() }).from(personas).where(eq(personas.userId, userId)).get()?.n ?? 0
}

async function assertPersonasEnabled(u: DbUser) {
    const config = await getRuntimeConfig(u)
    if (!config.features.personas) throw HttpError.forbidden('Personas are disabled on this server')
    return config.features
}

/** Clears `isDefault` on every other persona of the same user. */
function makeDefault(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], row: DbPersona) {
    tx.update(personas)
        .set({ isDefault: false })
        .where(and(eq(personas.userId, row.userId), ne(personas.id, row.id)))
        .run()
    tx.update(personas).set({ isDefault: true }).where(eq(personas.id, row.id)).run()
}

/* -------------------------------- routes ------------------------------- */

app.get('/', (c) => {
    const u = user(c)
    const rows = db
        .select()
        .from(personas)
        .where(eq(personas.userId, u.id))
        .orderBy(asc(personas.createdAt), asc(personas.id))
        .all()
    return ok(c, rows.map((row) => toPersona(row, u.avatarAssetId)))
})

const upsertBody = z.object({
    name: z.string().trim().min(1).max(80),
    prompt: z.string().max(MAX_PROMPT_CHARS).default(''),
    isDefault: z.boolean().optional(),
})

app.post('/', async (c) => {
    const u = user(c)
    const features = await assertPersonasEnabled(u)
    const body = await jsonBody(c, upsertBody)

    // A negative cap means "unlimited"; 0 means the admin wants none at all.
    const cap = features.maxPersonas
    const existing = personaCount(u.id)
    if (cap >= 0 && existing >= cap) {
        throw HttpError.forbidden(`You may keep at most ${cap} persona${cap === 1 ? '' : 's'}`)
    }

    const row = db.transaction((tx) => {
        const inserted = tx
            .insert(personas)
            .values({
                id: newPersonaId(),
                userId: u.id,
                name: body.name,
                prompt: body.prompt,
                avatarAssetId: null,
                // The first persona is always the default, so the invariant
                // holds from the moment the user owns one.
                isDefault: body.isDefault === true || existing === 0,
                createdAt: Math.floor(Date.now() / 1000),
            })
            .returning()
            .get()
        if (inserted.isDefault) makeDefault(tx, inserted)
        return tx.select().from(personas).where(eq(personas.id, inserted.id)).get()!
    })

    return ok(c, toPersona(row, u.avatarAssetId), 201)
})

app.get('/:id', (c) => {
    const u = user(c)
    return ok(c, toPersona(owned(c.req.param('id'), u.id), u.avatarAssetId))
})

const patchBody = z
    .object({
        name: z.string().trim().min(1).max(80).optional(),
        prompt: z.string().max(MAX_PROMPT_CHARS).optional(),
        isDefault: z.boolean().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' })

function applyPatch(
    row: DbPersona,
    patch: { name?: string; prompt?: string; isDefault?: boolean },
): DbPersona {
    return db.transaction((tx) => {
        const set: { name?: string; prompt?: string } = {}
        if (patch.name !== undefined) set.name = patch.name
        if (patch.prompt !== undefined) set.prompt = patch.prompt
        if (Object.keys(set).length > 0) {
            tx.update(personas).set(set).where(eq(personas.id, row.id)).run()
        }
        if (patch.isDefault === true) makeDefault(tx, row)
        // Un-defaulting is only honoured while another persona can take over;
        // otherwise the user would end up with no default at all.
        if (patch.isDefault === false && row.isDefault) {
            const heir = tx
                .select()
                .from(personas)
                .where(and(eq(personas.userId, row.userId), ne(personas.id, row.id)))
                .orderBy(asc(personas.createdAt), asc(personas.id))
                .limit(1)
                .get()
            if (heir) makeDefault(tx, heir)
        }
        return tx.select().from(personas).where(eq(personas.id, row.id)).get()!
    })
}

app.patch('/:id', async (c) => {
    const u = user(c)
    const row = owned(c.req.param('id'), u.id)
    const body = await jsonBody(c, patchBody)
    return ok(c, toPersona(applyPatch(row, body), u.avatarAssetId))
})

/** Full replace, taking the contract's `PersonaUpsertBody` verbatim. */
app.put('/:id', async (c) => {
    const u = user(c)
    const row = owned(c.req.param('id'), u.id)
    const body = await jsonBody(c, upsertBody)
    return ok(c, toPersona(applyPatch(row, body), u.avatarAssetId))
})

app.delete('/:id', (c) => {
    const u = user(c)
    const row = owned(c.req.param('id'), u.id)
    db.transaction((tx) => {
        tx.delete(personas).where(eq(personas.id, row.id)).run()
        if (!row.isDefault) return
        const heir = tx
            .select()
            .from(personas)
            .where(eq(personas.userId, row.userId))
            .orderBy(asc(personas.createdAt), asc(personas.id))
            .limit(1)
            .get()
        if (heir) tx.update(personas).set({ isDefault: true }).where(eq(personas.id, heir.id)).run()
    })
    return ok(c, { id: row.id })
})

/* -------------------------------- avatar ------------------------------- */

const IMAGE_TYPES: Record<string, string> = {
    png: 'image/png',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
}

/** Magic-byte sniff — the multipart `Content-Type` is client-controlled. */
function sniffImage(buf: Buffer): string | null {
    if (buf.length >= 12) {
        if (buf.subarray(0, 4).toString('hex') === '89504e47') return IMAGE_TYPES.png
        if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return IMAGE_TYPES.jpeg
        if (buf.subarray(0, 3).toString('ascii') === 'GIF') return IMAGE_TYPES.gif
        if (
            buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
            buf.subarray(8, 12).toString('ascii') === 'WEBP'
        ) {
            return IMAGE_TYPES.webp
        }
    }
    return null
}

app.post('/:id/avatar', async (c) => {
    const u = user(c)
    const row = owned(c.req.param('id'), u.id)

    let form: Record<string, unknown>
    try {
        form = (await c.req.parseBody()) as Record<string, unknown>
    } catch {
        throw HttpError.badRequest('Expected a multipart/form-data upload')
    }
    const file = form.file ?? form.avatar ?? form.image
    if (!(file instanceof File)) throw HttpError.badRequest('Missing file field')
    if (file.size > env.maxUploadBytes) throw HttpError.tooLarge('Avatar is too large')

    const buf = Buffer.from(await file.arrayBuffer())
    const mime = sniffImage(buf)
    if (!mime) throw HttpError.unsupported('Avatar must be a PNG, JPEG, GIF or WebP image')

    const asset = await saveAsset(buf, mime, 'avatar', u.id)
    const updated = db
        .update(personas)
        .set({ avatarAssetId: asset.id })
        .where(eq(personas.id, row.id))
        .returning()
        .get()!

    return ok(c, toPersona(updated, u.avatarAssetId))
})

export default app

/* ------------------------------------------------------------------ */

function newPersonaId(): string {
    return newId('ps_')
}
