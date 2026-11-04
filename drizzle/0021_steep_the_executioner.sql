DELETE FROM `identity_reservation`
WHERE `expires_at` <= CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);--> statement-breakpoint
-- Any remaining cross-realm duplicate is active. Let the unique-index
-- precondition fail without deleting or transferring either reservation.
CREATE UNIQUE INDEX `identity_reservation_global_value_idx` ON `identity_reservation` (`kind`,`normalized_value`);--> statement-breakpoint
DROP INDEX `identity_reservation_scope_value_idx`;--> statement-breakpoint
CREATE TABLE `reader_email_change_workflow` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`old_email` text NOT NULL,
	`new_email` text NOT NULL,
	`normalized_new_email` text NOT NULL,
	`state` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`supersedes_id` text,
	`creator_id` text NOT NULL,
	`creation_key` text NOT NULL,
	`expires_at` integer NOT NULL,
	`cooldown_until` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_scheduled_at` integer,
	`claim_token` text,
	`claimed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reader_email_change_pending_user_idx` ON `reader_email_change_workflow` (`user_id`) WHERE "reader_email_change_workflow"."state" = 'pending';--> statement-breakpoint
CREATE INDEX `reader_email_change_user_created_idx` ON `reader_email_change_workflow` (`user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `reader_email_change_expiry_idx` ON `reader_email_change_workflow` (`expires_at`);--> statement-breakpoint
CREATE TRIGGER `reader_email_reservation_guard`
BEFORE INSERT ON `user`
WHEN (NEW.`role` IS NULL OR NEW.`role` <> 'admin')
  AND EXISTS (
    SELECT 1 FROM `identity_reservation`
    WHERE `kind` = 'email'
      AND `normalized_value` = lower(trim(NEW.`email`))
      AND `expires_at` > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  )
BEGIN
  SELECT RAISE(ABORT, 'Reader email is reserved');
END;
