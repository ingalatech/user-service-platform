CREATE TABLE `user_photo` (
	`photo_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_length` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_photo_object_key_unique` ON `user_photo` (`object_key`);--> statement-breakpoint
CREATE TABLE `user_photo_cleanup` (
	`cleanup_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`object_key` text NOT NULL,
	`photo_id` text,
	`source_photo_id` text,
	`replacement_photo_id` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_photo_lock` (
	`user_id` text PRIMARY KEY NOT NULL,
	`lock_token` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
