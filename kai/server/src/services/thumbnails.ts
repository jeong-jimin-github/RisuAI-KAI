/**
 * On-demand image thumbnails. Uses ffmpeg via child_process (available on
 * Termux via `pkg install ffmpeg`), caches to disk, gracefully falls back to
 * the original when ffmpeg is missing or a resize fails.
 *
 * A single in-flight promise per (id,width) coalesces stampedes so parallel
 * requests for the same thumbnail wait on one ffmpeg run instead of spawning N.
 */
import { spawn } from 'node:child_process'
import { access, mkdir, stat } from 'node:fs/promises'
import { constants as FS_CONSTANTS } from 'node:fs'
import { resolve } from 'node:path'
import { env } from '../env.js'

const THUMB_DIR = resolve(env.assetsDir, 'thumbs')
const THUMBABLE = new Set(['image/png', 'image/jpeg', 'image/webp'])
const MIN_WIDTH = 32
const MAX_WIDTH = 1024

let ffmpegAvailable: boolean | null = null
async function ensureFfmpeg(): Promise<boolean> {
    if (ffmpegAvailable !== null) return ffmpegAvailable
    ffmpegAvailable = await new Promise<boolean>((res) => {
        const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore' })
        p.on('error', () => res(false))
        p.on('exit', (code) => res(code === 0))
    })
    if (!ffmpegAvailable) console.warn('[thumbnails] ffmpeg not found on PATH — falling back to originals')
    return ffmpegAvailable
}

export function canThumbnail(mime: string, width: number): boolean {
    return THUMBABLE.has(mime) && width >= MIN_WIDTH && width <= MAX_WIDTH
}

const inFlight = new Map<string, Promise<string | null>>()

async function fileExists(p: string): Promise<boolean> {
    try { await access(p, FS_CONSTANTS.F_OK); return true } catch { return false }
}

async function runFfmpeg(src: string, dst: string, width: number): Promise<boolean> {
    return new Promise((res) => {
        // -q:v 4 → good visual quality WebP, roughly 70-80% quality equivalent
        const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf', `scale=${width}:-1`, '-q:v', '4', dst], { stdio: ['ignore', 'ignore', 'pipe'] })
        let stderr = ''
        p.stderr.on('data', (b) => { stderr += b.toString().slice(0, 512) })
        p.on('error', () => res(false))
        p.on('exit', (code) => {
            if (code !== 0) console.warn(`[thumbnails] ffmpeg exit=${code} src=${src.slice(-40)}: ${stderr.slice(0, 200)}`)
            res(code === 0)
        })
    })
}

/**
 * Returns the on-disk path of the cached thumbnail (WebP), generating it if
 * needed. Returns null when ffmpeg is unavailable or the resize fails, so the
 * caller can fall back to serving the original bytes.
 */
export async function getThumbnailPath(id: string, srcPath: string, width: number): Promise<string | null> {
    const key = `${id}_w${width}`
    const dst = resolve(THUMB_DIR, `${key}.webp`)

    // Fast path: cached
    if (await fileExists(dst)) return dst

    // Coalesce stampedes
    const existing = inFlight.get(key)
    if (existing) return existing

    const promise = (async () => {
        if (!(await ensureFfmpeg())) return null
        try { await mkdir(THUMB_DIR, { recursive: true }) } catch { /* ignore */ }
        const ok = await runFfmpeg(srcPath, dst, width)
        if (!ok) return null
        // Sanity: file exists and non-empty
        try { const s = await stat(dst); return s.size > 0 ? dst : null } catch { return null }
    })()
    inFlight.set(key, promise)
    try { return await promise }
    finally { inFlight.delete(key) }
}
