/**
 * Reply suggestions generator and parser for KAI chat interface.
 * Handles parsing suggestions across multiple LLM response formats
 * (JSON arrays, markdown lists, thinking tags, objects, raw lines).
 */

/**
 * Removes thinking tags, reasoning blocks, and extraneous markdown from raw LLM output.
 */
export function cleanRawResponse(raw: string): string {
    if (!raw || typeof raw !== 'string') return ''

    let text = raw.trim()

    // 1. Remove complete thinking / reasoning blocks
    text = text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    text = text.replace(/<thought\b[^>]*>[\s\S]*?<\/thought>/gi, '')
    text = text.replace(/<reasoning\b[^>]*>[\s\S]*?<\/reasoning>/gi, '')
    text = text.replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, '')

    // 2. Handle unclosed thinking tags (if generation was truncated inside thinking phase)
    if (/<(?:think|thought|reasoning)\b/i.test(text) && !/<\/(?:think|thought|reasoning)>/i.test(text)) {
        text = text.replace(/<(?:think|thought|reasoning)\b[\s\S]*/i, '').trim()
    }

    return text.trim()
}

/**
 * Cleans and normalizes an individual reply suggestion string.
 */
export function sanitizeSuggestion(item: string): string {
    if (!item || typeof item !== 'string') return ''

    let s = item.trim()

    // Remove markdown code block markers
    s = s.replace(/^```[a-z0-9_-]*\s*/i, '').replace(/\s*```$/i, '').trim()

    // Remove leading numbering or bullet prefixes (e.g. "1. ", "1) ", "(1) ", "[1] ", "- ", "* ", "• ")
    s = s.replace(/^(?:(?:\d+|[a-zA-Z])[\.\)\:\-]|[\(\[](?:\d+|[a-zA-Z])[\)\]]|[-*•])\s*/, '').trim()

    // Remove leading category/label prefixes like "**긍정적 반응**:", "**답변 1**:", "선택지 1:", "후보 1:", "Option 1:"
    s = s.replace(/^(?:\*{1,2}[^*:]+\*{1,2}\s*[:\-–]\s*|\[[^\]]+\]\s*[:\-–]?\s*|(?:선택지|후보|답변|대사|옵션|option|choice|suggestion)\s*\d*\s*[:\-–]\s*)/i, '').trim()

    // Remove leading role indicators (e.g. "User: ", "유저: ", "나: ", "{{user}}:")
    s = s.replace(/^(?:\{\{user\}\}|user|유저|나|플레이어|player)\s*:\s*/i, '').trim()

    // Remove surrounding quotes ("...", '...', “...”, 「...」, 『...』)
    s = s.replace(/^["'“”„«「『]\s*/, '').replace(/\s*["'“”»」』]$/, '').trim()

    // Unescape common JSON escapes
    s = s.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\n/g, ' ').replace(/\\\\/g, '\\')

    return s.trim()
}

const META_LINE_REGEX = /^(?:다음은|추천\s*답변|선택지|후보|아래는|답변\s*후보|here\s*are|suggested|suggestions|options|choices|responses|```|<|어떠신가요|도움이|마음에|위\s*(?:선택지|답변)|골라보세요|which\s*one)/i

const KNOWN_JSON_KEYS = new Set([
    'suggestions', 'replies', 'options', 'choices', 'candidates', 'data',
    'items', 'results', 'response', 'responses', 'text', 'reply', 'content',
    'message', 'role', 'model', 'type', 'option', 'choice'
])

function extractStringFromUnknown(val: unknown): string | null {
    if (typeof val === 'string') {
        const s = sanitizeSuggestion(val)
        return s && !KNOWN_JSON_KEYS.has(s.toLowerCase()) ? s : null
    }
    if (typeof val === 'object' && val !== null) {
        const obj = val as Record<string, unknown>
        const preferredKey = ['text', 'reply', 'content', 'suggestion', 'message', 'choice', 'option', 'value']
            .find((k) => typeof obj[k] === 'string' && obj[k])
        if (preferredKey) {
            const s = sanitizeSuggestion(obj[preferredKey] as string)
            if (s) return s
        }
        for (const v of Object.values(obj)) {
            if (typeof v === 'string') {
                const s = sanitizeSuggestion(v)
                if (s && !KNOWN_JSON_KEYS.has(s.toLowerCase())) return s
            }
        }
    }
    return null
}

function tryExtractJsonSuggestions(text: string): string[] {
    // 1. Try finding bracket array [...]
    const startArr = text.indexOf('[')
    const endArr = text.lastIndexOf(']')
    if (startArr !== -1 && endArr > startArr) {
        const jsonSlice = text.slice(startArr, endArr + 1)
        // Clean trailing commas and parse
        const sanitizedJson = jsonSlice.replace(/,\s*\]/g, ']').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')
        try {
            const parsed = JSON.parse(sanitizedJson)
            if (Array.isArray(parsed)) {
                const items = parsed
                    .map(extractStringFromUnknown)
                    .filter((item): item is string => Boolean(item && item.length >= 2))
                if (items.length > 0) return items
            }
        } catch {
            // If JSON.parse fails, try regex extraction of strings within the array brackets
            const matches: string[] = []
            const strRegex = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g
            let match: RegExpExecArray | null
            while ((match = strRegex.exec(jsonSlice)) !== null) {
                const rawStr = match[1] ?? match[2]
                if (rawStr) {
                    const s = sanitizeSuggestion(rawStr)
                    if (s && s.length >= 2 && !KNOWN_JSON_KEYS.has(s.toLowerCase())) {
                        matches.push(s)
                    }
                }
            }
            if (matches.length > 0) return matches
        }
    }

    // 2. Try finding object {...}
    const startObj = text.indexOf('{')
    const endObj = text.lastIndexOf('}')
    if (startObj !== -1 && endObj > startObj) {
        const jsonSlice = text.slice(startObj, endObj + 1)
        const sanitizedJson = jsonSlice.replace(/,\s*\}/g, '}').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')
        try {
            const parsed = JSON.parse(sanitizedJson)
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                const obj = parsed as Record<string, unknown>
                // Check if any property holds an array of suggestions
                for (const key of ['suggestions', 'replies', 'options', 'choices', 'candidates', 'data', 'items', 'results', 'response', 'responses']) {
                    if (Array.isArray(obj[key])) {
                        const items = (obj[key] as unknown[])
                            .map(extractStringFromUnknown)
                            .filter((item): item is string => Boolean(item && item.length >= 2))
                        if (items.length > 0) return items
                    }
                }
                // Check object string values (e.g. {"1": "...", "2": "...", "3": "..."})
                const items = Object.values(obj)
                    .map(extractStringFromUnknown)
                    .filter((item): item is string => Boolean(item && item.length >= 2))
                if (items.length > 0) return items
            }
        } catch {
            // Object parse failed
        }
    }

    return []
}

function tryExtractListSuggestions(text: string): string[] {
    const lines = text.split(/\r?\n/)
    const items: string[] = []

    for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line || META_LINE_REGEX.test(line)) continue

        // Check if line looks like a list item
        const listMatch = line.match(/^(?:(?:\d+|[a-zA-Z])[\.\)\:\-]|[\(\[](?:\d+|[a-zA-Z])[\)\]]|[-*•]|\b(?:선택지|후보|답변|대사|옵션|option|choice|suggestion)\s*\d*[:\-–\.]?)\s*(.+)$/i)
        if (listMatch && listMatch[1]) {
            const s = sanitizeSuggestion(listMatch[1])
            if (s && s.length >= 2 && !META_LINE_REGEX.test(s)) {
                items.push(s)
            }
        }
    }

    return items
}

function tryExtractQuoteSuggestions(text: string): string[] {
    const items: string[] = []
    const quoteRegex = /"([^"\n]{2,})"|“([^”\n]{2,})”|「([^」\n]{2,})」|『([^』\n]{2,})』/g
    let match: RegExpExecArray | null

    while ((match = quoteRegex.exec(text)) !== null) {
        const content = match[1] ?? match[2] ?? match[3] ?? match[4]
        if (content) {
            const s = sanitizeSuggestion(content)
            if (s && s.length >= 2 && !KNOWN_JSON_KEYS.has(s.toLowerCase()) && !META_LINE_REGEX.test(s)) {
                items.push(s)
            }
        }
    }

    return items
}

function tryExtractLineSuggestions(text: string): string[] {
    const lines = text.split(/\r?\n/)
    const items: string[] = []

    for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line || META_LINE_REGEX.test(line)) continue
        const s = sanitizeSuggestion(line)
        if (s && s.length >= 2 && !META_LINE_REGEX.test(s)) {
            items.push(s)
        }
    }

    return items
}

function deduplicate(items: string[]): string[] {
    const seen = new Set<string>()
    const result: string[] = []
    for (const item of items) {
        const normalized = item.trim().toLowerCase()
        if (!seen.has(normalized)) {
            seen.add(normalized)
            result.push(item.trim())
        }
    }
    return result
}

/**
 * Main parser function: takes raw LLM completion string and reliably returns 1-3 user reply suggestions.
 */
export function parseReplySuggestions(raw: string): string[] {
    const cleaned = cleanRawResponse(raw)
    if (!cleaned) return []

    // 1. JSON parse
    let suggestions = tryExtractJsonSuggestions(cleaned)

    // 2. List items
    if (suggestions.length === 0) {
        suggestions = tryExtractListSuggestions(cleaned)
    }

    // 3. Quoted strings
    if (suggestions.length === 0) {
        suggestions = tryExtractQuoteSuggestions(cleaned)
    }

    // 4. Clean lines fallback
    if (suggestions.length === 0) {
        suggestions = tryExtractLineSuggestions(cleaned)
    }

    return deduplicate(suggestions).slice(0, 3)
}
