import { describe, expect, it } from 'vitest'
import { cleanRawResponse, parseReplySuggestions, sanitizeSuggestion } from './replySuggestions'

describe('replySuggestions', () => {
    describe('cleanRawResponse', () => {
        it('strips <think> blocks', () => {
            const raw = '<think>\nThinking about suggestions...\n1. Option A\n</think>\n["답변 1", "답변 2", "답변 3"]'
            expect(cleanRawResponse(raw)).toBe('["답변 1", "답변 2", "답변 3"]')
        })

        it('strips unclosed <think> blocks if cut off', () => {
            const raw = '<think>\nThinking about suggestions...'
            expect(cleanRawResponse(raw)).toBe('')
        })

        it('strips <thought> and <reasoning> blocks', () => {
            const raw = '<thought>cot here</thought>\n<reasoning>cot 2</reasoning>["후보 1", "후보 2", "후보 3"]'
            expect(cleanRawResponse(raw)).toBe('["후보 1", "후보 2", "후보 3"]')
        })
    })

    describe('sanitizeSuggestion', () => {
        it('strips numbering prefixes', () => {
            expect(sanitizeSuggestion('1. 안녕하세요!')).toBe('안녕하세요!')
            expect(sanitizeSuggestion('2) 반갑습니다.')).toBe('반갑습니다.')
            expect(sanitizeSuggestion('(3) 오늘 날씨가 좋네요.')).toBe('오늘 날씨가 좋네요.')
            expect(sanitizeSuggestion('[1] 대화 지속')).toBe('대화 지속')
            expect(sanitizeSuggestion('- 네, 알겠습니다.')).toBe('네, 알겠습니다.')
            expect(sanitizeSuggestion('* 그래요.')).toBe('그래요.')
        })

        it('strips category/label prefixes and role prefixes', () => {
            expect(sanitizeSuggestion('**긍정적 반응**: "네, 좋아요!"')).toBe('네, 좋아요!')
            expect(sanitizeSuggestion('선택지 1: 저도 그렇게 생각해요.')).toBe('저도 그렇게 생각해요.')
            expect(sanitizeSuggestion('후보 2: "잠시만 기다려 주세요."')).toBe('잠시만 기다려 주세요.')
            expect(sanitizeSuggestion('User: 안녕! 오랜만이야.')).toBe('안녕! 오랜만이야.')
            expect(sanitizeSuggestion('유저: (웃으며) 그래, 같이 가자.')).toBe('(웃으며) 그래, 같이 가자.')
        })

        it('strips surrounding quotes', () => {
            expect(sanitizeSuggestion('"안녕하세요"')).toBe('안녕하세요')
            expect(sanitizeSuggestion('“반갑습니다”')).toBe('반갑습니다')
            expect(sanitizeSuggestion('「좋은 아침이에요」')).toBe('좋은 아침이에요')
        })
    })

    describe('parseReplySuggestions', () => {
        it('parses standard JSON array', () => {
            const raw = '["안녕하세요!", "무슨 일인가요?", "잠시 이야기할 수 있을까요?"]'
            expect(parseReplySuggestions(raw)).toEqual([
                '안녕하세요!',
                '무슨 일인가요?',
                '잠시 이야기할 수 있을까요?',
            ])
        })

        it('parses JSON array wrapped in markdown code block with text before/after', () => {
            const raw = `다음은 사용자가 선택할 수 있는 3가지 답변입니다:
\`\`\`json
[
  "안녕하세요! 반갑습니다.",
  "오늘 무슨 일 있으셨나요?",
  "혹시 저와 함께 가시겠어요?"
]
\`\`\`
마음에 드는 답변을 선택해 보세요.`
            expect(parseReplySuggestions(raw)).toEqual([
                '안녕하세요! 반갑습니다.',
                '오늘 무슨 일 있으셨나요?',
                '혹시 저와 함께 가시겠어요?',
            ])
        })

        it('parses JSON array with trailing comma', () => {
            const raw = `[
  "답변 후보 1",
  "답변 후보 2",
  "답변 후보 3",
]`
            expect(parseReplySuggestions(raw)).toEqual([
                '답변 후보 1',
                '답변 후보 2',
                '답변 후보 3',
            ])
        })

        it('parses JSON with thinking tags and brackets inside thinking', () => {
            const raw = `<think>
사용자가 [선택지 3개]를 요청함.
1. [친근한 인사]: 안녕!
2. [의문]: 무슨 일이야?
3. [농담]: 심심해.
</think>
[
  "안녕! 오랜만이야.",
  "무슨 일 있어? 안색이 안 좋아 보여.",
  "(웃으며) 오늘따라 기분이 좋아 보이네!"
]`
            expect(parseReplySuggestions(raw)).toEqual([
                '안녕! 오랜만이야.',
                '무슨 일 있어? 안색이 안 좋아 보여.',
                '(웃으며) 오늘따라 기분이 좋아 보이네!',
            ])
        })

        it('parses JSON object containing suggestions array', () => {
            const raw = `\`\`\`json
{
  "suggestions": [
    "네, 준비됐습니다.",
    "조금만 시간을 더 주세요.",
    "다른 방법은 없을까요?"
  ]
}
\`\`\``
            expect(parseReplySuggestions(raw)).toEqual([
                '네, 준비됐습니다.',
                '조금만 시간을 더 주세요.',
                '다른 방법은 없을까요?',
            ])
        })

        it('parses JSON array of objects with text/reply properties', () => {
            const raw = `[
  {"text": "안녕하세요!"},
  {"text": "오늘 하루는 어떠셨나요?"},
  {"text": "도움이 필요하시면 말씀해 주세요."}
]`
            expect(parseReplySuggestions(raw)).toEqual([
                '안녕하세요!',
                '오늘 하루는 어떠셨나요?',
                '도움이 필요하시면 말씀해 주세요.',
            ])
        })

        it('parses key-value JSON object', () => {
            const raw = `{
  "1": "첫 번째 선택지입니다.",
  "2": "두 번째 선택지입니다.",
  "3": "세 번째 선택지입니다."
}`
            expect(parseReplySuggestions(raw)).toEqual([
                '첫 번째 선택지입니다.',
                '두 번째 선택지입니다.',
                '세 번째 선택지입니다.',
            ])
        })

        it('parses numbered markdown list', () => {
            const raw = `1. (미소를 지으며) 안녕하세요, 만나서 반갑습니다!
2. 무슨 일 있으신가요? 표정이 안 좋아 보여요.
3. 저기... 혹시 시간 괜찮으시면 잠시 이야기 나눌 수 있을까요?`
            expect(parseReplySuggestions(raw)).toEqual([
                '(미소를 지으며) 안녕하세요, 만나서 반갑습니다!',
                '무슨 일 있으신가요? 표정이 안 좋아 보여요.',
                '저기... 혹시 시간 괜찮으시면 잠시 이야기 나눌 수 있을까요?',
            ])
        })

        it('parses numbered list with markdown bold labels and quotes', () => {
            const raw = `다음은 답변 후보입니다:
1. **긍정적인 반응**: "그래, 같이 가자! 재미있겠다."
2. **중립적인 반응**: "음... 글쎄, 생각해볼게."
3. **거절 반응**: "미안하지만 오늘은 선약이 있어."`
            expect(parseReplySuggestions(raw)).toEqual([
                '그래, 같이 가자! 재미있겠다.',
                '음... 글쎄, 생각해볼게.',
                '미안하지만 오늘은 선약이 있어.',
            ])
        })

        it('parses bulleted list', () => {
            const raw = `- 그래, 오늘 재미있었어.
- 내일도 만날 수 있을까?
- 먼저 들어가볼게, 잘 자.`
            expect(parseReplySuggestions(raw)).toEqual([
                '그래, 오늘 재미있었어.',
                '내일도 만날 수 있을까?',
                '먼저 들어가볼게, 잘 자.',
            ])
        })

        it('parses truncated JSON with valid items recovered', () => {
            const raw = `[
  "첫 번째 완료된 답변입니다.",
  "두 번째 완료된 답변입니다.",
  "세 번째는 잘`
            const suggestions = parseReplySuggestions(raw)
            expect(suggestions.length).toBeGreaterThanOrEqual(2)
            expect(suggestions[0]).toBe('첫 번째 완료된 답변입니다.')
            expect(suggestions[1]).toBe('두 번째 완료된 답변입니다.')
        })

        it('handles single/double suggestions gracefully', () => {
            const raw = `1. 유일한 답변 후보입니다.`
            expect(parseReplySuggestions(raw)).toEqual(['유일한 답변 후보입니다.'])
        })

        it('deduplicates identical suggestions', () => {
            const raw = `["안녕하세요", "안녕하세요", "반갑습니다"]`
            expect(parseReplySuggestions(raw)).toEqual(['안녕하세요', '반갑습니다'])
        })
    })
})
