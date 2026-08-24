/** `/api/me` — the signed-in user's own account. */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { and, count, desc, eq, ne, sum } from 'drizzle-orm'
import { z } from 'zod'
import type { ClientUsageStatus, PublicUser } from '../../../shared/contract.js'
import { requireAuth } from '../auth/middleware.js'
import {
    clearSessionCookie,
    destroyAllSessions,
} from '../auth/session.js'
import { db, schema } from '../db/index.js'
import type { DbUser } from '../db/schema.js'
import type { KaiEnv } from '../types.js'
import { getUserQuota } from '../services/userQuota.js'
import { saveAsset } from '../services/assets.js'
import { env } from '../env.js'
import { hashPassword, verifyPassword } from '../util/crypto.js'
import { HttpError, ok } from '../util/http.js'

const router = new Hono<KaiEnv>()

router.use('*', requireAuth)

/* ------------------------------------------------------------------ *
 * Shared projection
 * ------------------------------------------------------------------ */

/** Assets are served by id; a user without an avatar asset has no URL at all. */
export function userAvatarUrl(avatarAssetId: string | null | undefined): string | null {
    return avatarAssetId ? `/api/assets/${avatarAssetId}` : null
}

/**
 * `avatarUrl` may be passed explicitly by callers that already resolved it
 * (e.g. an admin listing that joined the assets table); omit it and the id on
 * the user row is used.
 */
export function toPublicUser(user: DbUser, avatarUrl?: string | null): PublicUser {
    return {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: avatarUrl === undefined ? userAvatarUrl(user.avatarAssetId) : avatarUrl,
        role: user.role,
        status: user.status,
        createdAt: new Date(user.createdAt * 1000).toISOString(),
    }
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

const patchSchema = z
    .object({
        displayName: z.string().trim().min(1).max(40).optional(),
        locale: z.enum(['ko', 'en', 'ja']).optional(),
    })
    .refine((v) => v.displayName !== undefined || v.locale !== undefined, {
        message: 'Provide displayName or locale',
    })

const passwordSchema = z.object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(8, 'Password must be at least 8 characters').max(200),
})

const deleteSchema = z.object({
    password: z.string().min(1).max(200),
})

router.get('/', (c) => ok(c, toPublicUser(currentUser(c))))

router.get('/usage', (c) => {
    const user = currentUser(c)
    const last = db
        .select({ providerKey: schema.usageLog.providerKey, upstreamModel: schema.usageLog.upstreamModel })
        .from(schema.usageLog)
        .where(and(eq(schema.usageLog.userId, user.id), eq(schema.usageLog.status, 'ok')))
        .orderBy(desc(schema.usageLog.createdAt))
        .get()
    const lifetime = db
        .select({
            requests: count(),
            inputTokens: sum(schema.usageLog.tokensIn),
            outputTokens: sum(schema.usageLog.tokensOut),
        })
        .from(schema.usageLog)
        .where(eq(schema.usageLog.userId, user.id))
        .get()
    const inputTokens = Number(lifetime?.inputTokens ?? 0)
    const outputTokens = Number(lifetime?.outputTokens ?? 0)
    const status: ClientUsageStatus = {
        lastModel: last ? `${last.providerKey}/${last.upstreamModel}` : null,
        lifetime: {
            requests: lifetime?.requests ?? 0,
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
        },
        quota: getUserQuota(user.id),
    }
    return ok(c, status)
})

router.patch('/', async (c) => {
    const user = currentUser(c)
    const patch = await readJson(c, patchSchema)

    const next: Partial<DbUser> = {}
    if (patch.displayName !== undefined) next.displayName = patch.displayName
    if (patch.locale !== undefined) next.locale = patch.locale

    db.update(schema.users).set(next).where(eq(schema.users.id, user.id)).run()
    return ok(c, toPublicUser({ ...user, ...next }))
})

router.post('/avatar', async (c) => {
    const user = currentUser(c)
    let form: Record<string, unknown>
    try {
        form = (await c.req.parseBody()) as Record<string, unknown>
    } catch {
        throw HttpError.badRequest('Expected a multipart/form-data upload')
    }
    const file = form.file ?? form.avatar ?? form.image
    if (!(file instanceof File)) throw HttpError.badRequest('Missing file field')
    if (file.size > env.maxUploadBytes) throw HttpError.tooLarge('Avatar is too large')

    const bytes = Buffer.from(await file.arrayBuffer())
    const mime = sniffImage(bytes)
    if (!mime) throw HttpError.unsupported('Avatar must be a PNG, JPEG, GIF or WebP image')

    const asset = await saveAsset(bytes, mime, 'avatar', user.id)
    const updated = db
        .update(schema.users)
        .set({ avatarAssetId: asset.id })
        .where(eq(schema.users.id, user.id))
        .returning()
        .get()!
    return ok(c, toPublicUser(updated))
})

router.post('/password', async (c) => {
    const user = currentUser(c)
    const body = await readJson(c, passwordSchema)

    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
        throw HttpError.forbidden('Current password is incorrect')
    }

    const passwordHash = await hashPassword(body.newPassword)
    db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, user.id)).run()

    // Everything else is signed out; the caller keeps working uninterrupted.
    const sessionId = c.get('sessionId')
    destroyAllSessions(user.id, sessionId)

    return ok(c, {})
})

router.delete('/', async (c) => {
    const user = currentUser(c)
    const body = await readJson(c, deleteSchema)

    if (!(await verifyPassword(body.password, user.passwordHash))) {
        throw HttpError.forbidden('Password is incorrect')
    }

    if (user.role === 'admin') {
        const other = db
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(and(eq(schema.users.role, 'admin'), ne(schema.users.id, user.id)))
            .get()
        if (!other) throw HttpError.forbidden('The last administrator account cannot be deleted')
    }

    // Sessions, personas and chats go with it through the FK cascades.
    db.delete(schema.users).where(eq(schema.users.id, user.id)).run()
    clearSessionCookie(c)

    return ok(c, {})
})

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function currentUser(c: Context<KaiEnv>): DbUser {
    const user = c.get('user')
    if (!user) throw HttpError.unauthorized()
    return user
}

function sniffImage(buf: Buffer): string | null {
    if (buf.length < 12) return null
    if (buf.subarray(0, 4).toString('hex') === '89504e47') return 'image/png'
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
    if (buf.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif'
    if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
        return 'image/webp'
    }
    return null
}

async function readJson<T extends z.ZodTypeAny>(c: Context<KaiEnv>, shape: T): Promise<z.infer<T>> {
    let raw: unknown
    try {
        raw = await c.req.json()
    } catch {
        throw HttpError.badRequest('Expected a JSON body')
    }
    const parsed = shape.safeParse(raw)
    if (!parsed.success) {
        throw HttpError.badRequest(
            'Invalid request body',
            parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        )
    }
    return parsed.data
}

export default router
