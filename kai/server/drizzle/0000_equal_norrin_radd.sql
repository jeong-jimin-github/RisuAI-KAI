CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`kind` text NOT NULL,
	`owner_user_id` text,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `assets_sha_idx` ON `assets` (`sha256`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`target` text,
	`detail` text DEFAULT '{}' NOT NULL,
	`ip` text,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_created_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `character_assets` (
	`character_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`ref_key` text NOT NULL,
	PRIMARY KEY(`character_id`, `ref_key`),
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `character_likes` (
	`character_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	PRIMARY KEY(`character_id`, `user_id`),
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `characters` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`tagline` text DEFAULT '' NOT NULL,
	`creator_name` text DEFAULT '' NOT NULL,
	`creator_notes` text DEFAULT '' NOT NULL,
	`card_json` text NOT NULL,
	`source_format` text DEFAULT 'kai_native' NOT NULL,
	`avatar_asset_id` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`nsfw` integer DEFAULT false NOT NULL,
	`visibility` text DEFAULT 'draft' NOT NULL,
	`featured` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`greeting_count` integer DEFAULT 1 NOT NULL,
	`chat_count` integer DEFAULT 0 NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`like_count` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	FOREIGN KEY (`avatar_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `characters_slug_uq` ON `characters` (`slug`);--> statement-breakpoint
CREATE INDEX `characters_visibility_idx` ON `characters` (`visibility`);--> statement-breakpoint
CREATE INDEX `characters_featured_idx` ON `characters` (`featured`,`sort_order`);--> statement-breakpoint
CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`character_id` text NOT NULL,
	`persona_id` text,
	`title` text DEFAULT '' NOT NULL,
	`engine_state` text DEFAULT '{}' NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `chats_user_updated_idx` ON `chats` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `chats_character_idx` ON `chats` (`character_id`);--> statement-breakpoint
CREATE TABLE `invite_codes` (
	`code` text PRIMARY KEY NOT NULL,
	`created_by` text,
	`max_uses` integer DEFAULT 1 NOT NULL,
	`use_count` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`idx` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`name` text,
	`swipes` text,
	`swipe_index` integer DEFAULT 0 NOT NULL,
	`model` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`disabled` integer DEFAULT false NOT NULL,
	`time` integer DEFAULT (strftime('%s','now')) NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_chat_idx_uq` ON `messages` (`chat_id`,`idx`);--> statement-breakpoint
CREATE TABLE `model_health` (
	`model_id` text PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'unknown' NOT NULL,
	`success_count` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`p50_latency_ms` real,
	`latency_samples` text DEFAULT '[]' NOT NULL,
	`last_error` text,
	`last_checked_at` integer,
	`cooldown_until` integer,
	FOREIGN KEY (`model_id`) REFERENCES `routed_models`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `model_quota` (
	`model_id` text NOT NULL,
	`day` text NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`minute_bucket` integer DEFAULT 0 NOT NULL,
	`minute_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`model_id`, `day`)
);
--> statement-breakpoint
CREATE TABLE `personas` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`avatar_asset_id` text,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`avatar_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `personas_user_idx` ON `personas` (`user_id`);--> statement-breakpoint
CREATE TABLE `plugins` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`display_name` text NOT NULL,
	`api_version` text DEFAULT '3.0' NOT NULL,
	`version` text DEFAULT '' NOT NULL,
	`source` text NOT NULL,
	`arg_schema` text DEFAULT '[]' NOT NULL,
	`arg_values` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`forced` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`update_url` text,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugins_name_uq` ON `plugins` (`name`);--> statement-breakpoint
CREATE TABLE `prompt_presets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`preset` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`base_url` text NOT NULL,
	`auth` text DEFAULT 'none' NOT NULL,
	`api_key_enc` text,
	`auth_header_name` text,
	`enabled` integer DEFAULT true NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`rpm` integer,
	`rpd` integer,
	`concurrency` integer DEFAULT 4 NOT NULL,
	`timeout_ms` integer DEFAULT 120000 NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `providers_key_uq` ON `providers` (`key`);--> statement-breakpoint
CREATE TABLE `routed_models` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_key` text NOT NULL,
	`upstream_model` text NOT NULL,
	`display_name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`tier` text DEFAULT 'balanced' NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`context_length` integer DEFAULT 8192 NOT NULL,
	`max_output` integer DEFAULT 2048 NOT NULL,
	`supports_streaming` integer DEFAULT true NOT NULL,
	`supports_vision` integer DEFAULT false NOT NULL,
	`supports_tools` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `routed_models_uq` ON `routed_models` (`provider_key`,`upstream_model`);--> statement-breakpoint
CREATE TABLE `routing_aliases` (
	`alias` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`tiers` text DEFAULT '["smart","balanced","fast"]' NOT NULL,
	`model_ids` text DEFAULT '[]' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	`user_agent` text,
	`ip` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_exp_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`chat_id` text,
	`provider_key` text NOT NULL,
	`upstream_model` text NOT NULL,
	`alias` text DEFAULT '' NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`error_class` text,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `usage_created_idx` ON `usage_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `usage_user_idx` ON `usage_log` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`email_normalized` text NOT NULL,
	`password_hash` text NOT NULL,
	`display_name` text NOT NULL,
	`avatar_asset_id` text,
	`role` text DEFAULT 'user' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`gateway_token` text NOT NULL,
	`locale` text DEFAULT 'ko' NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	`last_seen_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_norm_uq` ON `users` (`email_normalized`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_gateway_token_uq` ON `users` (`gateway_token`);