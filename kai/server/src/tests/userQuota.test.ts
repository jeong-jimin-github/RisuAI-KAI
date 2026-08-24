import { describe, expect, it } from 'vitest'
import { getUserQuota, takeUserQuota } from '../services/userQuota.js'

describe('user gateway quota', () => {
    it('reports a fresh allowance and decrements both windows after a request', () => {
        const userId = `quota-test-${crypto.randomUUID()}`
        const before = getUserQuota(userId)

        expect(before.minute.remaining).toBe(before.minute.limit)
        expect(before.minute.resetAt).toBeNull()
        expect(before.daily.remaining).toBe(before.daily.limit)

        const after = takeUserQuota(userId)
        expect(after.minute.remaining).toBe(before.minute.limit - 1)
        expect(after.minute.resetAt).not.toBeNull()
        expect(after.daily.remaining).toBe(before.daily.limit - 1)
        expect(after.daily.resetAt).not.toBeNull()
    })
})

