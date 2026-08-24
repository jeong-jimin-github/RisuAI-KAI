/**
 * Admin audit trail. Every mutating admin route writes one row here; the admin
 * UI reads it back paged.
 */

import { and, count, desc, eq, like } from 'drizzle-orm'
import type { AuditEntry, Paged } from '../../../shared/contract.js'
import { db, schema } from '../db/index.js'
import { newId } from '../util/ids.js'

const iso = (unix: number) => new Date(unix * 1000).toISOString()

export async function audit(
    actorId: string | null,
    action: string,
    target: string | null = null,
    detail: Record<string, unknown> = {},
    ip: string | null = null,
): Promise<void> {
    db.insert(schema.auditLog)
        .values({
            id: newId('aud_'),
            actorId,
            action,
            target,
            detail,
            ip,
            createdAt: Math.floor(Date.now() / 1000),
        })
        .run()
}

export interface AuditQuery {
    page?: number
    pageSize?: number
    actorId?: string
    /** Prefix match, e.g. `models.` to see only routing changes. */
    action?: string
}

export async function readAuditLog(q: AuditQuery = {}): Promise<Paged<AuditEntry>> {
    const page = Math.max(1, q.page ?? 1)
    const pageSize = Math.min(200, Math.max(1, q.pageSize ?? 50))

    const filters = [
        q.actorId ? eq(schema.auditLog.actorId, q.actorId) : undefined,
        q.action ? like(schema.auditLog.action, `${q.action}%`) : undefined,
    ].filter((f) => f !== undefined)
    const where = filters.length ? and(...filters) : undefined

    const total = db.select({ n: count() }).from(schema.auditLog).where(where).get()?.n ?? 0

    const rows = db
        .select({
            id: schema.auditLog.id,
            actorId: schema.auditLog.actorId,
            actorEmail: schema.users.email,
            action: schema.auditLog.action,
            target: schema.auditLog.target,
            detail: schema.auditLog.detail,
            createdAt: schema.auditLog.createdAt,
        })
        .from(schema.auditLog)
        .leftJoin(schema.users, eq(schema.users.id, schema.auditLog.actorId))
        .where(where)
        .orderBy(desc(schema.auditLog.createdAt), desc(schema.auditLog.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .all()

    return {
        items: rows.map((r) => ({
            id: r.id,
            actorId: r.actorId,
            actorEmail: r.actorEmail ?? null,
            action: r.action,
            target: r.target,
            detail: (r.detail ?? {}) as Record<string, unknown>,
            createdAt: iso(r.createdAt),
        })),
        total,
        page,
        pageSize,
    }
}
