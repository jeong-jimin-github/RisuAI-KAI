/** Per-user gateway limits shared by the completion and account routes. */

import type { UsageQuota } from '../../../shared/contract.js'
import { env } from '../env.js'
import { HttpError, RateLimiter } from '../util/http.js'

const minuteLimiter = new RateLimiter(env.userRpm, 60_000)
const daily = new Map<string, { day: string; count: number }>()

setInterval(() => minuteLimiter.sweep(), 60_000).unref()

function utcDay(now = new Date()): string {
    return now.toISOString().slice(0, 10)
}

function nextUtcDay(day: string): string {
    return new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString()
}

function dailyEntry(userId: string): { day: string; count: number } {
    const day = utcDay()
    const current = daily.get(userId)
    if (current?.day === day) return current
    const fresh = { day, count: 0 }
    daily.set(userId, fresh)
    return fresh
}

export function getUserQuota(userId: string): UsageQuota {
    const minute = minuteLimiter.peek(userId)
    const day = dailyEntry(userId)
    return {
        minute: {
            limit: env.userRpm,
            remaining: minute?.remaining ?? env.userRpm,
            resetAt: minute ? new Date(minute.resetAt).toISOString() : null,
        },
        daily: {
            limit: env.userRpd,
            remaining: Math.max(0, env.userRpd - day.count),
            resetAt: nextUtcDay(day.day),
        },
    }
}

/** Consumes one completion request and returns the post-consumption allowance. */
export function takeUserQuota(userId: string): UsageQuota {
    const day = dailyEntry(userId)
    if (day.count >= env.userRpd) {
        throw HttpError.rateLimited('Daily request limit reached', { quota: getUserQuota(userId) })
    }

    const minute = minuteLimiter.take(userId)
    if (!minute) {
        throw HttpError.rateLimited('Minute request limit reached', { quota: getUserQuota(userId) })
    }

    day.count++
    return getUserQuota(userId)
}

