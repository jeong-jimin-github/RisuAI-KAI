/**
 * Session lifecycle and the cookie that carries it.
 *
 * Session ids are the credential themselves — 32 random bytes, stored verbatim
 * in `sessions.id`. There is nothing to forge and nothing to sign, so no HMAC
 * wrapper is needed; revocation is a row delete.
 */

import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { and, eq, lte, ne } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import type { DbUser } from '../db/schema.js'
import { env } from '../env.js'
import { tokensEqual } from '../util/crypto.js'
import { requestIsSecure } from '../util/http.js'
import { newToken } from '../util/ids.js'

export type DbSession = typeof schema.sessions.$inferSelect

export interface ResolvedSession {
    user: DbUser
    session: DbSession
}

export const SESSION_COOKIE = 'kai_session'

const SESSION_TTL_SECONDS = env.sessionTtlDays * 24 * 60 * 60
/** A `lastSeenAt` write per request would double the write load for nothing. */
const LAST_SEEN_REFRESH_SECONDS = 5 * 60

const nowSec = () => Math.floor(Date.now() / 1000)

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

export function createSession(
    userId: string,
    ua: string | null | undefined,
    ip: string | null | undefined,
): DbSession {
    const created = nowSec()
    const row: DbSession = {
        id: newToken(32),
        userId,
        expiresAt: created + SESSION_TTL_SECONDS,
        createdAt: created,
        userAgent: ua ? ua.slice(0, 512) : null,
        ip: ip ?? null,
    }
    db.insert(schema.sessions).values(row).run()
    return row
}

/** Returns null for unknown, expired (which it also reaps) or orphaned sessions. */
export function resolveSession(sessionId: string): ResolvedSession | null {
    if (!sessionId) return null

    const session = db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.id, sessionId))
        .get()
    if (!session) return null

    const t = nowSec()
    if (session.expiresAt <= t) {
        destroySession(session.id)
        return null
    }

    const user = db.select().from(schema.users).where(eq(schema.users.id, session.userId)).get()
    if (!user) {
        // FK cascade should make this impossible; treat it as a dangling row.
        destroySession(session.id)
        return null
    }

    touchLastSeen(user, t)
    return { user, session }
}

export function findSession(sessionId: string): DbSession | null {
    if (!sessionId) return null
    return db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get() ?? null
}

export function destroySession(sessionId: string): void {
    if (!sessionId) return
    db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId)).run()
}

/** Signs every device out. `exceptSessionId` keeps the caller's own session alive. */
export function destroyAllSessions(userId: string, exceptSessionId?: string): number {
    const where = exceptSessionId
        ? and(eq(schema.sessions.userId, userId), ne(schema.sessions.id, exceptSessionId))
        : eq(schema.sessions.userId, userId)
    return db.delete(schema.sessions).where(where).run().changes
}

export function sweepExpiredSessions(): number {
    return db.delete(schema.sessions).where(lte(schema.sessions.expiresAt, nowSec())).run().changes
}

function touchLastSeen(user: DbUser, t: number): void {
    if (user.lastSeenAt !== null && t - user.lastSeenAt < LAST_SEEN_REFRESH_SECONDS) return
    db.update(schema.users).set({ lastSeenAt: t }).where(eq(schema.users.id, user.id)).run()
    user.lastSeenAt = t
}

/* ------------------------------------------------------------------ *
 * Cookie
 * ------------------------------------------------------------------ */

export function setSessionCookie(c: Context, sessionId: string): void {
    setCookie(c, SESSION_COOKIE, sessionId, {
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
        secure: sessionCookieIsSecure(c),
        maxAge: SESSION_TTL_SECONDS,
    })
}

export function clearSessionCookie(c: Context): void {
    deleteCookie(c, SESSION_COOKIE, {
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
        secure: sessionCookieIsSecure(c),
    })
}

export function readSessionCookie(c: Context): string | null {
    return getCookie(c, SESSION_COOKIE) ?? null
}

function sessionCookieIsSecure(c: Context): boolean {
    return requestIsSecure(c.req.url, c.req.header('x-forwarded-proto'), env.trustProxy)
}

/* ------------------------------------------------------------------ *
 * Gateway bearer token
 * ------------------------------------------------------------------ */

/**
 * The unique index makes the lookup exact already; the constant-time compare is
 * there so a future non-unique or prefix-based lookup cannot silently become a
 * timing oracle.
 */
export function resolveGatewayToken(token: string): DbUser | null {
    if (!token) return null
    const user = db
        .select()
        .from(schema.users)
        .where(eq(schema.users.gatewayToken, token))
        .get()
    if (!user) return null
    if (!tokensEqual(user.gatewayToken, token)) return null
    if (user.status !== 'active') return null
    return user
}

/** Issues a fresh gateway token, invalidating the previous one. */
export function rotateGatewayToken(userId: string): string {
    const token = newToken(32)
    db.update(schema.users).set({ gatewayToken: token }).where(eq(schema.users.id, userId)).run()
    return token
}
