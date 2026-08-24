/**
 * RisuAI module (`.risum`) handling.
 *
 * A module is the unit shared presets depend on: it carries the display regex
 * scripts, trigger scripts and lorebook entries that turn a model's raw markers
 * into the UI a card or preset was designed around. RisuAI keeps them in
 * `db.modules`, switched on through `db.enabledModules`.
 *
 * The decoded module is stored **whole** and handed to the engine unchanged, the
 * same contract `services/plugins.ts` keeps for plugin source: any rewrite here
 * would change what the engine actually runs.
 */

import { asc, eq } from 'drizzle-orm'
import { readRisuModule, type RisuModule } from '../cards/charx.js'
import { db, schema } from '../db/index.js'
import type { DbEngineModule } from '../db/schema.js'
import { HttpError } from '../util/http.js'
import { newId } from '../util/ids.js'

export interface ModuleSummary {
    id: string
    moduleId: string
    name: string
    description: string
    namespace: string
    regexCount: number
    triggerCount: number
    loreCount: number
    lowLevelAccess: boolean
    enabled: boolean
    sortOrder: number
}

export function moduleSummary(row: DbEngineModule): ModuleSummary {
    return {
        id: row.id,
        moduleId: row.moduleId,
        name: row.name,
        description: row.description,
        namespace: row.namespace,
        regexCount: row.regexCount,
        triggerCount: row.triggerCount,
        loreCount: row.loreCount,
        lowLevelAccess: row.lowLevelAccess,
        enabled: row.enabled,
        sortOrder: row.sortOrder,
    }
}

export function listModules(): ModuleSummary[] {
    return db
        .select()
        .from(schema.engineModules)
        .orderBy(asc(schema.engineModules.sortOrder), asc(schema.engineModules.name))
        .all()
        .map(moduleSummary)
}

/**
 * Decodes a `.risum` and stores it, replacing any earlier copy of the same
 * module id so re-uploading a newer version is an update rather than a
 * duplicate — matching how RisuAI treats module ids as stable identities.
 */
export function installModule(
    bytes: Uint8Array,
    opts: { enabled?: boolean; fileName?: string } = {},
): { row: DbEngineModule; replaced: boolean } {
    let module: RisuModule
    try {
        module = readRisuModule(Buffer.from(bytes))
    } catch (e) {
        throw HttpError.badRequest(`Not a readable RisuAI module: ${(e as Error).message}`)
    }

    const moduleId = String(module.id ?? '').trim()
    if (!moduleId) throw HttpError.badRequest('Module has no id')

    const name = String(module.name ?? opts.fileName ?? '').trim() || 'Imported module'
    const existing = db.select().from(schema.engineModules).where(eq(schema.engineModules.moduleId, moduleId)).get()

    const values = {
        moduleId,
        name,
        description: String(module.description ?? ''),
        namespace: String(module.namespace ?? ''),
        module: module as unknown as Record<string, unknown>,
        regexCount: Array.isArray(module.regex) ? module.regex.length : 0,
        triggerCount: Array.isArray(module.trigger) ? module.trigger.length : 0,
        loreCount: Array.isArray(module.lorebook) ? module.lorebook.length : 0,
        // The module declares this; the admin installing it is the one granting
        // it. Reported back on import so the decision is visible, not silent.
        lowLevelAccess: !!module.lowLevelAccess,
        updatedAt: Math.floor(Date.now() / 1000),
    }

    if (existing) {
        const row = db
            .update(schema.engineModules)
            .set({ ...values, enabled: opts.enabled ?? existing.enabled })
            .where(eq(schema.engineModules.id, existing.id))
            .returning()
            .get()
        return { row, replaced: true }
    }

    const row = db
        .insert(schema.engineModules)
        .values({ id: newId('mod_'), ...values, enabled: opts.enabled ?? true })
        .returning()
        .get()
    return { row, replaced: false }
}

/** Enabled modules, in the shape RisuAI's `db.modules` expects. */
export function enabledModules(): Record<string, unknown>[] {
    return db
        .select()
        .from(schema.engineModules)
        .where(eq(schema.engineModules.enabled, true))
        .orderBy(asc(schema.engineModules.sortOrder), asc(schema.engineModules.name))
        .all()
        .map((row) => row.module as Record<string, unknown>)
}
