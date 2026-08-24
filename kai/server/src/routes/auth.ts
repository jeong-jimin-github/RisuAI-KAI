/** `/api/auth` — registration, sign-in, sign-out, gateway token rotation. */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { SessionInfo, SiteConfig } from '../../../shared/contract.js'
import { requireAuth } from '../auth/middleware.js'
import {
    clearSessionCookie,
    createSession,
    destroySession,
    findSession,
    rotateGatewayToken,
    setSessionCookie,
} from '../auth/session.js'
import type { DbSession } from '../auth/session.js'
import { db, schema } from '../db/index.js'
import type { DbUser } from '../db/schema.js'
import { getSetting } from '../services/settings.js'
import { hashPassword, verifyPassword } from '../util/crypto.js'
import { HttpError, ok, RateLimiter } from '../util/http.js'
import { newId, newToken } from '../util/ids.js'
import type { KaiEnv } from '../types.js'
import { toPublicUser } from './me.js'

const router = new Hono<KaiEnv>()

/** Only the fields that gate registration; the rest of SiteConfig is irrelevant here. */
type SiteGate = Pick<SiteConfig, 'registrationOpen' | 'inviteOnly' | 'defaultLocale'>
const SITE_GATE_FALLBACK: SiteGate = { registrationOpen: true, inviteOnly: false, defaultLocale: 'ko' }

const loginLimiter = new RateLimiter(10, 15 * 60_000)
// Buckets for addresses that never come back would otherwise live forever.
setInterval(() => loginLimiter.sweep(), 15 * 60_000).unref()

const nowSec = () => Math.floor(Date.now() / 1000)

/* ------------------------------------------------------------------ *
 * Schemas
 * ------------------------------------------------------------------ */

const registerSchema = z.object({
    email: z.string().trim().min(3).max(254).email('Enter a valid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters').max(200),
    displayName: z.string().trim().min(1, 'Enter a display name').max(40),
    inviteCode: z.string().trim().min(1).max(128).optional(),
})

const loginSchema = z.object({
    email: z.string().trim().min(1).max(254),
    password: z.string().min(1).max(200),
})

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

router.post('/register', async (c) => {
    const body = await readJson(c, registerSchema)
    const site = await getSetting<SiteGate>('site', SITE_GATE_FALLBACK)

    // Compared against the explicit values so a partially written settings row
    // cannot accidentally lock the whole instance out of registration.
    if (site.registrationOpen === false) throw HttpError.forbidden('Registration is currently closed')
    const inviteRequired = site.inviteOnly === true

    const email = body.email
    const emailNormalized = email.toLowerCase()
    const displayName = body.displayName
    const passwordHash = await hashPassword(body.password)
    const t = nowSec()

    // Hashing is done above so the transaction stays synchronous and short.
    const user = db.transaction((tx): DbUser => {
        const clash = tx
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(eq(schema.users.emailNormalized, emailNormalized))
            .get()
        if (clash) throw HttpError.conflict('That email is already registered')

        if (inviteRequired) {
            if (!body.inviteCode) throw HttpError.badRequest('An invite code is required')
            // The guarded UPDATE is the claim: two racing registrations cannot
            // both push a single-use code past its limit.
            const claimed = tx
                .update(schema.inviteCodes)
                .set({ useCount: sql`${schema.inviteCodes.useCount} + 1` })
                .where(
                    and(
                        eq(schema.inviteCodes.code, body.inviteCode),
                        lt(schema.inviteCodes.useCount, schema.inviteCodes.maxUses),
                        or(isNull(schema.inviteCodes.expiresAt), gt(schema.inviteCodes.expiresAt, t)),
                    ),
                )
                .run()
            if (claimed.changes !== 1) throw HttpError.badRequest('That invite code is not valid')
        }

        const isFirstUser = !tx.select({ id: schema.users.id }).from(schema.users).get()

        const row: DbUser = {
            id: newId(),
            email,
            emailNormalized,
            passwordHash,
            displayName,
            avatarAssetId: null,
            role: isFirstUser ? 'admin' : 'user',
            status: 'active',
            gatewayToken: newToken(32),
            locale: normalizeLocale(site.defaultLocale),
            createdAt: t,
            lastSeenAt: t,
        }
        tx.insert(schema.users).values(row).run()

        tx.insert(schema.personas)
            .values({
                id: newId(),
                userId: row.id,
                name: displayName,
                prompt: '',
                avatarAssetId: null,
                isDefault: true,
                createdAt: t,
            })
            .run()

        return row
    })

    const session = createSession(user.id, c.req.header('user-agent'), c.get('ip'))
    setSessionCookie(c, session.id)
    return ok(c, sessionInfo(user, session), 201)
})

router.post('/login', async (c) => {
    const body = await readJson(c, loginSchema)
    const emailNormalized = body.email.toLowerCase()

    if (!loginLimiter.take(`${c.get('ip')}|${emailNormalized}`)) {
        throw HttpError.rateLimited('Too many sign-in attempts. Try again in a few minutes.')
    }

    const user = db
        .select()
        .from(schema.users)
        .where(eq(schema.users.emailNormalized, emailNormalized))
        .get()

    if (!user) {
        // Burn the same scrypt work an existing account would have cost, so the
        // response time does not reveal whether the address is registered.
        await verifyPassword(body.password, await dummyHash())
        throw HttpError.unauthorized('Email or password is incorrect')
    }

    if (!(await verifyPassword(body.password, user.passwordHash))) {
        throw HttpError.unauthorized('Email or password is incorrect')
    }

    if (user.status === 'suspended') throw HttpError.forbidden('This account is suspended')
    if (user.status === 'pending') throw HttpError.forbidden('This account is awaiting approval')

    const t = nowSec()
    db.update(schema.users).set({ lastSeenAt: t }).where(eq(schema.users.id, user.id)).run()
    user.lastSeenAt = t

    const session = createSession(user.id, c.req.header('user-agent'), c.get('ip'))
    setSessionCookie(c, session.id)
    return ok(c, sessionInfo(user, session))
})

router.post('/logout', (c) => {
    const sessionId = c.get('sessionId')
    if (sessionId) destroySession(sessionId)
    clearSessionCookie(c)
    return ok(c, {})
})

router.get('/session', requireAuth, (c) => {
    const user = c.get('user')
    const sessionId = c.get('sessionId')
    if (!user || !sessionId) throw HttpError.unauthorized()

    const session = findSession(sessionId)
    if (!session) throw HttpError.unauthorized()

    return ok(c, sessionInfo(user, session))
})

router.post('/gateway-token/rotate', requireAuth, (c) => {
    const user = c.get('user')
    if (!user) throw HttpError.unauthorized()

    const gatewayToken = rotateGatewayToken(user.id)
    user.gatewayToken = gatewayToken
    return ok(c, { gatewayToken })
})

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function sessionInfo(user: DbUser, session: DbSession): SessionInfo {
    return {
        user: toPublicUser(user),
        gatewayToken: user.gatewayToken,
        expiresAt: new Date(session.expiresAt * 1000).toISOString(),
    }
}

function normalizeLocale(locale: SiteConfig['defaultLocale'] | undefined): string {
    return locale === 'en' || locale === 'ja' ? locale : 'ko'
}

/**
 * A single throwaway hash, computed once, used only to spend the same CPU time
 * a real verification would. Never compares equal to anything.
 */
let dummyHashPromise: Promise<string> | null = null
function dummyHash(): Promise<string> {
    if (!dummyHashPromise) dummyHashPromise = hashPassword(newToken(24))
    return dummyHashPromise
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
