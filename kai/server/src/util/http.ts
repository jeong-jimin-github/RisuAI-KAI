import type { Context } from 'hono'
import type { ApiErrorCode, ApiResult } from '../../../shared/contract.js'

/** Thrown anywhere in a handler; converted to an ApiErr by `onError`. */
export class HttpError extends Error {
    constructor(
        readonly code: ApiErrorCode,
        message: string,
        readonly status: number,
        readonly detail?: unknown,
    ) {
        super(message)
        this.name = 'HttpError'
    }

    static badRequest(m = 'Bad request', detail?: unknown) {
        return new HttpError('bad_request', m, 400, detail)
    }
    static unauthorized(m = 'Sign in required') {
        return new HttpError('unauthorized', m, 401)
    }
    static forbidden(m = 'Not allowed') {
        return new HttpError('forbidden', m, 403)
    }
    static notFound(m = 'Not found') {
        return new HttpError('not_found', m, 404)
    }
    static conflict(m = 'Already exists') {
        return new HttpError('conflict', m, 409)
    }
    static tooLarge(m = 'Payload too large') {
        return new HttpError('payload_too_large', m, 413)
    }
    static unsupported(m = 'Unsupported file type') {
        return new HttpError('unsupported_media', m, 415)
    }
    static rateLimited(m = 'Too many requests', detail?: unknown) {
        return new HttpError('rate_limited', m, 429, detail)
    }
    static upstream(m = 'No model is available right now', detail?: unknown) {
        return new HttpError('upstream_unavailable', m, 503, detail)
    }
    static internal(m = 'Internal error', detail?: unknown) {
        return new HttpError('internal', m, 500, detail)
    }
}

export function ok<T>(c: Context, data: T, status = 200) {
    return c.json<ApiResult<T>>({ ok: true, data }, status as 200)
}

export function fail(c: Context, e: HttpError) {
    return c.json<ApiResult<never>>(
        { ok: false, error: { code: e.code, message: e.message, detail: e.detail } },
        e.status as 400,
    )
}

/** Client IP honouring KAI_TRUST_PROXY. */
export function clientIp(c: Context, trustProxy: boolean): string {
    if (trustProxy) {
        const fwd = c.req.header('x-forwarded-for')
        if (fwd) return fwd.split(',')[0].trim()
        const real = c.req.header('x-real-ip')
        if (real) return real.trim()
    }
    const runtime = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
    return runtime?.incoming?.socket?.remoteAddress ?? 'unknown'
}

/**
 * Whether the browser-facing request used TLS.
 *
 * Cookie security is a property of the current connection, not of the
 * configured canonical URL.  Only honour X-Forwarded-Proto when the operator
 * has explicitly trusted the reverse proxy; otherwise a client could spoof it.
 */
export function requestIsSecure(
    requestUrl: string,
    forwardedProto: string | undefined,
    trustProxy: boolean,
): boolean {
    if (new URL(requestUrl).protocol === 'https:') return true
    if (!trustProxy || !forwardedProto) return false
    return forwardedProto.split(',')[0].trim().toLowerCase() === 'https'
}

/** Fixed-window in-memory limiter. Good enough for a single-process deployment. */
export class RateLimiter {
    private buckets = new Map<string, { count: number; resetAt: number }>()

    constructor(
        private readonly limit: number,
        private readonly windowMs: number,
    ) {}

    /** Returns remaining allowance, or null when the caller is over the limit. */
    take(key: string): { remaining: number; resetAt: number } | null {
        const now = Date.now()
        const b = this.buckets.get(key)
        if (!b || b.resetAt <= now) {
            const resetAt = now + this.windowMs
            this.buckets.set(key, { count: 1, resetAt })
            return { remaining: this.limit - 1, resetAt }
        }
        if (b.count >= this.limit) return null
        b.count++
        return { remaining: this.limit - b.count, resetAt: b.resetAt }
    }

    /** Reads a live bucket without consuming it; absent/expired means unused. */
    peek(key: string): { remaining: number; resetAt: number } | null {
        const b = this.buckets.get(key)
        if (!b) return null
        if (b.resetAt <= Date.now()) {
            this.buckets.delete(key)
            return null
        }
        return { remaining: Math.max(0, this.limit - b.count), resetAt: b.resetAt }
    }

    /** Drops expired buckets; call periodically so the map cannot grow forever. */
    sweep() {
        const now = Date.now()
        for (const [k, v] of this.buckets) if (v.resetAt <= now) this.buckets.delete(k)
    }
}
