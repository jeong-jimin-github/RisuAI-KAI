import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Hono } from 'hono'
import { compress } from 'hono/compress'
import { secureHeaders } from 'hono/secure-headers'
import { attachContext } from './auth/middleware.js'
import { db, migrateDatabase, schema } from './db/index.js'
import { env } from './env.js'

import admin from './routes/admin.js'
import auth from './routes/auth.js'
import characters from './routes/characters.js'
import chats from './routes/chats.js'
import gateway from './routes/gateway.js'
import me from './routes/me.js'
import personas from './routes/personas.js'
import { getAsset, readAsset } from './services/assets.js'
import { canThumbnail, getThumbnailPath } from './services/thumbnails.js'
import { backfillCardEngineFields } from './services/characters.js'
import { backfillMissingGenreTags } from './services/genreTags.js'
import { getRuntimeConfig } from './services/config.js'
import type { KaiEnv } from './types.js'
import { hashPassword } from './util/crypto.js'
import { fail, HttpError, ok } from './util/http.js'
import { newId, newToken } from './util/ids.js'

migrateDatabase()
backfillCardEngineFields()
await bootstrapAdmin()

const app = new Hono<KaiEnv>()
app.use('*', secureHeaders({ crossOriginResourcePolicy: 'same-origin' }))
app.use('*', compress())
app.use('*', async (c, next) => {
    await next()
    if (c.res.headers.get('Content-Type')?.includes('text/html')) {
        c.res.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate')
        c.res.headers.set('Pragma', 'no-cache')
        c.res.headers.set('Expires', '0')
    }
})
app.use('*', attachContext)

app.get('/api/health', (c) => ok(c, { status: 'ok', version: '0.1.0' }))
app.get('/api/config', async (c) => ok(c, await getRuntimeConfig(c.get('user'))))
app.get('/api/config/revision', async (c) => ok(c, { revision: (await getRuntimeConfig(c.get('user'))).revision }))
app.get('/api/assets/:id', async (c) => {
    const id = c.req.param('id')
    const width = Number(c.req.query('w') || 0) | 0
    // Thumbnail path: ask the resizer for a cached WebP; on any failure fall
    // through to serving the original so a broken ffmpeg never breaks images.
    if (width > 0) {
        const row = getAsset(id)
        if (canThumbnail(row.mime, width)) {
            const thumbPath = await getThumbnailPath(id, resolve(env.assetsDir, row.path), width)
            if (thumbPath) {
                const bytes = await readFile(thumbPath)
                c.header('Content-Type', 'image/webp')
                c.header('Cache-Control', 'public, max-age=31536000, immutable')
                return c.body(new Uint8Array(bytes))
            }
        }
    }
    const { row, bytes } = await readAsset(id)
    c.header('Content-Type', row.mime)
    c.header('Cache-Control', 'public, max-age=31536000, immutable')
    return c.body(new Uint8Array(bytes))
})
app.route('/api/auth', auth)
app.route('/api/me', me)
app.route('/api/characters', characters)
app.route('/api/chats', chats)
app.route('/api/personas', personas)
app.route('/api/admin', admin)
app.route('/v1', gateway)

app.onError((error, c) => {
    if (error instanceof HttpError) return fail(c, error)
    console.error('[kai] request failed', error)
    return fail(c, HttpError.internal(env.isProduction ? 'Internal server error' : error.message))
})

app.use('/*', serveStatic({ root: env.clientDir }))
app.get('*', async (c) => {
    try {
        c.header('Cache-Control', 'no-cache, no-store, must-revalidate')
        c.header('Pragma', 'no-cache')
        c.header('Expires', '0')
        return c.html(await readFile(resolve(env.clientDir, 'index.html'), 'utf8') as string)
    }
    catch { return c.text('RisuAI-KAI client is not built. Run pnpm build.', 503) }
})

const server = serve({ fetch: app.fetch, hostname: env.host, port: env.port }, (info) => {
    console.log(`[kai] listening on http://${info.address}:${info.port}`)
    void backfillMissingGenreTags().catch((error) => {
        console.error('[kai] genre tag backfill failed', error)
    })
})

for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)))

async function bootstrapAdmin() {
    if (!env.adminEmail || !env.adminPassword || db.select().from(schema.users).get()) return
    if (env.adminPassword.length < 8) throw new Error('KAI_ADMIN_PASSWORD must be at least 8 characters')
    const t=Math.floor(Date.now()/1000), id=newId('usr_')
    db.insert(schema.users).values({ id,email:env.adminEmail,emailNormalized:env.adminEmail.toLowerCase(),passwordHash:await hashPassword(env.adminPassword),displayName:'관리자',role:'admin',status:'active',gatewayToken:newToken(32),locale:'ko',createdAt:t,lastSeenAt:t }).run()
    db.insert(schema.personas).values({id:newId('ps_'),userId:id,name:'나',prompt:'',isDefault:true,createdAt:t}).run()
    console.log(`[kai] bootstrap admin created: ${env.adminEmail}`)
}

export default app
