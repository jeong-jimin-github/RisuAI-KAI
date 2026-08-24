/**
 * Preset/module toggles — RisuAI's "Toggles" sidebar.
 *
 * A preset declares user-facing options in `customPromptTemplateToggle`, and a
 * module in `customModuleToggle`, one per line:
 *
 *     key=label=type=option1,option2
 *
 * `type` is `select`, `text`, `textarea`, `caption`, `divider`, `group` /
 * `groupEnd`, or omitted for a checkbox. This is where a preset puts things like
 * its output language, its response format and its prose style — the choices a
 * desktop RisuAI user makes from the chat sidebar.
 *
 * The chosen values live in `globalChatVariables` under a `toggle_` prefix,
 * which is how the preset's own CBS reads them back
 * (`{{getglobalvar::toggle_response_language}}`). Selects store the option
 * *index* as a string and checkboxes `'1'`/`'0'`, matching what the RisuAI
 * sidebar writes — a label or a boolean here would silently mismatch every
 * comparison the preset makes.
 *
 * KAI users have no sidebar, so the admin picks for the instance.
 */

import { asc, desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

export type ToggleType = 'select' | 'text' | 'textarea' | 'caption' | 'divider' | 'group' | 'groupEnd' | 'check'

export interface ToggleItem {
    key: string
    label: string
    type: ToggleType
    options: string[]
    /** Group nesting, so the admin form can render the preset's own sections. */
    group: string | null
}

/** Port of the client's `parseToggleSyntax`, kept line-for-line compatible. */
export function parseToggleSyntax(template: string): ToggleItem[] {
    if (!template) return []
    const items: ToggleItem[] = []
    let group: string | null = null

    for (const line of template.split('\n')) {
        const [key, label, type, option] = line.split('=')

        if (type === 'group') {
            group = label ?? ''
            items.push({ key: key ?? '', label: label ?? '', type: 'group', options: [], group: null })
            continue
        }
        if (type === 'groupEnd') {
            group = null
            continue
        }
        if (type === 'divider') {
            items.push({ key: key ?? '', label: label ?? '', type: 'divider', options: [], group })
            continue
        }
        if (type === 'caption' && label) {
            items.push({ key: key ?? '', label, type: 'caption', options: [], group })
            continue
        }
        if (key && label) {
            items.push({
                key,
                label,
                type: type === 'select' || type === 'text' || type === 'textarea' ? type : 'check',
                options: option ? option.split(',') : [],
                group,
            })
        }
    }
    return items
}

/**
 * Everything the active preset and the enabled modules declare, concatenated in
 * the same order the client's sidebar uses so duplicate keys resolve the same way.
 */
export function toggleSpec(): ToggleItem[] {
    const preset =
        db.select().from(schema.promptPresets).where(eq(schema.promptPresets.isDefault, true)).get() ??
        db.select().from(schema.promptPresets).orderBy(desc(schema.promptPresets.createdAt)).limit(1).get()

    const presetToggles = String((preset?.preset as any)?.customPromptTemplateToggle ?? '')

    const moduleToggles = db
        .select()
        .from(schema.engineModules)
        .where(eq(schema.engineModules.enabled, true))
        .orderBy(asc(schema.engineModules.sortOrder), asc(schema.engineModules.name))
        .all()
        .map((row) => String((row.module as any)?.customModuleToggle ?? ''))
        .filter(Boolean)

    return parseToggleSyntax([presetToggles, ...moduleToggles].join('\n'))
}

/** Only the entries that actually hold a value; the rest are layout. */
export function isValueToggle(item: ToggleItem): boolean {
    return item.type === 'select' || item.type === 'text' || item.type === 'textarea' || item.type === 'check'
}

/**
 * Admin choices as `globalChatVariables` entries.
 *
 * Unset checkboxes are written as `'0'` rather than left out: a preset that
 * tests `{{#if {{getglobalvar::toggle_x}}}}` sees `'null'` for a missing
 * variable, which is a non-empty string and reads as true.
 */
export function toggleVariables(values: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const item of toggleSpec()) {
        if (!isValueToggle(item)) continue
        const chosen = values[item.key]
        if (chosen !== undefined && chosen !== '') out[`toggle_${item.key}`] = chosen
        else if (item.type === 'check') out[`toggle_${item.key}`] = '0'
    }
    return out
}
