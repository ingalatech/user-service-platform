DROP INDEX `user_photo_state_created_idx`;--> statement-breakpoint
ALTER TABLE `user_photo` ADD `attempt_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_photo` ADD `next_attempt_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `user_photo_state_next_created_idx` ON `user_photo` (`state`,`next_attempt_at`,`created_at`);--> statement-breakpoint
DROP INDEX `user_photo_cleanup_state_created_idx`;--> statement-breakpoint
ALTER TABLE `user_photo_cleanup` ADD `attempt_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_photo_cleanup` ADD `next_attempt_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `user_photo_cleanup_state_next_created_idx` ON `user_photo_cleanup` (`state`,`next_attempt_at`,`created_at`);