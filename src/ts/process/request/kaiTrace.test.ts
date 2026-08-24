import { describe, expect, it } from 'vitest'
import { attachKaiChatTrace } from './kaiTrace'

describe('attachKaiChatTrace', () => {
    it('attaches the hosted chat id to the same-origin KAI gateway request', () => {
        const body: Record<string, any> = {}

        attachKaiChatTrace(body, { aiModel: 'reverse_proxy', chatId: 'ch_test', sameOrigin: true })

        expect(body.kai_chat_id).toBe('ch_test')
    })

    it('does not disclose the hosted chat id to an external reverse proxy', () => {
        const body: Record<string, any> = {}

        attachKaiChatTrace(body, { aiModel: 'reverse_proxy', chatId: 'ch_test', sameOrigin: false })

        expect(body).not.toHaveProperty('kai_chat_id')
    })

    it('does not alter ordinary provider requests', () => {
        const body: Record<string, any> = {}

        attachKaiChatTrace(body, { aiModel: 'openrouter', chatId: 'ch_test', sameOrigin: true })

        expect(body).not.toHaveProperty('kai_chat_id')
    })
})
