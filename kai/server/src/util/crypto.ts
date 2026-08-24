import {
    createCipheriv,
    createDecipheriv,
    createHash,
    randomBytes,
    scrypt as scryptCb,
    timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'
import { env } from '../env.js'

const scrypt = promisify(scryptCb) as (
    password: string | Buffer,
    salt: string | Buffer,
    keylen: number,
) => Promise<Buffer>

/* ----------------------------- passwords ----------------------------- */

const SCRYPT_KEYLEN = 64

/**
 * Format: `scrypt$<saltHex>$<hashHex>`.
 * scrypt is used over argon2 deliberately — it is in Node's stdlib, so the
 * server has no native build step beyond the SQLite driver.
 */
export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16)
    const hash = await scrypt(password.normalize('NFKC'), salt, SCRYPT_KEYLEN)
    return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const parts = stored.split('$')
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false
    const salt = Buffer.from(parts[1], 'hex')
    const expected = Buffer.from(parts[2], 'hex')
    if (expected.length !== SCRYPT_KEYLEN) return false
    const actual = await scrypt(password.normalize('NFKC'), salt, SCRYPT_KEYLEN)
    return timingSafeEqual(actual, expected)
}

/** Constant-time compare for opaque tokens. */
export function tokensEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a)
    const bb = Buffer.from(b)
    if (ab.length !== bb.length) return false
    return timingSafeEqual(ab, bb)
}

/* --------------------------- secret storage --------------------------- */

let cachedKey: Buffer | null = null
function key(): Buffer {
    if (!cachedKey) cachedKey = createHash('sha256').update(`kai:aes:${env.secret}`).digest()
    return cachedKey
}

/** AES-256-GCM. Output: `v1.<ivB64>.<tagB64>.<ctB64>`. */
export function encryptSecret(plain: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key(), iv)
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`
}

/** Returns null when the ciphertext was written under a different KAI_SECRET. */
export function decryptSecret(payload: string | null | undefined): string | null {
    if (!payload) return null
    const parts = payload.split('.')
    if (parts.length !== 4 || parts[0] !== 'v1') return null
    try {
        const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(parts[1], 'base64url'))
        decipher.setAuthTag(Buffer.from(parts[2], 'base64url'))
        return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString(
            'utf8',
        )
    } catch {
        return null
    }
}

export function sha256(buf: Buffer | string): string {
    return createHash('sha256').update(buf).digest('hex')
}
