/**
 * The middleware chain every request runs through.
 *
 * `attachContext` is mounted once, globally, before any router. The guards are
 * mounted per-route and are the only place that turns "who is this" into a
 * refusal.
 */

import type { MiddlewareHandler } from 'hono'
import type { DbUser } from '../db/schema.js'
import { env } from '../env.js'
import type { KaiEnv } from '../types.js'
import { HttpError, clientIp } from '../util/http.js'
import { readSessionCookie, resolveGatewayToken, resolveSession } from './session.js'

/** Populates `ip`, and `user`/`sessionId` when a live session cookie is present. */
export const attachContext: MiddlewareHandler<KaiEnv> = async (c, next) => {
    let ip = 'unknown'
    try {
        ip = clientIp(c, env.trustProxy)
    } catch {
        // A missing socket (tests, unusual adapters) must not fail the request.
    }
    c.set('ip', ip)

    try {
        const sessionId = readSessionCookie(c)
        if (sessionId) {
            const resolved = resolveSession(sessionId)
            if (resolved) {
                c.set('user', resolved.user)
                c.set('sessionId', resolved.session.id)
            }
        }
    } catch {
        // An unreadable cookie or a transient DB error leaves the request
        // anonymous rather than erroring; the guards below decide what that means.
    }

    await next()
}

export const requireAuth: MiddlewareHandler<KaiEnv> = async (c, next) => {
    const user = c.get('user')
    if (!user) throw HttpError.unauthorized()
    assertActive(user)
    await next()
}

export const requireAdmin: MiddlewareHandler<KaiEnv> = async (c, next) => {
    await requireAuth(c, async () => {
        const user = c.get('user')
        if (!user || user.role !== 'admin') throw HttpError.forbidden('Administrator access required')
        await next()
    })
}

/**
 * The RisuAI engine reaches the gateway through its `reverse_proxy` path, which
 * sends `Authorization: Bearer <proxyKey>`. When the engine runs same-origin the
 * key may be blank, so the session cookie is an accepted fallback.
 */
export const requireGateway: MiddlewareHandler<KaiEnv> = async (c, next) => {
    const bearer = readBearer(c.req.header('authorization'))

    let user: DbUser | null = null
    if (bearer) {
        user = resolveGatewayToken(bearer)
        if (!user) throw HttpError.unauthorized('Invalid gateway token')
    } else {
        const sessionUser = c.get('user')
        if (sessionUser && sessionUser.status === 'active') user = sessionUser
    }

    if (!user) throw HttpError.unauthorized('Gateway token required')
    c.set('gatewayUser', user)
    await next()
}

function readBearer(header: string | undefined): string | null {
    if (!header) return null
    const m = /^Bearer\s+(.*)$/i.exec(header.trim())
    if (!m) return null
    const token = m[1].trim()
    return token.length > 0 ? token : null
}

function assertActive(user: DbUser): void {
    if (user.status === 'active') return
    throw HttpError.forbidden(
        user.status === 'suspended' ? 'This account is suspended' : 'This account is awaiting approval',
    )
}
