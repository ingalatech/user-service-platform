CREATE TABLE `administrator_message_workflow` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`cooldown_until` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_scheduled_at` integer,
	`claim_token` text,
	`claimed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `admin_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `administrator_message_workflow_user_kind_idx` ON `administrator_message_workflow` (`user_id`,`kind`);--> statement-breakpoint
CREATE INDEX `administrator_message_workflow_cooldown_idx` ON `administrator_message_workflow` (`cooldown_until`);