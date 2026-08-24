import type { DbUser } from './db/schema.js'

/** Variables available on every Hono context after the middleware chain runs. */
export type KaiVariables = {
    /** Present when a valid session cookie was supplied. */
    user?: DbUser
    /** Present when the request authenticated with a gateway bearer token. */
    gatewayUser?: DbUser
    sessionId?: string
    ip: string
}

export type KaiEnv = { Variables: KaiVariables }
