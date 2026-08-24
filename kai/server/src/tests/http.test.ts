import { describe, expect, it } from 'vitest'
import { requestIsSecure } from '../util/http.js'

describe('requestIsSecure', () => {
    it('uses the actual request protocol instead of the configured public URL', () => {
        expect(requestIsSecure('http://risuai.work.gd/api/auth/login', undefined, false)).toBe(false)
        expect(requestIsSecure('https://risuai.work.gd/api/auth/login', undefined, false)).toBe(true)
    })

    it('honours X-Forwarded-Proto only for a trusted proxy', () => {
        expect(requestIsSecure('http://127.0.0.1/api/auth/login', 'https', true)).toBe(true)
        expect(requestIsSecure('http://127.0.0.1/api/auth/login', 'https', false)).toBe(false)
        expect(requestIsSecure('http://127.0.0.1/api/auth/login', 'https, http', true)).toBe(true)
    })
})
