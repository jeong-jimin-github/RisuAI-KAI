/**
 * RisuAI plugin handling.
 *
 * The metadata header (`//@name`, `//@api`, `//@arg`, …) is documented in
 * `plugins.md`; this parser mirrors RisuAI's own line scan so a plugin that
 * installs in stock RisuAI installs here with the same identity and arguments.
 *
 * Plugin source is stored **verbatim**. The client loads it into the v3 iframe
 * sandbox unmodified, so any rewrite here would change what users execute.
 */

import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import type { DbPlugin } from '../db/schema.js'
import { HttpError } from '../util/http.js'
import { newId } from '../util/ids.js'

export type PluginArgType = 'string' | 'int'

export interface PluginArgSpec {
    name: string
    type: PluginArgType
    description: string
}

export interface PluginLink {
    url: string
    label: string
}

export interface PluginMeta {
    name: string
    displayName: string
    apiVersion: string
    version: string
    args: PluginArgSpec[]
    links: PluginLink[]
    updateUrl: string | null
}

const SUPPORTED_API_VERSIONS = ['2.0', '2.1', '3.0']

/**
 * Scans every line of the source, exactly like RisuAI does — plugins in the wild
 * put `//@version` a few lines below `//@name`, and some repeat `//@link` far
 * down the file.
 */
export function parsePluginMeta(source: string): PluginMeta {
    // Strip a UTF-8 BOM before matching, but never mutate what we store.
    const lines = source.replace(/^\uFEFF/, '').split('\n')

    let name = ''
    let displayName = ''
    let apiVersion = '2.0'
    let version = ''
    let updateUrl: string | null = null
    const args: PluginArgSpec[] = []
    const links: PluginLink[] = []

    for (const raw of lines) {
        const line = raw.trimEnd()

        if (line.startsWith('//@name')) {
            name = line.slice('//@name'.length).trim()
            continue
        }

        if (line.startsWith('//@api')) {
            for (const ver of line.slice('//@api'.length).trim().split(/\s+/)) {
                if (SUPPORTED_API_VERSIONS.includes(ver)) {
                    apiVersion = ver
                    break
                }
            }
            continue
        }

        if (line.startsWith('//@display-name')) {
            displayName = line.slice('//@display-name'.length).trim()
            continue
        }

        if (line.startsWith('//@version')) {
            version = line.slice('//@version'.length).trim()
            continue
        }

        if (line.startsWith('//@update-url')) {
            const url = line.slice('//@update-url'.length).trim().split(/\s+/)[0] ?? ''
            if (url && isHttpsUrl(url)) updateUrl = url
            continue
        }

        if (line.startsWith('//@link')) {
            const parts = line.slice('//@link'.length).trim().split(/\s+/)
            const url = parts[0] ?? ''
            if (!url || !isHttpsUrl(url)) continue
            links.push({ url, label: parts.slice(1).join(' ').trim() || url })
            continue
        }

        if (line.startsWith('//@risu-arg') || line.startsWith('//@arg')) {
            const directive = line.startsWith('//@risu-arg') ? '//@risu-arg' : '//@arg'
            const parts = line.slice(directive.length).trim().split(/\s+/)
            const argName = parts[0]
            const argType = parts[1]
            if (!argName || (argType !== 'int' && argType !== 'string')) continue
            args.push({
                name: argName,
                type: argType,
                // RisuAI strips unofficial `{{key::value}}` metadata out of the
                // description; the leftover text is what the settings UI shows.
                description: parts
                    .slice(2)
                    .join(' ')
                    .replace(/{{(.+?)(::?(.+?))?}}/g, '')
                    .trim(),
            })
        }
    }

    if (!name) {
        throw HttpError.badRequest('Plugin source has no //@name declaration')
    }

    return {
        name,
        displayName: displayName || name,
        apiVersion,
        version,
        args,
        links,
        updateUrl,
    }
}

function isHttpsUrl(candidate: string): boolean {
    try {
        return new URL(candidate).protocol === 'https:'
    } catch {
        return false
    }
}

export function defaultArgValues(args: PluginArgSpec[]): Record<string, string | number> {
    const out: Record<string, string | number> = {}
    for (const a of args) out[a.name] = a.type === 'int' ? 0 : ''
    return out
}

/** Keeps admin-entered values whose argument still exists, fills in new ones. */
export function reconcileArgValues(
    args: PluginArgSpec[],
    previous: Record<string, unknown>,
): Record<string, string | number> {
    const out = defaultArgValues(args)
    for (const a of args) {
        const prev = previous[a.name]
        if (a.type === 'int' && typeof prev === 'number') out[a.name] = prev
        else if (a.type === 'int' && typeof prev === 'string' && prev.trim() !== '') {
            const n = Number(prev)
            if (!Number.isNaN(n)) out[a.name] = n
        } else if (a.type === 'string' && (typeof prev === 'string' || typeof prev === 'number')) {
            out[a.name] = String(prev)
        }
    }
    return out
}

export interface InstallOptions {
    enabled?: boolean
    forced?: boolean
    sortOrder?: number
    argValues?: Record<string, string | number>
    /** Overwrite an existing plugin with the same `//@name` instead of conflicting. */
    replace?: boolean
}

export async function installPlugin(source: string, opts: InstallOptions = {}): Promise<DbPlugin> {
    const meta = parsePluginMeta(source)
    const existing = db.select().from(schema.plugins).where(eq(schema.plugins.name, meta.name)).get()

    if (existing && !opts.replace) {
        throw HttpError.conflict(`A plugin named "${meta.name}" is already installed`)
    }

    const argValues = {
        ...reconcileArgValues(meta.args, (existing?.argValues ?? {}) as Record<string, unknown>),
        ...(opts.argValues ?? {}),
    }

    if (existing) {
        const updated = db
            .update(schema.plugins)
            .set({
                displayName: meta.displayName,
                apiVersion: meta.apiVersion,
                version: meta.version,
                source,
                argSchema: meta.args,
                argValues,
                updateUrl: meta.updateUrl,
                ...(opts.enabled === undefined ? {} : { enabled: opts.enabled }),
                ...(opts.forced === undefined ? {} : { forced: opts.forced }),
                ...(opts.sortOrder === undefined ? {} : { sortOrder: opts.sortOrder }),
            })
            .where(eq(schema.plugins.id, existing.id))
            .returning()
            .get()
        return updated
    }

    const maxOrder =
        db.select().from(schema.plugins).all().reduce((m, p) => Math.max(m, p.sortOrder), -1) + 1

    return db
        .insert(schema.plugins)
        .values({
            id: newId('plg_'),
            name: meta.name,
            displayName: meta.displayName,
            apiVersion: meta.apiVersion,
            version: meta.version,
            source,
            argSchema: meta.args,
            argValues,
            enabled: opts.enabled ?? false,
            forced: opts.forced ?? true,
            sortOrder: opts.sortOrder ?? maxOrder,
            updateUrl: meta.updateUrl,
            createdAt: Math.floor(Date.now() / 1000),
        })
        .returning()
        .get()
}

export interface PluginUpdateResult {
    updated: boolean
    previousVersion: string
    version: string
    reason?: string
}

/** `1.10.0` > `1.9.3`; non-numeric segments fall back to string ordering. */
export function compareVersions(a: string, b: string): number {
    const pa = a.split(/[.\-+]/)
    const pb = b.split(/[.\-+]/)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const sa = pa[i] ?? '0'
        const sb = pb[i] ?? '0'
        const na = Number(sa)
        const nb = Number(sb)
        if (!Number.isNaN(na) && !Number.isNaN(nb)) {
            if (na !== nb) return na < nb ? -1 : 1
        } else if (sa !== sb) {
            return sa < sb ? -1 : 1
        }
    }
    return 0
}

export async function updatePluginFromUrl(id: string, force = false): Promise<PluginUpdateResult> {
    const row = db.select().from(schema.plugins).where(eq(schema.plugins.id, id)).get()
    if (!row) throw HttpError.notFound('Plugin not found')

    const url = row.updateUrl ?? parsePluginMeta(row.source).updateUrl
    if (!url) throw HttpError.badRequest('This plugin declares no //@update-url')
    if (!isHttpsUrl(url)) throw HttpError.badRequest('Plugin update URL must be https')

    let source: string
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'follow' })
        if (!res.ok) throw HttpError.upstream(`Update server answered ${res.status}`)
        source = await res.text()
    } catch (e) {
        if (e instanceof HttpError) throw e
        throw HttpError.upstream(`Could not download the plugin: ${(e as Error).message}`)
    }

    const meta = parsePluginMeta(source)
    if (meta.name !== row.name) {
        throw HttpError.conflict(
            `Downloaded plugin identifies as "${meta.name}", not "${row.name}" — refusing to swap it`,
        )
    }

    const newer = !row.version || !meta.version || compareVersions(meta.version, row.version) > 0
    if (!newer && !force) {
        return { updated: false, previousVersion: row.version, version: meta.version, reason: 'up-to-date' }
    }

    db.update(schema.plugins)
        .set({
            displayName: meta.displayName,
            apiVersion: meta.apiVersion,
            version: meta.version,
            source,
            argSchema: meta.args,
            argValues: reconcileArgValues(meta.args, (row.argValues ?? {}) as Record<string, unknown>),
            updateUrl: meta.updateUrl ?? row.updateUrl,
        })
        .where(eq(schema.plugins.id, id))
        .run()

    return { updated: true, previousVersion: row.version, version: meta.version }
}
