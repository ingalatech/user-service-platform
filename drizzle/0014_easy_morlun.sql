CREATE TABLE `admin_idempotency_record` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`key` text NOT NULL,
	`method` text NOT NULL,
	`normalized_path` text NOT NULL,
	`target_id` text NOT NULL,
	`body_hash` text NOT NULL,
	`response_status` integer NOT NULL,
	`response_body` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_idempotency_scope_key_idx` ON `admin_idempotency_record` (`actor_id`,`method`,`normalized_path`,`target_id`,`key`);--> statement-breakpoint
CREATE INDEX `admin_idempotency_expiry_idx` ON `admin_idempotency_record` (`expires_at`);--> statement-breakpoint
CREATE TABLE `administrator_access_state` (
	`user_id` text PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `admin_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `identity_event` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`type` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`actor_realm` text NOT NULL,
	`actor_id` text NOT NULL,
	`subject_realm` text NOT NULL,
	`subject_id` text NOT NULL,
	`result` text NOT NULL,
	`request_id` text NOT NULL,
	`problem_code` text,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX `identity_event_subject_time_idx` ON `identity_event` (`subject_realm`,`subject_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `identity_event_actor_time_idx` ON `identity_event` (`actor_realm`,`actor_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE TABLE `identity_reservation` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`realm` text NOT NULL,
	`normalized_value` text NOT NULL,
	`subject_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identity_reservation_scope_value_idx` ON `identity_reservation` (`kind`,`realm`,`normalized_value`);--> statement-breakpoint
CREATE INDEX `identity_reservation_expiry_idx` ON `identity_reservation` (`expires_at`);--> statement-breakpoint
CREATE TABLE `reader_access_state` (
	`user_id` text PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
