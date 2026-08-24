import { Hono } from 'hono'
import { and, count, desc, eq, gte, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { AdminStats, ProviderConfig, RoutedModel } from '../../../shared/contract.js'
import { requireAdmin } from '../auth/middleware.js'
import { db, schema } from '../db/index.js'
import { env } from '../env.js'
import { routeChat } from '../llm/router.js'
import { audit, readAuditLog } from '../services/audit.js'
import { bumpRevision } from '../services/config.js'
import { generationFromPreset, readHypaPresetFile, readPresetFile } from '../cards/preset.js'
import { installModule, listModules, moduleSummary } from '../services/modules.js'
import { isValueToggle, toggleSpec } from '../services/toggles.js'
import { installPlugin } from '../services/plugins.js'
import { getSystemStatus } from '../services/systemStatus.js'
import { getOmniRouteDashboardData, reorderOmniRouteProviders, updateOmniRouteProvider } from '../services/omniroute.js'
import { saveAsset } from '../services/assets.js'
import { cleanupLowQualityCharacters } from '../services/characters.js'
import { DEFAULT_FEATURES, DEFAULT_GENERATION, DEFAULT_SITE, SETTING_KEYS, getFeatureFlags, getGenerationConfig, getSetting, getSiteConfig, setSetting } from '../services/settings.js'
import type { KaiEnv } from '../types.js'
import { encryptSecret, hashPassword } from '../util/crypto.js'
import { HttpError, ok } from '../util/http.js'
import { newId } from '../util/ids.js'
import { toPublicUser } from './me.js'

const app = new Hono<KaiEnv>()
app.use('*', requireAdmin)
const unix = () => Math.floor(Date.now()/1000)

app.get('/status', async (c) => ok(c, await getSystemStatus()))

async function body(c: any) { try { return await c.req.json() as Record<string, any> } catch { throw HttpError.badRequest('Expected JSON') } }
async function changed(c: any, action: string, target?: string, detail: Record<string,unknown> = {}) { await bumpRevision(); await audit(c.get('user')!.id, action, target ?? null, detail, c.get('ip')) }

app.get('/stats', (c) => {
    const today = unix() - 86400, week = unix() - 7*86400
    const total = (table: any) => db.select({ n: count() }).from(table).get()?.n ?? 0
    const stats: AdminStats = {
        users: { total: total(schema.users), activeToday: db.select({n:count()}).from(schema.users).where(gte(schema.users.lastSeenAt,today)).get()?.n ?? 0, newThisWeek: db.select({n:count()}).from(schema.users).where(gte(schema.users.createdAt,week)).get()?.n ?? 0 },
        chats: { total: total(schema.chats), today: db.select({n:count()}).from(schema.chats).where(gte(schema.chats.createdAt,today)).get()?.n ?? 0 },
        messages: { total: total(schema.messages), today: db.select({n:count()}).from(schema.messages).where(gte(schema.messages.time,today)).get()?.n ?? 0 },
        characters: { total: total(schema.characters), public: db.select({n:count()}).from(schema.characters).where(eq(schema.characters.visibility,'public')).get()?.n ?? 0 },
        routing: { requestsToday: db.select({n:count()}).from(schema.usageLog).where(gte(schema.usageLog.createdAt,today)).get()?.n ?? 0, successRate: 0, p50LatencyMs: null, byProvider: [] },
    }
    const usage = db.select().from(schema.usageLog).where(gte(schema.usageLog.createdAt,today)).all()
    if (usage.length) { const times=usage.map(x=>x.latencyMs).sort((a,b)=>a-b); stats.routing.successRate=usage.filter(x=>x.status==='ok').length/usage.length; stats.routing.p50LatencyMs=times[Math.floor(times.length/2)] ?? null; const m=new Map<string,{requests:number;failures:number}>(); for(const u of usage){const x=m.get(u.providerKey)??{requests:0,failures:0};x.requests++;if(u.status!=='ok')x.failures++;m.set(u.providerKey,x)} stats.routing.byProvider=[...m].map(([providerKey,x])=>({providerKey,...x})) }
    return ok(c, stats)
})

app.get('/settings', async (c) => ok(c, { site: await getSiteConfig(), generation: await getGenerationConfig(), features: await getFeatureFlags() }))
app.put('/settings/:key', async (c) => {
    const key = c.req.param('key'), value = await body(c)
    if (!['site','generation','features'].includes(key)) throw HttpError.notFound()
    const fallback = key==='site'?DEFAULT_SITE:key==='generation'?DEFAULT_GENERATION:DEFAULT_FEATURES
    await setSetting(key, { ...fallback, ...value }); await changed(c, `settings.${key}`, key); return ok(c, { saved: true })
})

const adminUserPatch = z.object({
    displayName: z.string().trim().min(1).max(40).optional(),
    email: z.string().trim().min(3).max(254).email().optional(),
    role: z.enum(['user', 'admin']).optional(),
    status: z.enum(['active', 'suspended', 'pending']).optional(),
    password: z.string().trim().min(6).max(128).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' })

function adminUserDto(user: typeof schema.users.$inferSelect) {
    const chatCount = db.select({ n: count() }).from(schema.chats).where(eq(schema.chats.userId, user.id)).get()?.n ?? 0
    const messageCount = db.select({ n: sql<number>`coalesce(sum(${schema.chats.messageCount}), 0)` })
        .from(schema.chats).where(eq(schema.chats.userId, user.id)).get()?.n ?? 0
    return {
        ...toPublicUser(user),
        chatCount,
        messageCount: Number(messageCount),
        lastSeenAt: user.lastSeenAt ? new Date(user.lastSeenAt * 1000).toISOString() : null,
    }
}

app.get('/users', (c) => ok(c, db.select().from(schema.users).orderBy(desc(schema.users.createdAt)).all().map(adminUserDto)))
app.patch('/users/:id', async (c) => {
    const id = c.req.param('id')
    const current = db.select().from(schema.users).where(eq(schema.users.id, id)).get()
    if (!current) throw HttpError.notFound('User not found')
    const parsed = adminUserPatch.safeParse(await body(c))
    if (!parsed.success) throw HttpError.badRequest('사용자 정보를 확인해 주세요.', parsed.error.flatten())
    const patch = parsed.data
    const set: Partial<typeof schema.users.$inferInsert> = {}

    if (patch.displayName !== undefined) set.displayName = patch.displayName
    if (patch.email !== undefined) {
        const emailNormalized = patch.email.toLowerCase()
        const clash = db.select({ id: schema.users.id }).from(schema.users)
            .where(eq(schema.users.emailNormalized, emailNormalized)).get()
        if (clash && clash.id !== id) throw HttpError.conflict('이미 등록된 이메일입니다.')
        set.email = patch.email
        set.emailNormalized = emailNormalized
    }
    if (patch.role !== undefined) set.role = patch.role
    if (patch.status !== undefined) set.status = patch.status
    if (patch.password !== undefined) set.passwordHash = await hashPassword(patch.password)

    const removesLastActiveAdmin = current.role === 'admin' && current.status === 'active' &&
        (set.role === 'user' || (set.status !== undefined && set.status !== 'active'))
    if (removesLastActiveAdmin) {
        const other = db.select({ id: schema.users.id }).from(schema.users).where(and(
            eq(schema.users.role, 'admin'),
            eq(schema.users.status, 'active'),
            ne(schema.users.id, id),
        )).get()
        if (!other) throw HttpError.badRequest('활성 관리자 계정은 최소 한 개 필요합니다.')
    }

    const row = db.update(schema.users).set(set).where(eq(schema.users.id, id)).returning().get()
    await changed(c, 'users.update', row.id, { fields: Object.keys(set) })
    return ok(c, adminUserDto(row))
})

app.get('/characters', (c) => ok(c, db.select({
    id: schema.characters.id,
    slug: schema.characters.slug,
    name: schema.characters.name,
    tagline: schema.characters.tagline,
    creatorName: schema.characters.creatorName,
    avatarAssetId: schema.characters.avatarAssetId,
    tags: schema.characters.tags,
    nsfw: schema.characters.nsfw,
    visibility: schema.characters.visibility,
    featured: schema.characters.featured,
    sortOrder: schema.characters.sortOrder,
    greetingCount: schema.characters.greetingCount,
    chatCount: schema.characters.chatCount,
    messageCount: schema.characters.messageCount,
    likeCount: schema.characters.likeCount,
    updatedAt: schema.characters.updatedAt,
}).from(schema.characters).orderBy(desc(schema.characters.updatedAt)).all()))

/** Full, unsanitized card data is only available behind the admin middleware. */
app.get('/characters/:id', (c) => {
    const row = db.select().from(schema.characters).where(eq(schema.characters.id, c.req.param('id'))).get()
    if (!row) throw HttpError.notFound('Character not found')
    const assetRows = db
        .select({ refKey: schema.characterAssets.refKey, assetId: schema.characterAssets.assetId })
        .from(schema.characterAssets)
        .where(eq(schema.characterAssets.characterId, row.id))
        .all()
    const assets = Object.fromEntries(assetRows.map((a) => [a.refKey, `/api/assets/${a.assetId}`]))
    return ok(c, { ...row, card: row.cardJson, cardJson: undefined, assets })
})

app.patch('/characters/:id', async (c) => {
    const id = c.req.param('id')
    const current = db.select().from(schema.characters).where(eq(schema.characters.id, id)).get()
    if (!current) throw HttpError.notFound('Character not found')

    const b = await body(c)
    const allowed = ['name', 'tagline', 'creatorName', 'creatorNotes', 'visibility', 'featured', 'nsfw', 'sortOrder', 'tags']
    const set: any = { updatedAt: unix() }
    for (const key of allowed) if (b[key] !== undefined) set[key] = b[key]

    if (b.card !== undefined) {
        if (!b.card || typeof b.card !== 'object' || Array.isArray(b.card)) {
            throw HttpError.badRequest('Character card must be an object')
        }
        if (Buffer.byteLength(JSON.stringify(b.card), 'utf8') > env.maxCardUploadBytes) {
            throw HttpError.tooLarge('Character card is too large')
        }

        const card = structuredClone(b.card) as Record<string, any>
        const name = String(b.name ?? card.name ?? '').trim()
        if (!name) throw HttpError.badRequest('Character name is required')
        const tags = (Array.isArray(b.tags) ? b.tags : Array.isArray(card.tags) ? card.tags : [])
            .map(String).map((tag: string) => tag.trim()).filter(Boolean).slice(0, 30)
        const creatorName = String(b.creatorName ?? card.creator ?? '')
        const creatorNotes = String(b.creatorNotes ?? card.creatorNotes ?? '')

        // Keep the searchable columns and the verbatim engine card in sync.
        card.name = name
        card.tags = tags
        card.creator = creatorName
        card.creatorNotes = creatorNotes
        set.name = name
        set.tags = tags
        set.creatorName = creatorName
        set.creatorNotes = creatorNotes
        set.greetingCount = 1 + (Array.isArray(card.alternateGreetings) ? card.alternateGreetings.length : 0)
        set.cardJson = card
    }

    if (set.visibility !== undefined && !['public', 'private'].includes(set.visibility)) {
        throw HttpError.badRequest('Invalid character visibility')
    }
    if (set.name !== undefined) {
        set.name = String(set.name).trim()
        if (!set.name) throw HttpError.badRequest('Character name is required')
    }
    if (set.tags !== undefined && !Array.isArray(set.tags)) throw HttpError.badRequest('Character tags must be an array')

    const row = db.update(schema.characters).set(set).where(eq(schema.characters.id, id)).returning().get()
    await changed(c, 'characters.update', row.id, { fields: Object.keys(set).filter((key) => key !== 'cardJson') })
    return ok(c, { ...row, card: row.cardJson, cardJson: undefined })
})

app.post('/characters/:id/avatar', async (c) => {
    const id = c.req.param('id')
    const current = db.select().from(schema.characters).where(eq(schema.characters.id, id)).get()
    if (!current) throw HttpError.notFound('Character not found')
    const form = await c.req.parseBody({ all: false })
    const file = form.file
    if (!(file instanceof File)) throw HttpError.badRequest('Missing image file')
    if (file.size > env.maxUploadBytes) throw HttpError.tooLarge('Image is too large')
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) {
        throw HttpError.unsupported('Use a PNG, JPEG, GIF, or WebP image')
    }
    const asset = await saveAsset(new Uint8Array(await file.arrayBuffer()), file.type, 'card_image', c.get('user')!.id)
    const row = db.update(schema.characters).set({ avatarAssetId: asset.id, updatedAt: unix() })
        .where(eq(schema.characters.id, id)).returning().get()
    await changed(c, 'characters.avatar', id, { assetId: asset.id })
    return ok(c, { avatarAssetId: row.avatarAssetId, avatarUrl: `/api/assets/${row.avatarAssetId}` })
})

app.post('/characters/:id/asset', async (c) => {
    const id = c.req.param('id')
    const current = db.select().from(schema.characters).where(eq(schema.characters.id, id)).get()
    if (!current) throw HttpError.notFound('Character not found')
    const form = await c.req.parseBody({ all: false })
    const file = form.file
    if (!(file instanceof File)) throw HttpError.badRequest('Missing image file')
    if (file.size > env.maxUploadBytes) throw HttpError.tooLarge('Image is too large')
    const refKey = String(form.refKey || file.name || `image_${Date.now()}`).trim()

    const asset = await saveAsset(new Uint8Array(await file.arrayBuffer()), file.type || 'image/png', 'card_image', c.get('user')!.id)
    db.insert(schema.characterAssets)
        .values({ characterId: id, assetId: asset.id, refKey })
        .onConflictDoUpdate({
            target: [schema.characterAssets.characterId, schema.characterAssets.refKey],
            set: { assetId: asset.id },
        })
        .run()

    await changed(c, 'characters.asset', id, { refKey, assetId: asset.id })
    return ok(c, { refKey, assetId: asset.id, url: `/api/assets/${asset.id}` })
})

app.delete('/characters/:id/asset', async (c) => {
    const id = c.req.param('id')
    const refKey = c.req.query('refKey')
    if (!refKey) throw HttpError.badRequest('refKey parameter is required')
    db.delete(schema.characterAssets)
        .where(and(eq(schema.characterAssets.characterId, id), eq(schema.characterAssets.refKey, refKey)))
        .run()
    await changed(c, 'characters.asset_delete', id, { refKey })
    return ok(c, { success: true })
})

app.post('/characters/cleanup-low-quality', async (c) => {
    const { deletedCount } = cleanupLowQualityCharacters()
    await changed(c, 'characters.cleanup_low_quality', undefined, { deletedCount })
    return ok(c, { deletedCount })
})

app.delete('/characters/:id', async (c) => {
    const id = c.req.param('id')
    const row = db.delete(schema.characters).where(eq(schema.characters.id, id)).returning({ id: schema.characters.id }).get()
    if (!row) throw HttpError.notFound('Character not found')
    await changed(c, 'characters.delete', id)
    return ok(c, row)
})

app.get('/omniroute/dashboard', async (c) => ok(c, await getOmniRouteDashboardData()))
app.patch('/omniroute/providers/:id', async (c) => {
    const id = c.req.param('id')
    const b = await body(c)
    const result = updateOmniRouteProvider(id, {
        priority: b.priority !== undefined ? Number(b.priority) : undefined,
        isActive: b.isActive !== undefined ? Boolean(b.isActive) : undefined,
    })
    await changed(c, 'omniroute.provider.update', id, b)
    return ok(c, result)
})
app.post('/omniroute/providers/reorder', async (c) => {
    const b = await body(c)
    if (!Array.isArray(b.order)) throw HttpError.badRequest('Expected array "order"')
    const result = reorderOmniRouteProviders(b.order)
    await changed(c, 'omniroute.providers.reorder')
    return ok(c, result)
})

function providerDto(p: typeof schema.providers.$inferSelect): ProviderConfig { return { id:p.id,key:p.key,kind:p.kind as any,label:p.label,baseUrl:p.baseUrl,auth:p.auth,hasApiKey:!!p.apiKeyEnc,authHeaderName:p.authHeaderName,enabled:p.enabled,priority:p.priority,rpm:p.rpm,rpd:p.rpd,concurrency:p.concurrency,timeoutMs:p.timeoutMs,notes:p.notes } }
app.get('/providers', (c) => ok(c, db.select().from(schema.providers).all().map(providerDto)))
app.post('/providers', async (c) => { const b=await body(c);const row=db.insert(schema.providers).values({id:newId('pr_'),key:String(b.key),kind:String(b.kind),label:String(b.label??b.key),baseUrl:String(b.baseUrl),auth:b.auth??'none',apiKeyEnc:b.apiKey?encryptSecret(String(b.apiKey)):null,authHeaderName:b.authHeaderName??null,enabled:b.enabled??true,priority:Number(b.priority??100),rpm:b.rpm??null,rpd:b.rpd??null,concurrency:Number(b.concurrency??4),timeoutMs:Number(b.timeoutMs??120000),notes:String(b.notes??'')}).returning().get();await changed(c,'providers.create',row.id);return ok(c,providerDto(row),201) })
app.patch('/providers/:id', async (c) => { const b=await body(c);const set:any={...b};delete set.id;delete set.hasApiKey;if('apiKey'in set){set.apiKeyEnc=set.apiKey?encryptSecret(String(set.apiKey)):null;delete set.apiKey}const row=db.update(schema.providers).set(set).where(eq(schema.providers.id,c.req.param('id'))).returning().get();if(!row)throw HttpError.notFound();await changed(c,'providers.update',row.id);return ok(c,providerDto(row)) })

app.get('/models', (c) => { const hs=new Map(db.select().from(schema.modelHealth).all().map(h=>[h.modelId,h]));return ok(c,db.select().from(schema.routedModels).where(eq(schema.routedModels.enabled, true)).all().map(m=>({...m,health:hs.get(m.id)??{state:'unknown',successCount:0,errorCount:0,consecutiveFailures:0,p50LatencyMs:null,lastError:null,lastCheckedAt:null,cooldownUntil:null}}))) })
app.patch('/models/:id', async (c) => {const b=await body(c);const row=db.update(schema.routedModels).set(b).where(eq(schema.routedModels.id,c.req.param('id'))).returning().get();if(!row)throw HttpError.notFound();await changed(c,'models.update',row.id);return ok(c,row)})
app.post('/models/:id/probe', async (c) => {const model=db.select().from(schema.routedModels).where(eq(schema.routedModels.id,c.req.param('id'))).get();if(!model)throw HttpError.notFound();const out=await routeChat({messages:[{role:'user',content:'Reply only: OK'}],maxTokens:8,estimatedTokens:8,requiresVision:false},{alias:model.id,maxAttempts:1});return ok(c,{providerKey:model.providerKey,upstreamModel:model.upstreamModel,ok:true,status:200,latencyMs:out.latencyMs,sample:out.text,error:null})})

app.get('/aliases', (c)=>ok(c,db.select().from(schema.routingAliases).all()))
app.put('/aliases/:alias', async(c)=>{const b=await body(c);db.insert(schema.routingAliases).values({alias:c.req.param('alias'),label:String(b.label??c.req.param('alias')),description:String(b.description??''),tiers:b.tiers??['smart','balanced','fast'],modelIds:b.modelIds??[],sortOrder:Number(b.sortOrder??0)}).onConflictDoUpdate({target:schema.routingAliases.alias,set:b}).run();await changed(c,'aliases.update',c.req.param('alias'));return ok(c,{alias:c.req.param('alias')})})

app.get('/plugins',(c)=>ok(c,db.select().from(schema.plugins).all()))
app.post('/plugins',async(c)=>{const b=await body(c);const row=await installPlugin(String(b.source??''),{enabled:b.enabled,forced:b.forced,replace:b.replace});await changed(c,'plugins.install',row.id);return ok(c,row,201)})
app.patch('/plugins/:id',async(c)=>{const b=await body(c);const row=db.update(schema.plugins).set(b).where(eq(schema.plugins.id,c.req.param('id'))).returning().get();if(!row)throw HttpError.notFound();await changed(c,'plugins.update',row.id);return ok(c,row)})
app.delete('/plugins/:id',async(c)=>{const id=c.req.param('id');db.delete(schema.plugins).where(eq(schema.plugins.id,id)).run();await changed(c,'plugins.delete',id);return ok(c,{id})})
/* ------------------------------------------------------------------ *
 * Prompt presets, modules and HypaV3 — the engine-behaviour trio
 *
 * These are instance-wide, like plugins: the admin curates them and every user
 * gets the result. Shared RisuAI presets routinely require a matching module,
 * so the two are managed side by side.
 * ------------------------------------------------------------------ */

/** Reads a single uploaded file out of a multipart form. */
async function uploadedFile(c: any): Promise<{ name: string; bytes: Uint8Array }> {
    const form = await c.req.parseBody({ all: false })
    const file = form.file
    if (!(file instanceof File)) throw HttpError.badRequest('Missing file')
    if (file.size > env.maxCardUploadBytes) throw HttpError.tooLarge('File is too large')
    return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }
}

app.get('/presets', (c) => ok(c, db.select({
    id: schema.promptPresets.id, name: schema.promptPresets.name,
    isDefault: schema.promptPresets.isDefault, updatedAt: schema.promptPresets.updatedAt,
}).from(schema.promptPresets).orderBy(desc(schema.promptPresets.isDefault), desc(schema.promptPresets.updatedAt)).all()))

app.post('/presets/import', async (c) => {
    const { name, bytes } = await uploadedFile(c)
    const decoded = await readPresetFile(name, bytes)
    const makeDefault = c.req.query('default') !== 'false'
    if (makeDefault) db.update(schema.promptPresets).set({ isDefault: false }).run()
    const row = db.insert(schema.promptPresets).values({
        id: newId('pre_'), name: decoded.name, preset: decoded.preset, isDefault: makeDefault,
    }).returning().get()

    // A preset ships its own generation settings, and `buildPreset` puts the
    // admin's values on top of it. Adopting them here is what makes the preset
    // arrive tuned the way its author intended instead of half-overridden —
    // and it puts the numbers in the admin form where they can be seen.
    // Skipped when the preset is imported as a non-default alternative.
    let adopted: string[] = []
    if (makeDefault) {
        const fromPreset = generationFromPreset(decoded.preset)
        adopted = Object.keys(fromPreset)
        if (adopted.length) {
            const current = await getGenerationConfig()
            await setSetting(SETTING_KEYS.generation, { ...current, ...fromPreset })
        }
    }

    await changed(c, 'presets.import', row.id, { name: row.name, adopted })
    return ok(c, {
        id: row.id, name: row.name, isDefault: row.isDefault,
        fields: Object.keys(decoded.preset).length,
        adopted,
    }, 201)
})

app.patch('/presets/:id', async (c) => {
    const b = await body(c)
    if (b.isDefault === true) db.update(schema.promptPresets).set({ isDefault: false }).run()
    const set: any = { updatedAt: unix() }
    if (typeof b.name === 'string') set.name = b.name
    if (typeof b.isDefault === 'boolean') set.isDefault = b.isDefault
    const row = db.update(schema.promptPresets).set(set).where(eq(schema.promptPresets.id, c.req.param('id'))).returning().get()
    if (!row) throw HttpError.notFound()
    await changed(c, 'presets.update', row.id, set)
    return ok(c, { id: row.id, name: row.name, isDefault: row.isDefault })
})

app.delete('/presets/:id', async (c) => {
    const id = c.req.param('id')
    db.delete(schema.promptPresets).where(eq(schema.promptPresets.id, id)).run()
    await changed(c, 'presets.delete', id)
    return ok(c, { id })
})

app.get('/modules', (c) => ok(c, listModules()))

app.post('/modules/import', async (c) => {
    const { name, bytes } = await uploadedFile(c)
    const { row, replaced } = installModule(bytes, { fileName: name })
    await changed(c, replaced ? 'modules.replace' : 'modules.install', row.id, { name: row.name })
    return ok(c, { ...moduleSummary(row), replaced }, replaced ? 200 : 201)
})

app.patch('/modules/:id', async (c) => {
    const b = await body(c)
    const set: any = { updatedAt: unix() }
    if (typeof b.enabled === 'boolean') set.enabled = b.enabled
    if (typeof b.sortOrder === 'number') set.sortOrder = b.sortOrder
    const row = db.update(schema.engineModules).set(set).where(eq(schema.engineModules.id, c.req.param('id'))).returning().get()
    if (!row) throw HttpError.notFound()
    await changed(c, 'modules.update', row.id, set)
    return ok(c, moduleSummary(row))
})

app.delete('/modules/:id', async (c) => {
    const id = c.req.param('id')
    db.delete(schema.engineModules).where(eq(schema.engineModules.id, id)).run()
    await changed(c, 'modules.delete', id)
    return ok(c, { id })
})

/**
 * The options the active preset/modules declare, plus the admin's picks.
 * `spec` is derived from the preset on every read, so importing a different
 * preset immediately changes what the admin sees.
 */
app.get('/toggles', async (c) => {
    const spec = toggleSpec()
    const values = await getSetting<Record<string, string>>(SETTING_KEYS.toggleValues, {})
    return ok(c, { spec, values })
})

app.put('/toggles', async (c) => {
    const b = await body(c)
    const allowed = new Set(toggleSpec().filter(isValueToggle).map((t) => t.key))
    const next: Record<string, string> = {}
    for (const [k, v] of Object.entries(b ?? {})) {
        // Keys the current preset no longer declares are dropped rather than
        // kept around to reappear if that preset is ever imported again.
        if (allowed.has(k) && v !== null && v !== undefined) next[k] = String(v)
    }
    await setSetting(SETTING_KEYS.toggleValues, next)
    await changed(c, 'toggles.update', undefined, { count: Object.keys(next).length })
    return ok(c, { saved: true, count: Object.keys(next).length })
})

app.get('/hypa', async (c) => {
    const preset = await getSetting<Record<string, unknown> | null>(SETTING_KEYS.hypaPreset, null)
    return ok(c, preset ? { name: String(preset.name ?? 'HypaV3'), installed: true } : { name: null, installed: false })
})

app.post('/hypa/import', async (c) => {
    const { name, bytes } = await uploadedFile(c)
    const decoded = readHypaPresetFile(name, bytes)
    await setSetting(SETTING_KEYS.hypaPreset, decoded.data)
    await changed(c, 'hypa.import', undefined, { name: decoded.name })
    return ok(c, { name: decoded.name, installed: true }, 201)
})

app.delete('/hypa', async (c) => {
    await setSetting(SETTING_KEYS.hypaPreset, null)
    await changed(c, 'hypa.delete')
    return ok(c, { installed: false })
})

app.get('/audit',async(c)=>ok(c,await readAuditLog({page:Number(c.req.query('page')??1),pageSize:Number(c.req.query('pageSize')??50),action:c.req.query('action')})))

export default app
