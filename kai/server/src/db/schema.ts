/**
 * RisuAI-KAI persistence schema (SQLite / Drizzle).
 *
 * Design notes:
 *  - Character cards are stored as the *verbatim* RisuAI `character` JSON in
 *    `characters.cardJson`. Columns beside it are denormalised projections used
 *    for listing and search only. Never treat them as the source of truth.
 *  - Chat engine state (RisuAI scriptstate / memory blobs / chat variables) is
 *    an opaque JSON blob. The server never interprets it; round-tripping it
 *    verbatim is what keeps triggers and memory plugins working.
 *  - Provider API keys are stored encrypted (AES-256-GCM) and are never sent to
 *    any client, including the admin UI.
 */

import { sql } from 'drizzle-orm'
import {
    index,
    integer,
    primaryKey,
    real,
    sqliteTable,
    text,
    uniqueIndex,
} from 'drizzle-orm/sqlite-core'

const now = sql`(strftime('%s','now'))`

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

export const users = sqliteTable(
    'users',
    {
        id: text('id').primaryKey(),
        email: text('email').notNull(),
        emailNormalized: text('email_normalized').notNull(),
        passwordHash: text('password_hash').notNull(),
        displayName: text('display_name').notNull(),
        avatarAssetId: text('avatar_asset_id'),
        role: text('role', { enum: ['user', 'admin'] }).notNull().default('user'),
        status: text('status', { enum: ['active', 'suspended', 'pending'] })
            .notNull()
            .default('active'),
        /** Bearer token the RisuAI engine sends as `proxyKey`. Rotatable. */
        gatewayToken: text('gateway_token').notNull(),
        locale: text('locale').notNull().default('ko'),
        createdAt: integer('created_at').notNull().default(now),
        lastSeenAt: integer('last_seen_at'),
    },
    (t) => [
        uniqueIndex('users_email_norm_uq').on(t.emailNormalized),
        uniqueIndex('users_gateway_token_uq').on(t.gatewayToken),
    ],
)

export const sessions = sqliteTable(
    'sessions',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        expiresAt: integer('expires_at').notNull(),
        createdAt: integer('created_at').notNull().default(now),
        userAgent: text('user_agent'),
        ip: text('ip'),
    },
    (t) => [index('sessions_user_idx').on(t.userId), index('sessions_exp_idx').on(t.expiresAt)],
)

export const inviteCodes = sqliteTable(
    'invite_codes',
    {
        code: text('code').primaryKey(),
        createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
        maxUses: integer('max_uses').notNull().default(1),
        useCount: integer('use_count').notNull().default(0),
        expiresAt: integer('expires_at'),
        createdAt: integer('created_at').notNull().default(now),
    },
)

/* ------------------------------------------------------------------ *
 * Assets — avatars, card images, emotion packs, inlays
 * ------------------------------------------------------------------ */

export const assets = sqliteTable(
    'assets',
    {
        id: text('id').primaryKey(),
        /** Path relative to DATA_DIR/assets. */
        path: text('path').notNull(),
        mime: text('mime').notNull(),
        size: integer('size').notNull(),
        sha256: text('sha256').notNull(),
        kind: text('kind', {
            enum: ['avatar', 'card_image', 'emotion', 'additional', 'inlay', 'site'],
        }).notNull(),
        ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
        createdAt: integer('created_at').notNull().default(now),
    },
    (t) => [index('assets_sha_idx').on(t.sha256)],
)

/* ------------------------------------------------------------------ *
 * Characters
 * ------------------------------------------------------------------ */

export const characters = sqliteTable(
    'characters',
    {
        id: text('id').primaryKey(),
        slug: text('slug').notNull(),
        name: text('name').notNull(),
        tagline: text('tagline').notNull().default(''),
        creatorName: text('creator_name').notNull().default(''),
        creatorNotes: text('creator_notes').notNull().default(''),
        /** Verbatim RisuAI `character` object. Source of truth. */
        cardJson: text('card_json', { mode: 'json' }).notNull(),
        sourceFormat: text('source_format').notNull().default('kai_native'),
        avatarAssetId: text('avatar_asset_id').references(() => assets.id, { onDelete: 'set null' }),
        tags: text('tags', { mode: 'json' }).notNull().default(sql`'[]'`),
        nsfw: integer('nsfw', { mode: 'boolean' }).notNull().default(false),
        visibility: text('visibility', { enum: ['public', 'private'] })
            .notNull()
            .default('public'),
        featured: integer('featured', { mode: 'boolean' }).notNull().default(false),
        sortOrder: integer('sort_order').notNull().default(0),
        greetingCount: integer('greeting_count').notNull().default(1),
        chatCount: integer('chat_count').notNull().default(0),
        messageCount: integer('message_count').notNull().default(0),
        likeCount: integer('like_count').notNull().default(0),
        createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
        createdAt: integer('created_at').notNull().default(now),
        updatedAt: integer('updated_at').notNull().default(now),
    },
    (t) => [
        uniqueIndex('characters_slug_uq').on(t.slug),
        index('characters_visibility_idx').on(t.visibility),
        index('characters_featured_idx').on(t.featured, t.sortOrder),
    ],
)

/** Assets belonging to a card (emotion packs, additional assets, background). */
export const characterAssets = sqliteTable(
    'character_assets',
    {
        characterId: text('character_id')
            .notNull()
            .references(() => characters.id, { onDelete: 'cascade' }),
        assetId: text('asset_id')
            .notNull()
            .references(() => assets.id, { onDelete: 'cascade' }),
        /** The key the card uses to reference it (e.g. emotion name or asset uri). */
        refKey: text('ref_key').notNull(),
    },
    (t) => [primaryKey({ columns: [t.characterId, t.refKey] })],
)

export const characterLikes = sqliteTable(
    'character_likes',
    {
        characterId: text('character_id')
            .notNull()
            .references(() => characters.id, { onDelete: 'cascade' }),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        createdAt: integer('created_at').notNull().default(now),
    },
    (t) => [primaryKey({ columns: [t.characterId, t.userId] })],
)

/* ------------------------------------------------------------------ *
 * Personas, chats, messages
 * ------------------------------------------------------------------ */

export const personas = sqliteTable(
    'personas',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        name: text('name').notNull(),
        prompt: text('prompt').notNull().default(''),
        avatarAssetId: text('avatar_asset_id').references(() => assets.id, { onDelete: 'set null' }),
        isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
        createdAt: integer('created_at').notNull().default(now),
    },
    (t) => [index('personas_user_idx').on(t.userId)],
)

export const chats = sqliteTable(
    'chats',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        characterId: text('character_id')
            .notNull()
            .references(() => characters.id, { onDelete: 'cascade' }),
        personaId: text('persona_id').references(() => personas.id, { onDelete: 'set null' }),
        title: text('title').notNull().default(''),
        /** Opaque RisuAI chat state. Never interpreted server-side. */
        engineState: text('engine_state', { mode: 'json' }).notNull().default(sql`'{}'`),
        messageCount: integer('message_count').notNull().default(0),
        pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
        archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
        createdAt: integer('created_at').notNull().default(now),
        updatedAt: integer('updated_at').notNull().default(now),
    },
    (t) => [
        index('chats_user_updated_idx').on(t.userId, t.updatedAt),
        index('chats_character_idx').on(t.characterId),
    ],
)

export const messages = sqliteTable(
    'messages',
    {
        id: text('id').primaryKey(),
        chatId: text('chat_id')
            .notNull()
            .references(() => chats.id, { onDelete: 'cascade' }),
        idx: integer('idx').notNull(),
        role: text('role', { enum: ['user', 'char'] }).notNull(),
        content: text('content').notNull(),
        name: text('name'),
        /** Alternate generations for the same slot (RisuAI swipes). JSON array. */
        swipes: text('swipes', { mode: 'json' }),
        swipeIndex: integer('swipe_index').notNull().default(0),
        model: text('model'),
        tokensIn: integer('tokens_in'),
        tokensOut: integer('tokens_out'),
        disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
        time: integer('time').notNull().default(now),
    },
    (t) => [uniqueIndex('messages_chat_idx_uq').on(t.chatId, t.idx)],
)

/* ------------------------------------------------------------------ *
 * LLM routing
 * ------------------------------------------------------------------ */

export const providers = sqliteTable(
    'providers',
    {
        id: text('id').primaryKey(),
        key: text('key').notNull(),
        kind: text('kind').notNull(),
        label: text('label').notNull(),
        baseUrl: text('base_url').notNull(),
        auth: text('auth', { enum: ['none', 'bearer', 'header', 'query'] })
            .notNull()
            .default('none'),
        /** AES-256-GCM ciphertext. Never leaves the server. */
        apiKeyEnc: text('api_key_enc'),
        authHeaderName: text('auth_header_name'),
        enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
        priority: integer('priority').notNull().default(100),
        rpm: integer('rpm'),
        rpd: integer('rpd'),
        concurrency: integer('concurrency').notNull().default(4),
        timeoutMs: integer('timeout_ms').notNull().default(120_000),
        notes: text('notes').notNull().default(''),
        createdAt: integer('created_at').notNull().default(now),
    },
    (t) => [uniqueIndex('providers_key_uq').on(t.key)],
)

export const routedModels = sqliteTable(
    'routed_models',
    {
        id: text('id').primaryKey(),
        providerKey: text('provider_key').notNull(),
        upstreamModel: text('upstream_model').notNull(),
        displayName: text('display_name').notNull(),
        enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
        tier: text('tier', { enum: ['fast', 'balanced', 'smart'] }).notNull().default('balanced'),
        priority: integer('priority').notNull().default(100),
        contextLength: integer('context_length').notNull().default(8192),
        maxOutput: integer('max_output').notNull().default(2048),
        supportsStreaming: integer('supports_streaming', { mode: 'boolean' }).notNull().default(true),
        supportsVision: integer('supports_vision', { mode: 'boolean' }).notNull().default(false),
        supportsTools: integer('supports_tools', { mode: 'boolean' }).notNull().default(false),
        /**
         * Languages the model was *observed* to answer well in, as BCP-47
         * primary subtags. Empty means unverified, which is not the same as
         * "cannot": the router ranks verified models first and still falls back
         * to unverified ones rather than refusing to answer.
         *
         * This exists because a model with no training in a script still emits
         * that script — just badly. Size and benchmark tier say nothing about
         * it, so it cannot be inferred from `tier` and has to be measured.
         */
        languages: text('languages', { mode: 'json' }).notNull().default(sql`'[]'`),
        /** Why this model sits where it does. Shown in the admin model table. */
        notes: text('notes').notNull().default(''),
        createdAt: integer('created_at').notNull().default(now),
    },
    (t) => [uniqueIndex('routed_models_uq').on(t.providerKey, t.upstreamModel)],
)

/** Live health, updated on every routing attempt. */
export const modelHealth = sqliteTable('model_health', {
    modelId: text('model_id')
        .primaryKey()
        .references(() => routedModels.id, { onDelete: 'cascade' }),
    state: text('state', { enum: ['healthy', 'degraded', 'cooling', 'unknown', 'disabled'] })
        .notNull()
        .default('unknown'),
    successCount: integer('success_count').notNull().default(0),
    errorCount: integer('error_count').notNull().default(0),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    p50LatencyMs: real('p50_latency_ms'),
    /** Ring buffer of recent latencies, JSON array of numbers. */
    latencySamples: text('latency_samples', { mode: 'json' }).notNull().default(sql`'[]'`),
    lastError: text('last_error'),
    lastCheckedAt: integer('last_checked_at'),
    cooldownUntil: integer('cooldown_until'),
})

/** Rolling per-model counters, reset at UTC midnight by the quota keeper. */
export const modelQuota = sqliteTable(
    'model_quota',
    {
        modelId: text('model_id').notNull(),
        /** UTC day, `YYYY-MM-DD`. */
        day: text('day').notNull(),
        requests: integer('requests').notNull().default(0),
        tokensIn: integer('tokens_in').notNull().default(0),
        tokensOut: integer('tokens_out').notNull().default(0),
        /** Sliding-minute counter for RPM enforcement. */
        minuteBucket: integer('minute_bucket').notNull().default(0),
        minuteCount: integer('minute_count').notNull().default(0),
    },
    (t) => [primaryKey({ columns: [t.modelId, t.day] })],
)

export const routingAliases = sqliteTable('routing_aliases', {
    alias: text('alias').primaryKey(),
    label: text('label').notNull(),
    description: text('description').notNull().default(''),
    /** Ordered tier preference, JSON array of ModelTier. */
    tiers: text('tiers', { mode: 'json' }).notNull().default(sql`'["smart","balanced","fast"]'`),
    /** Optional hard allow-list of routed model ids, JSON array. */
    modelIds: text('model_ids', { mode: 'json' }).notNull().default(sql`'[]'`),
    sortOrder: integer('sort_order').notNull().default(0),
})

export const usageLog = sqliteTable(
    'usage_log',
    {
        id: text('id').primaryKey(),
        userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
        chatId: text('chat_id'),
        providerKey: text('provider_key').notNull(),
        upstreamModel: text('upstream_model').notNull(),
        alias: text('alias').notNull().default(''),
        tokensIn: integer('tokens_in').notNull().default(0),
        tokensOut: integer('tokens_out').notNull().default(0),
        latencyMs: integer('latency_ms').notNull().default(0),
        attempts: integer('attempts').notNull().default(1),
        status: text('status').notNull(),
        errorClass: text('error_class'),
        createdAt: integer('created_at').notNull().default(now),
    },
    (t) => [index('usage_created_idx').on(t.createdAt), index('usage_user_idx').on(t.userId)],
)

/* ------------------------------------------------------------------ *
 * Site config, plugins, presets, audit
 * ------------------------------------------------------------------ */

export const settings = sqliteTable('settings', {
    key: text('key').primaryKey(),
    value: text('value', { mode: 'json' }).notNull(),
    updatedAt: integer('updated_at').notNull().default(now),
})

export const plugins = sqliteTable(
    'plugins',
    {
        id: text('id').primaryKey(),
        /** RisuAI `//@name` — the stable identity. */
        name: text('name').notNull(),
        displayName: text('display_name').notNull(),
        apiVersion: text('api_version').notNull().default('3.0'),
        version: text('version').notNull().default(''),
        source: text('source').notNull(),
        /** Parsed `//@arg` declarations, JSON. */
        argSchema: text('arg_schema', { mode: 'json' }).notNull().default(sql`'[]'`),
        /** Admin-set argument values, JSON. */
        argValues: text('arg_values', { mode: 'json' }).notNull().default(sql`'{}'`),
        enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
        /** Forced plugins load for every user and cannot be turned off client-side. */
        forced: integer('forced', { mode: 'boolean' }).notNull().default(true),
        sortOrder: integer('sort_order').notNull().default(0),
        updateUrl: text('update_url'),
        createdAt: integer('created_at').notNull().default(now),
    },
    (t) => [uniqueIndex('plugins_name_uq').on(t.name)],
)

/**
 * RisuAI modules (`.risum`) the admin installs instance-wide.
 *
 * A module carries regex/display scripts, triggers and a lorebook, and many
 * shared presets require a matching one to render at all. Enabled modules ride
 * to the client in RuntimeConfig and land in `db.modules` + `db.enabledModules`,
 * which is exactly where the engine looks for them.
 */
export const engineModules = sqliteTable(
    'engine_modules',
    {
        id: text('id').primaryKey(),
        /** The module's own uuid, which lorebooks and toggles reference. */
        moduleId: text('module_id').notNull(),
        name: text('name').notNull(),
        description: text('description').notNull().default(''),
        namespace: text('namespace').notNull().default(''),
        /** The decoded module, stored whole so the engine sees it unchanged. */
        module: text('module', { mode: 'json' }).notNull(),
        /** Counts, for the admin list; the module blob is large. */
        regexCount: integer('regex_count').notNull().default(0),
        triggerCount: integer('trigger_count').notNull().default(0),
        loreCount: integer('lore_count').notNull().default(0),
        /** Module asked for low-level engine access. Admin decides; see services/modules.ts. */
        lowLevelAccess: integer('low_level_access', { mode: 'boolean' }).notNull().default(false),
        enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
        sortOrder: integer('sort_order').notNull().default(0),
        createdAt: integer('created_at').notNull().default(now),
        updatedAt: integer('updated_at').notNull().default(now),
    },
    (t) => [uniqueIndex('engine_modules_module_id_uq').on(t.moduleId)],
)

/** RisuAI `botPreset` blobs the admin curates; exactly one is default. */
export const promptPresets = sqliteTable('prompt_presets', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    preset: text('preset', { mode: 'json' }).notNull(),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
})

export const auditLog = sqliteTable(
    'audit_log',
    {
        id: text('id').primaryKey(),
        actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
        action: text('action').notNull(),
        target: text('target'),
        detail: text('detail', { mode: 'json' }).notNull().default(sql`'{}'`),
        ip: text('ip'),
        createdAt: integer('created_at').notNull().default(now),
    },
    (t) => [index('audit_created_idx').on(t.createdAt)],
)

export type DbUser = typeof users.$inferSelect
export type DbCharacter = typeof characters.$inferSelect
export type DbChat = typeof chats.$inferSelect
export type DbMessage = typeof messages.$inferSelect
export type DbProvider = typeof providers.$inferSelect
export type DbRoutedModel = typeof routedModels.$inferSelect
export type DbModelHealth = typeof modelHealth.$inferSelect
export type DbPlugin = typeof plugins.$inferSelect
export type DbEngineModule = typeof engineModules.$inferSelect
export type DbPromptPreset = typeof promptPresets.$inferSelect
