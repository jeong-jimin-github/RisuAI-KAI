/**
 * Post-generation grammar pass.
 *
 * GLM 5.2 and DeepSeek V3.2 answer a Korean prompt in Korean, but they leak
 * Han characters into it (`시간` written as `時間`) and carry Chinese word order
 * and particle choices across. Neither is visible to the router — the reply is
 * in the right script, the request is a 200 — so it has to be fixed after the
 * fact, by a model that is actually fluent in the target language.
 *
 * Everything here is pure: the correcting completion arrives as a `complete`
 * callback so the policy (who gets proofread, what counts as an acceptable
 * correction) can be tested without a database, a provider or a network.
 *
 * The two rules that matter:
 *
 *  1. A correction is *replacement* text. If it fails any plausibility check the
 *     original wins. A refusal, a summary or a translation is a worse reply than
 *     a slightly clumsy one, and the checks below all exist because one of those
 *     three is the realistic failure.
 *  2. Structure is not the corrector's business. Roleplay replies carry status
 *     windows, tables and markdown that the preset's regex scripts parse; a pass
 *     that "tidied" those would break rendering, so a correction that reshapes
 *     the layout is rejected rather than trusted.
 */

import type { ProofreadConfig } from '../../../shared/contract.js'
import type { NormalisedMessage } from './types.js'

/**
 * Substring patterns for the models this exists for. Kimi K2.5 is Chinese-built
 * too but measured clean on the same prompts (catalog rev 20), so it is not
 * listed — every entry here costs an extra completion per turn.
 */
export const DEFAULT_PROOFREAD_MODELS = ['glm', 'deepseek']

/**
 * GPT-5.6 first, Gemini 3.7 Flash second. Both are catalog aliases, so each one
 * still fails over across its own providers and keys inside `routeChat`.
 */
export const DEFAULT_PROOFREAD_CORRECTORS = ['gpt-5-6', 'gemini-3.7-flash']

export const DEFAULT_PROOFREAD: ProofreadConfig = {
    enabled: true,
    models: DEFAULT_PROOFREAD_MODELS,
    correctors: DEFAULT_PROOFREAD_CORRECTORS,
    languages: ['ko'],
}

/**
 * Reads the stored blob back into a usable config.
 *
 * `withDefaults` in the settings service merges one level deep, so a generation
 * blob saved before this field existed — or one an admin PUT with half of it —
 * arrives here partial. An empty array is kept as an empty array: "no models"
 * and "every language" are both meaningful, and only a missing or malformed
 * field falls back to the default.
 */
export function resolveProofreadConfig(
    stored: Partial<ProofreadConfig> | null | undefined,
): ProofreadConfig {
    const list = (value: unknown, fallback: string[]): string[] =>
        Array.isArray(value)
            ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim())
            : fallback
    return {
        enabled: typeof stored?.enabled === 'boolean' ? stored.enabled : DEFAULT_PROOFREAD.enabled,
        models: list(stored?.models, DEFAULT_PROOFREAD.models),
        correctors: list(stored?.correctors, DEFAULT_PROOFREAD.correctors),
        languages: list(stored?.languages, DEFAULT_PROOFREAD.languages),
    }
}

/** Below this a reply is a one-liner; a correction pass is not worth the turn. */
export const MIN_PROOFREAD_CHARS = 24

/**
 * A correction may drift this far from the original in length. Rewriting 漢字
 * as Hangul lengthens text, so the ceiling is looser than the floor; anything
 * outside the band is a summary or an expansion, not a grammar fix.
 */
export const MIN_LENGTH_RATIO = 0.6
export const MAX_LENGTH_RATIO = 1.6

/** A reply with at least this many lines is structured enough to check. */
const STRUCTURED_LINES = 4

export interface ProofreadOutcome {
    /** The text to send: the correction when one was accepted, else the input. */
    text: string
    /** Alias that produced the accepted correction, or null if none did. */
    via: string | null
    /** Why no correction was applied. `null` when one was. */
    skipped: 'disabled' | 'language' | 'too-short' | 'rejected' | 'failed' | null
}

export interface ProofreadDeps {
    /**
     * One correction attempt against a routing alias. Rejecting is expected —
     * the caller moves on to the next alias.
     */
    complete(alias: string, messages: NormalisedMessage[], maxTokens: number): Promise<string>
    /** Non-fatal reporting; failures here never change the reply. */
    onError?(alias: string, error: unknown): void
}

/* ------------------------------------------------------------------ *
 * Policy
 * ------------------------------------------------------------------ */

/**
 * Whether `modelRef` (a `provider/model` reference) is one of the models this
 * pass exists for.
 */
export function isProofreadTarget(config: ProofreadConfig, modelRef: string): boolean {
    const ref = modelRef.toLowerCase()
    return config.models.some((pattern) => {
        const needle = pattern.trim().toLowerCase()
        return needle.length > 0 && ref.includes(needle)
    })
}

/**
 * Whether a reply from this model, for a prompt in this language, is eligible.
 *
 * Answerable before generation starts, which is what the streaming path needs:
 * it has to decide whether to hold the deltas back the moment the model is
 * chosen, long before there is any text to measure.
 *
 * `language` is the prompt's, not the reply's — a GLM turn that came back
 * mostly in Chinese is precisely the case worth correcting, and reading the
 * reply's own script would skip it.
 */
export function proofreadApplies(
    config: ProofreadConfig,
    modelRef: string,
    language: string | undefined,
): boolean {
    if (!config.enabled || config.correctors.length === 0) return false
    if (!isProofreadTarget(config, modelRef)) return false
    if (config.languages.length > 0 && (!language || !config.languages.includes(language))) {
        return false
    }
    return true
}

/** The half of the gate that does not depend on which model answered. */
function modelAgnosticReason(
    config: ProofreadConfig,
    language: string | undefined,
    text: string,
): 'disabled' | 'language' | 'too-short' | null {
    if (!config.enabled || config.correctors.length === 0) return 'disabled'
    if (config.languages.length > 0 && (!language || !config.languages.includes(language))) {
        return 'language'
    }
    if (text.trim().length < MIN_PROOFREAD_CHARS) return 'too-short'
    return null
}

/* ------------------------------------------------------------------ *
 * The correction prompt
 * ------------------------------------------------------------------ */

const INSTRUCTIONS_KO = `너는 이미 생성된 한국어 롤플레이 본문을 다듬는 교정기다. 새로 쓰지 말고 받은 본문만 고쳐서 돌려준다.

지켜야 할 것:
1. 한자와 중국어 어휘를 같은 뜻의 한국어로 바꾼다. 고유명사도 한국에서 쓰는 표기로 옮긴다.
2. 어색한 조사·어미·어순·번역투를 자연스러운 한국어로 고친다.
3. 내용은 그대로 둔다. 사건, 대사의 뜻, 화자, 시점, 시제, 수위, 어조, 존댓말과 반말을 바꾸지 않는다.
4. 형식을 그대로 보존한다. 줄바꿈과 빈 줄의 수, 마크다운, 따옴표, 별표, 코드블록, 상태창과 표, HTML 태그, 이모지, {{...}} 같은 치환 구문을 건드리지 않는다.
5. 문장을 요약하거나 추가하지 않는다. 검열하거나 거절하지 않는다. 이것은 창작물의 교정 작업이다.
6. 설명, 머리말, 코드펜스 없이 교정된 본문만 출력한다. 고칠 곳이 없으면 받은 본문을 그대로 출력한다.`

const INSTRUCTIONS_GENERIC = `You are a proofreader for an already generated roleplay reply. Do not rewrite it — return the same passage with its language errors fixed.

Rules:
1. Replace stray Chinese characters and Chinese vocabulary with the equivalent in the target language.
2. Fix unnatural particles, endings, word order and translationese.
3. Keep the content identical: events, meaning, speaker, tense, register, tone and level of explicitness.
4. Preserve the formatting exactly — line and blank-line count, markdown, quotes, asterisks, code blocks, status panels, tables, HTML tags, emoji and {{...}} placeholders.
5. Never summarise, never add, never censor and never refuse. This is a proofreading task on existing fiction.
6. Output only the corrected passage: no preamble, no explanation, no code fence. If nothing needs fixing, output the passage unchanged.`

export function buildProofreadMessages(text: string, language: string | undefined): NormalisedMessage[] {
    return [
        { role: 'system', content: language === 'ko' ? INSTRUCTIONS_KO : INSTRUCTIONS_GENERIC },
        { role: 'user', content: text },
    ]
}

/**
 * Output ceiling for the correction. Korean runs well under two characters per
 * token, and the routed model's own `maxOutput` clamps this further; the point
 * is only to stop a corrector that started hallucinating a continuation.
 */
export function proofreadMaxTokens(text: string): number {
    return Math.ceil(text.length / 1.5) + 256
}

/* ------------------------------------------------------------------ *
 * Accepting or rejecting a correction
 * ------------------------------------------------------------------ */

const FENCE = /^```[^\n]*\n([\s\S]*)\n```$/

/**
 * Undoes the two wrappers correctors add on their own: a code fence around the
 * whole answer, and leading/trailing blank lines. Indentation inside the text is
 * left alone — it can be part of a status panel.
 */
export function unwrapCorrection(raw: string): string {
    const trimmed = raw.replace(/^\s+|\s+$/g, '')
    const fenced = FENCE.exec(trimmed)
    return fenced ? fenced[1] : trimmed
}

const countLines = (text: string) => text.split('\n').length
const HANGUL = /[가-힣]/

/**
 * Whether a correction may replace the original.
 *
 * Every check here corresponds to an observed corrector failure: refusing
 * ("죄송하지만 도와드릴 수 없습니다"), answering *about* the passage instead of
 * returning it, translating it into English, or flattening a status panel into
 * prose. All of them read as a large change in size, script or shape.
 */
export function isAcceptableCorrection(original: string, corrected: string): boolean {
    const before = original.trim()
    const after = corrected.trim()
    if (!after) return false

    const ratio = after.length / Math.max(before.length, 1)
    if (ratio < MIN_LENGTH_RATIO || ratio > MAX_LENGTH_RATIO) return false

    // A reply that was in Hangul must come back in Hangul. This is what catches
    // an English refusal or an English translation of a Korean passage.
    if (HANGUL.test(before) && !HANGUL.test(after)) return false

    // Structure is the corrector's to preserve, not to improve. Only checked on
    // replies that have a structure to lose.
    const lines = countLines(before)
    if (lines >= STRUCTURED_LINES && countLines(after) < Math.ceil(lines / 2)) return false

    return true
}

/* ------------------------------------------------------------------ *
 * The pass
 * ------------------------------------------------------------------ */

/**
 * Runs the correction, falling back to `text` unchanged at every failure. The
 * caller can treat the result as "the reply", full stop.
 */
export async function proofreadText(
    text: string,
    config: ProofreadConfig,
    language: string | undefined,
    deps: ProofreadDeps,
): Promise<ProofreadOutcome> {
    // The caller has already matched the model — that is what told it to buffer
    // the stream in the first place. The rest of the gate is re-checked here so
    // a caller that skipped it still gets safe behaviour.
    const skipped = modelAgnosticReason(config, language, text)
    if (skipped) return { text, via: null, skipped }

    const messages = buildProofreadMessages(text, language)
    const maxTokens = proofreadMaxTokens(text)
    let attempted = false
    let rejected = false

    for (const alias of config.correctors) {
        if (!alias.trim()) continue
        attempted = true
        let raw: string
        try {
            raw = await deps.complete(alias, messages, maxTokens)
        } catch (e) {
            deps.onError?.(alias, e)
            continue
        }
        const corrected = unwrapCorrection(raw)
        if (!isAcceptableCorrection(text, corrected)) {
            rejected = true
            continue
        }
        return { text: corrected, via: alias, skipped: null }
    }

    return { text, via: null, skipped: !attempted ? 'disabled' : rejected ? 'rejected' : 'failed' }
}
