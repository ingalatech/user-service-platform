PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_identity_event` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`type` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`actor_realm` text NOT NULL,
	`actor_id` text NOT NULL,
	`subject_realm` text,
	`subject_id` text,
	`result` text NOT NULL,
	`request_id` text NOT NULL,
	`problem_code` text,
	`metadata` text
);
--> statement-breakpoint
INSERT INTO `__new_identity_event`("id", "version", "type", "occurred_at", "actor_realm", "actor_id", "subject_realm", "subject_id", "result", "request_id", "problem_code", "metadata") SELECT "id", "version", "type", "occurred_at", "actor_realm", "actor_id", "subject_realm", "subject_id", "result", "request_id", "problem_code", "metadata" FROM `identity_event`;--> statement-breakpoint
DROP TABLE `identity_event`;--> statement-breakpoint
ALTER TABLE `__new_identity_event` RENAME TO `identity_event`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `identity_event_subject_time_idx` ON `identity_event` (`subject_realm`,`subject_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `identity_event_actor_time_idx` ON `identity_event` (`actor_realm`,`actor_id`,`occurred_at`,`id`);