import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { loadEnvFile } from 'node:process'

// `npm --prefix kai/server ...` runs with kai/server as cwd, while direct
// invocations may run from the repository root. Node does not load .env by
// itself, so support both layouts before reading any configuration values.
// Variables supplied by Docker/the host environment retain precedence.
for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
    if (existsSync(candidate)) loadEnvFile(candidate)
}

function str(name: string, fallback?: string): string {
    const v = process.env[name]
    if (v === undefined || v === '') {
        if (fallback !== undefined) return fallback
        throw new Error(`Missing required environment variable: ${name}`)
    }
    return v
}

function int(name: string, fallback: number): number {
    const v = process.env[name]
    if (!v) return fallback
    const n = Number.parseInt(v, 10)
    if (Number.isNaN(n)) throw new Error(`Environment variable ${name} must be an integer, got "${v}"`)
    return n
}

function bool(name: string, fallback: boolean): boolean {
    const v = process.env[name]
    if (v === undefined || v === '') return fallback
    return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes'
}

const dataDir = resolve(str('KAI_DATA_DIR', './data'))
mkdirSync(dataDir, { recursive: true })
mkdirSync(resolve(dataDir, 'assets'), { recursive: true })

/**
 * The secret protects session ids and encrypts provider API keys at rest.
 * A generated fallback keeps `npm run dev` frictionless but is regenerated on
 * every boot — sessions and stored provider keys will not survive a restart, so
 * production deployments must set it. We shout about it rather than fail, and
 * refuse to start without it when NODE_ENV=production.
 */
function resolveSecret(): string {
    const provided = process.env.KAI_SECRET
    if (provided && provided.length >= 32) return provided
    if (process.env.NODE_ENV === 'production') {
        throw new Error('KAI_SECRET must be set to at least 32 characters in production')
    }
    const generated = randomBytes(32).toString('hex')
    console.warn(
        '[kai] KAI_SECRET is not set — generated an ephemeral one.\n' +
            '      Sessions and stored provider keys will be invalidated on restart.\n' +
            `      Set KAI_SECRET=${generated} to make them persist.`,
    )
    return generated
}

export const env = {
    nodeEnv: str('NODE_ENV', 'development'),
    isProduction: process.env.NODE_ENV === 'production',

    host: str('KAI_HOST', '0.0.0.0'),
    port: int('KAI_PORT', 3210),
    /** Public origin, used for absolute asset/gateway URLs and cookie scoping. */
    publicUrl: str('KAI_PUBLIC_URL', `http://localhost:${int('KAI_PORT', 3210)}`),

    dataDir,
    assetsDir: resolve(dataDir, 'assets'),
    dbPath: resolve(dataDir, str('KAI_DB_FILE', 'kai.db')),
    /** Directory holding the built client (`dist/`). Served at `/`. */
    clientDir: resolve(str('KAI_CLIENT_DIR', '../../dist')),

    secret: resolveSecret(),

    sessionTtlDays: int('KAI_SESSION_TTL_DAYS', 30),
    /** Bootstrap admin, created on first boot when the users table is empty. */
    adminEmail: process.env.KAI_ADMIN_EMAIL ?? '',
    adminPassword: process.env.KAI_ADMIN_PASSWORD ?? '',

    /** Optional sidecars. Auto-probed at boot; absent ones are simply skipped. */
    omnirouteUrl: str('KAI_OMNIROUTE_URL'),
    omnirouteApiKey: str('KAI_OMNIROUTE_API_KEY'),

    /** Routing is now handled by OmniRoute. */

    /** Abuse limits applied per user on the gateway. */
    userRpm: int('KAI_USER_RPM', 20),
    userRpd: int('KAI_USER_RPD', 500),

    maxUploadBytes: int('KAI_MAX_UPLOAD_BYTES', 32 * 1024 * 1024),
    /** Character containers may legitimately bundle hundreds of image assets. */
    maxCardUploadBytes: int('KAI_MAX_CARD_UPLOAD_BYTES', 512 * 1024 * 1024),
    trustProxy: bool('KAI_TRUST_PROXY', false),
} as const

export type Env = typeof env
