import { describe, expect, it } from 'vitest'
import {
    DEFAULT_PROOFREAD,
    buildProofreadMessages,
    isAcceptableCorrection,
    isProofreadTarget,
    proofreadApplies,
    proofreadText,
    resolveProofreadConfig,
    unwrapCorrection,
} from '../llm/proofread.js'
import type { ProofreadDeps } from '../llm/proofread.js'
import type { NormalisedMessage } from '../llm/types.js'

const config = DEFAULT_PROOFREAD

/** A GLM turn with the two defects this pass exists for. */
const DIRTY =
    '그녀는 창가에 앉아 時間을 보내고 있었다.\n' +
    '"오랜만이야," 그녀가 말했다, 목소리가 조금 떨렸다.\n' +
    '창밖으로 落葉이 천천히 떨어지고 있었다.\n' +
    '너는 그 光景을 조용히 바라본다.'

const CLEAN =
    '그녀는 창가에 앉아 시간을 보내고 있었다.\n' +
    '"오랜만이야." 그녀가 말했다. 목소리가 조금 떨렸다.\n' +
    '창밖으로 낙엽이 천천히 떨어지고 있었다.\n' +
    '너는 그 광경을 조용히 바라본다.'

function deps(replies: Record<string, string | Error>, seen: string[] = []): ProofreadDeps {
    return {
        async complete(alias) {
            seen.push(alias)
            const reply = replies[alias]
            if (reply === undefined) throw new Error(`no stub for ${alias}`)
            if (reply instanceof Error) throw reply
            return reply
        },
    }
}

describe('which models get proofread', () => {
    it('matches every GLM and DeepSeek entry in the catalog', () => {
        for (const ref of ['nvidia/z-ai/glm-5.2', 'bedrock/zai.glm-5', 'bedrock/deepseek.v3.2']) {
            expect(isProofreadTarget(config, ref)).toBe(true)
        }
    })

    it('leaves every other model alone', () => {
        // Kimi is Chinese-built too, but it measured clean — adding it would
        // cost an extra completion per turn for nothing.
        for (const ref of ['aurora/gpt-5-6', 'gemini-1/gemini-3.7-flash', 'bedrock/moonshotai.kimi-k2.5']) {
            expect(isProofreadTarget(config, ref)).toBe(false)
        }
    })

    it('only applies to the configured prompt languages', () => {
        const ref = 'nvidia/z-ai/glm-5.2'
        expect(proofreadApplies(config, ref, 'ko')).toBe(true)
        expect(proofreadApplies(config, ref, 'ja')).toBe(false)
        // An undetected (Latin-script) prompt is not a language we verified.
        expect(proofreadApplies(config, ref, undefined)).toBe(false)
        // An empty list means "whatever the prompt turned out to be".
        expect(proofreadApplies({ ...config, languages: [] }, ref, 'ja')).toBe(true)
    })

    it('is off when disabled or when no corrector is configured', () => {
        const ref = 'nvidia/z-ai/glm-5.2'
        expect(proofreadApplies({ ...config, enabled: false }, ref, 'ko')).toBe(false)
        expect(proofreadApplies({ ...config, correctors: [] }, ref, 'ko')).toBe(false)
    })
})

describe('resolveProofreadConfig', () => {
    it('fills in a generation blob saved before the field existed', () => {
        expect(resolveProofreadConfig(undefined)).toEqual(DEFAULT_PROOFREAD)
        expect(resolveProofreadConfig({ enabled: false })).toEqual({ ...DEFAULT_PROOFREAD, enabled: false })
    })

    it('keeps an explicitly empty list instead of restoring the default', () => {
        expect(resolveProofreadConfig({ languages: [] }).languages).toEqual([])
        expect(resolveProofreadConfig({ models: [] }).models).toEqual([])
    })

    it('drops blank entries an admin form leaves behind', () => {
        expect(resolveProofreadConfig({ correctors: ['gpt-5-6', '  ', ' gemini-3.7-flash '] }).correctors)
            .toEqual(['gpt-5-6', 'gemini-3.7-flash'])
    })
})

describe('accepting a correction', () => {
    it('accepts a fix that only touches the language', () => {
        expect(isAcceptableCorrection(DIRTY, CLEAN)).toBe(true)
    })

    it('rejects a refusal', () => {
        // The realistic failure: a corrector fronting a consumer chat backend
        // declines the passage instead of proofreading it.
        expect(isAcceptableCorrection(DIRTY, '죄송하지만 이 요청은 도와드릴 수 없습니다.')).toBe(false)
        expect(isAcceptableCorrection(DIRTY, "I'm sorry, but I can't help with that request.")).toBe(false)
    })

    it('rejects a translation of a Korean passage', () => {
        expect(isAcceptableCorrection(
            DIRTY,
            'She sat by the window, letting the time pass by.\n' +
                '"It has been a while," she said, her voice trembling slightly.\n' +
                'Outside the window the fallen leaves drifted slowly down.\n' +
                'You watch the scene quietly, saying nothing at all here.',
        )).toBe(false)
    })

    it('rejects a summary and an expansion', () => {
        expect(isAcceptableCorrection(DIRTY, '그녀가 창가에서 인사를 건넨다.')).toBe(false)
        expect(isAcceptableCorrection(DIRTY, `${CLEAN}\n${CLEAN}`)).toBe(false)
    })

    it('rejects a correction that flattened the layout', () => {
        // Status panels are parsed by the preset's regex scripts, so a pass that
        // "tidied" four lines into one has broken the rendering.
        expect(isAcceptableCorrection(DIRTY, CLEAN.replace(/\n/g, ' '))).toBe(false)
    })

    it('rejects an empty answer', () => {
        expect(isAcceptableCorrection(DIRTY, '   \n  ')).toBe(false)
    })
})

describe('unwrapCorrection', () => {
    it('removes a code fence the corrector wrapped the whole answer in', () => {
        expect(unwrapCorrection('```\n' + CLEAN + '\n```')).toBe(CLEAN)
        expect(unwrapCorrection('```markdown\n' + CLEAN + '\n```')).toBe(CLEAN)
    })

    it('leaves a fence that is part of the passage alone', () => {
        const withCode = '상태창:\n```\nHP 12/20\n```\n그녀가 웃는다.'
        expect(unwrapCorrection(withCode)).toBe(withCode)
    })
})

describe('the pass', () => {
    it('replaces the reply with an accepted correction', async () => {
        const seen: string[] = []
        const out = await proofreadText(DIRTY, config, 'ko', deps({ 'gpt-5-6': CLEAN }, seen))
        expect(out).toEqual({ text: CLEAN, via: 'gpt-5-6', skipped: null })
        expect(seen).toEqual(['gpt-5-6'])
    })

    it('falls through to the next corrector when the first one errors', async () => {
        const seen: string[] = []
        const out = await proofreadText(
            DIRTY, config, 'ko',
            deps({ 'gpt-5-6': new Error('upstream 429'), 'gemini-3.7-flash': CLEAN }, seen),
        )
        expect(out.text).toBe(CLEAN)
        expect(out.via).toBe('gemini-3.7-flash')
        expect(seen).toEqual(['gpt-5-6', 'gemini-3.7-flash'])
    })

    it('falls through when the first corrector refuses', async () => {
        const out = await proofreadText(
            DIRTY, config, 'ko',
            deps({ 'gpt-5-6': '죄송합니다. 도와드릴 수 없습니다.', 'gemini-3.7-flash': CLEAN }),
        )
        expect(out.text).toBe(CLEAN)
        expect(out.via).toBe('gemini-3.7-flash')
    })

    it('keeps the original when every corrector fails', async () => {
        const out = await proofreadText(
            DIRTY, config, 'ko',
            deps({ 'gpt-5-6': new Error('down'), 'gemini-3.7-flash': new Error('down') }),
        )
        expect(out).toEqual({ text: DIRTY, via: null, skipped: 'failed' })
    })

    it('keeps the original when every correction is implausible', async () => {
        const out = await proofreadText(
            DIRTY, config, 'ko',
            deps({ 'gpt-5-6': '싫어요.', 'gemini-3.7-flash': '' }),
        )
        expect(out).toEqual({ text: DIRTY, via: null, skipped: 'rejected' })
    })

    it('does not spend a completion on a one-liner', async () => {
        const seen: string[] = []
        const out = await proofreadText('응.', config, 'ko', deps({}, seen))
        expect(out.skipped).toBe('too-short')
        expect(seen).toEqual([])
    })

    it('re-checks the cheap guards even when the caller skipped the gate', async () => {
        const seen: string[] = []
        const out = await proofreadText(DIRTY, { ...config, enabled: false }, 'ko', deps({}, seen))
        expect(out).toEqual({ text: DIRTY, via: null, skipped: 'disabled' })
        expect(seen).toEqual([])
    })
})

describe('the correction prompt', () => {
    it('sends the passage verbatim, with the rules in a separate turn', () => {
        const messages: NormalisedMessage[] = buildProofreadMessages(DIRTY, 'ko')
        expect(messages).toHaveLength(2)
        expect(messages[0].role).toBe('system')
        expect(messages[1]).toEqual({ role: 'user', content: DIRTY })
    })

    it('instructs in the target language when that language is Korean', () => {
        expect(String(buildProofreadMessages(DIRTY, 'ko')[0].content)).toContain('한자')
        expect(String(buildProofreadMessages('...', 'ja')[0].content)).toContain('proofreader')
    })
})
