import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { count, desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { env } from '../env.js'

function getDbPath(): string | null {
    const candidates = [
        path.join(os.homedir(), '.omniroute', 'storage.sqlite'),
        path.join(env.dataDir, '../.omniroute/storage.sqlite'),
        path.join(env.dataDir, 'omniroute', 'storage.sqlite'),
    ]
    for (const c of candidates) {
        if (fs.existsSync(c)) return c
    }
    return null
}

export function getOmniDb() {
    const p = getDbPath()
    if (!p) return null
    try {
        return new Database(p)
    } catch {
        return null
    }
}

export function getLatestOmniRouteModel(): string | null {
    const omniDb = getOmniDb()
    if (omniDb) {
        try {
            const tables = omniDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t: any) => t.name)
            let row: any = null
            if (tables.includes('request_logs')) {
                row = omniDb.prepare('SELECT provider, model FROM request_logs ORDER BY created_at DESC LIMIT 1').get()
                if (row) {
                    const p = row.provider || ''
                    const m = row.model || ''
                    if (m && m !== 'auto' && m !== 'omniroute/auto' && m !== 'omniroute') return p && !m.startsWith(p) ? `${p}/${m}` : m
                }
            } else if (tables.includes('proxy_logs')) {
                row = omniDb.prepare('SELECT level, level_id FROM proxy_logs ORDER BY timestamp DESC LIMIT 1').get()
                if (row) {
                    const p = row.level || ''
                    const m = row.level_id || ''
                    if (m && m !== 'auto' && m !== 'omniroute/auto' && m !== 'omniroute') return p && !m.startsWith(p) ? `${p}/${m}` : m
                }
            } else if (tables.includes('logs')) {
                row = omniDb.prepare('SELECT provider, model FROM logs ORDER BY created_at DESC LIMIT 1').get()
                if (row) {
                    const p = row.provider || ''
                    const m = row.model || ''
                    if (m && m !== 'auto' && m !== 'omniroute/auto' && m !== 'omniroute') return p && !m.startsWith(p) ? `${p}/${m}` : m
                }
            }
        } catch (e) {
            console.warn('[omniroute] getLatestOmniRouteModel error:', e)
        } finally {
            omniDb.close()
        }
    }

    try {
        const lastUsage = db.select()
            .from(schema.usageLog)
            .where(eq(schema.usageLog.status, 'ok'))
            .orderBy(desc(schema.usageLog.createdAt))
            .limit(1)
            .get()
        if (lastUsage) {
            const p = lastUsage.providerKey || ''
            const m = lastUsage.upstreamModel || ''
            if (m && m !== 'auto' && m !== 'omniroute/auto' && m !== 'omniroute') {
                return p && !m.startsWith(p) ? `${p}/${m}` : m
            }
        }
    } catch (e) {
        console.warn('[omniroute] usageLog lookup error:', e)
    }

    return null
}

export async function fetchOmniRouteJson(endpoint: string): Promise<any> {
    if (!env.omnirouteUrl) return null
    try {
        const url = `${env.omnirouteUrl}${endpoint}`
        const headers: Record<string, string> = {}
        if (env.omnirouteApiKey) headers['Authorization'] = `Bearer ${env.omnirouteApiKey}`
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(4000) })
        if (!res.ok) return null
        return await res.json()
    } catch {
        return null
    }
}

export async function getOmniRouteDashboardData() {
    const [metrics, stats, tokenHealth, telemetry, limits, proxyLogs, models] = await Promise.all([
        fetchOmniRouteJson('/api/provider-metrics'),
        fetchOmniRouteJson('/api/provider-stats'),
        fetchOmniRouteJson('/api/token-health'),
        fetchOmniRouteJson('/api/telemetry/summary'),
        fetchOmniRouteJson('/api/usage/provider-limits'),
        fetchOmniRouteJson('/api/usage/proxy-logs'),
        fetchOmniRouteJson('/v1/models'),
    ])

    let providers: any[] = []
    let omniLogs: any[] = []

    const omniDb = getOmniDb()
    if (omniDb) {
        try {
            const tables = omniDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t: any) => t.name)
            if (tables.includes('provider_connections')) {
                providers = omniDb.prepare('SELECT id, provider, name, priority, is_active, test_status, last_tested, created_at, updated_at FROM provider_connections ORDER BY priority ASC, name ASC').all()
            }
            if (tables.includes('request_logs')) {
                omniLogs = omniDb.prepare('SELECT id, created_at as timestamp, status, provider as level, model as levelId, latency_ms as latencyMs FROM request_logs ORDER BY created_at DESC LIMIT 50').all()
            } else if (tables.includes('proxy_logs')) {
                omniLogs = omniDb.prepare('SELECT id, timestamp, status, level, level_id as levelId, latency_ms as latencyMs FROM proxy_logs ORDER BY timestamp DESC LIMIT 50').all()
            } else if (tables.includes('logs')) {
                omniLogs = omniDb.prepare('SELECT id, created_at as timestamp, status, provider as level, model as levelId, latency_ms as latencyMs FROM logs ORDER BY created_at DESC LIMIT 50').all()
            }
        } catch (e) {
            console.warn('[omniroute] sqlite query error:', e)
        } finally {
            omniDb.close()
        }
    }

    if (!providers.length) {
        try {
            const kaiProviders = db.select().from(schema.providers).all()
            providers = kaiProviders.map((p) => ({
                id: p.id,
                provider: p.key,
                name: p.label || p.key,
                priority: Number(p.priority ?? 100),
                is_active: p.enabled ? 1 : 0,
                test_status: p.enabled ? 'active' : 'inactive',
                last_tested: null,
            }))
        } catch (e) {
            console.warn('[omniroute] fallback providers error:', e)
        }
    }

    const kaiLogs = db.select().from(schema.usageLog).orderBy(desc(schema.usageLog.createdAt)).limit(100).all()

    let finalProxyLogs: any[] = []
    if (Array.isArray(proxyLogs) && proxyLogs.length > 0) {
        finalProxyLogs = proxyLogs.slice(0, 50)
    } else if (omniLogs.length > 0) {
        finalProxyLogs = omniLogs
    } else {
        finalProxyLogs = kaiLogs.map((l) => ({
            id: l.id,
            timestamp: typeof l.createdAt === 'number' && l.createdAt < 10000000000 ? l.createdAt * 1000 : l.createdAt,
            status: l.status === 'ok' ? 'success' : 'error',
            level: l.providerKey || 'omniroute',
            levelId: l.upstreamModel || l.alias || 'auto',
            latencyMs: l.latencyMs,
            tokensIn: l.tokensIn,
            tokensOut: l.tokensOut,
        }))
    }

    const actualTotalLogs = db.select({ n: count() }).from(schema.usageLog).get()?.n ?? 0
    const totalCount = telemetry?.count ?? Math.max(actualTotalLogs, finalProxyLogs.length)

    let p50 = telemetry?.p50
    let p95 = telemetry?.p95
    if ((p50 === undefined || p50 === null) && finalProxyLogs.length > 0) {
        const latencies = finalProxyLogs.map((l) => Number(l.latencyMs || 0)).filter((l) => l > 0).sort((a, b) => a - b)
        if (latencies.length > 0) {
            p50 = latencies[Math.floor(latencies.length * 0.5)]
            p95 = latencies[Math.floor(latencies.length * 0.95)]
        }
    }

    let providerStats = stats?.providers ?? []
    if (!providerStats.length && kaiLogs.length > 0) {
        const statsMap = new Map<string, { provider: string; totalRequests: number; successfulRequests: number; totalLatency: number }>()
        for (const log of kaiLogs) {
            const key = log.providerKey || 'omniroute'
            const existing = statsMap.get(key) || { provider: key, totalRequests: 0, successfulRequests: 0, totalLatency: 0 }
            existing.totalRequests += 1
            if (log.status === 'ok') existing.successfulRequests += 1
            existing.totalLatency += log.latencyMs
            statsMap.set(key, existing)
        }
        providerStats = Array.from(statsMap.values()).map((s) => ({
            provider: s.provider,
            totalRequests: s.totalRequests,
            successfulRequests: s.successfulRequests,
            avgLatencyMs: s.totalRequests > 0 ? Math.round(s.totalLatency / s.totalRequests) : 0,
        }))
    }

    let finalModels = models?.data ?? []
    if (!finalModels.length) {
        try {
            const kaiModels = db.select().from(schema.routedModels).where(eq(schema.routedModels.enabled, true)).all()
            if (kaiModels.length > 0) {
                finalModels = kaiModels.map((m) => ({ id: m.id, object: 'model', created: Date.now(), owned_by: m.providerKey }))
            } else {
                const aliases = db.select().from(schema.routingAliases).all()
                finalModels = aliases.map((a) => ({ id: a.alias, object: 'model', created: Date.now(), owned_by: 'omniroute' }))
            }
        } catch (e) {
            console.warn('[omniroute] fallback models error:', e)
        }
    }

    let finalTokenHealth = tokenHealth
    if (!finalTokenHealth) {
        const activeProviders = providers.filter((p) => p.is_active || p.isActive)
        const total = Math.max(providers.length, 1)
        const healthy = Math.max(activeProviders.length, 1)
        finalTokenHealth = {
            total,
            healthy,
            status: healthy === total ? 'healthy' : healthy > 0 ? 'degraded' : 'unhealthy',
        }
    }

    return {
        metrics: metrics?.metrics ?? {},
        stats: providerStats,
        tokenHealth: finalTokenHealth,
        telemetry: {
            count: totalCount,
            p50: p50 ?? null,
            p95: p95 ?? null,
        },
        limits: limits?.caches ?? {},
        proxyLogs: finalProxyLogs,
        models: finalModels,
        providers: providers.map((p) => ({
            id: p.id,
            provider: p.provider,
            name: p.name || p.provider,
            priority: Number(p.priority ?? 1),
            isActive: Boolean(p.is_active),
            testStatus: p.test_status || 'active',
            lastTested: p.last_tested || null,
        })),
    }
}

export function updateOmniRouteProvider(id: string, updates: { priority?: number; isActive?: boolean }) {
    const omniDb = getOmniDb()
    if (omniDb) {
        try {
            const setClause: string[] = []
            const params: any[] = []
            if (updates.priority !== undefined) {
                setClause.push('priority = ?')
                params.push(updates.priority)
            }
            if (updates.isActive !== undefined) {
                setClause.push('is_active = ?')
                params.push(updates.isActive ? 1 : 0)
            }
            setClause.push('updated_at = ?')
            params.push(new Date().toISOString())

            if (setClause.length === 1) return { success: true }
            params.push(id)

            const stmt = omniDb.prepare(`UPDATE provider_connections SET ${setClause.join(', ')} WHERE id = ?`)
            const res = stmt.run(...params)
            return { success: res.changes > 0 }
        } finally {
            omniDb.close()
        }
    }

    const setObj: any = {}
    if (updates.priority !== undefined) setObj.priority = updates.priority
    if (updates.isActive !== undefined) setObj.enabled = updates.isActive
    if (Object.keys(setObj).length > 0) {
        db.update(schema.providers).set(setObj).where(eq(schema.providers.id, id)).run()
    }
    return { success: true }
}

export function reorderOmniRouteProviders(order: Array<{ id: string; priority: number }>) {
    const omniDb = getOmniDb()
    if (omniDb) {
        try {
            const stmt = omniDb.prepare('UPDATE provider_connections SET priority = ?, updated_at = ? WHERE id = ?')
            const now = new Date().toISOString()
            const tx = omniDb.transaction(() => {
                for (const item of order) {
                    stmt.run(item.priority, now, item.id)
                }
            })
            tx()
            return { success: true }
        } finally {
            omniDb.close()
        }
    }

    for (const item of order) {
        db.update(schema.providers).set({ priority: item.priority }).where(eq(schema.providers.id, item.id)).run()
    }
    return { success: true }
}
