/**
 * RisuAI multi-language strings.
 *
 * Character cards written for RisuAI carry per-language text in a single
 * field, split by a heading that names the language code:
 *
 *     # `ko`
 *     한국어 소개
 *     # `en`
 *     English intro
 *
 * The engine's `parseMultilangString` turns that into a bucket per code plus an
 * `xx` bucket for whatever sat outside a heading. This module wraps it with the
 * two decisions the UI needs — which sections are real, and which one to show
 * first — so both can be tested without mounting a component.
 */

import { parseMultilangString } from '../../ts/util'

export interface LangSection {
    /** Language code from the heading, or `xx` when the string had no headings. */
    code: string
    text: string
}

/**
 * Sections worth offering, in the order the author wrote them.
 *
 * `xx` is only a real section when the string carries no headings at all;
 * otherwise it holds preamble that upstream's display drops.
 */
export function multiLangSections(value: string): LangSection[] {
    const parsed = parseMultilangString(value ?? '')
    const named = Object.keys(parsed)
        .filter((code) => code !== 'xx')
        .map((code) => ({ code, text: parsed[code].trim() }))
        .filter((section) => section.text !== '')
    if (named.length > 0) return named
    const rest = (parsed.xx ?? '').trim()
    return rest ? [{ code: 'xx', text: rest }] : []
}

/**
 * The section a reader on `locale` should land on: exact code, then same base
 * language (`ko` for `ko-KR`), then English, then whatever came first.
 */
export function preferredSection(sections: LangSection[], locale: string): LangSection | null {
    if (sections.length === 0) return null
    const wanted = (locale || 'en').toLowerCase()
    const base = wanted.split('-')[0]
    const baseOf = (code: string) => code.toLowerCase().split('-')[0]
    return (
        sections.find((s) => s.code.toLowerCase() === wanted) ??
        sections.find((s) => baseOf(s.code) === base) ??
        sections.find((s) => baseOf(s.code) === 'en') ??
        sections[0]
    )
}

/** Plain, single-language text suitable for the two-line gallery preview. */
export function descriptionPreview(value: string, locale: string): string {
    const text = preferredSection(multiLangSections(value), locale)?.text ?? ''
    return text
        .replace(/<!--[^]*?-->/g, ' ')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[#*_`>~|]+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}
