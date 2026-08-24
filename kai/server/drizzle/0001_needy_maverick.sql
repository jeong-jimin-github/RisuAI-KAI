CREATE TABLE `engine_modules` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`namespace` text DEFAULT '' NOT NULL,
	`module` text NOT NULL,
	`regex_count` integer DEFAULT 0 NOT NULL,
	`trigger_count` integer DEFAULT 0 NOT NULL,
	`lore_count` integer DEFAULT 0 NOT NULL,
	`low_level_access` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `engine_modules_module_id_uq` ON `engine_modules` (`module_id`);