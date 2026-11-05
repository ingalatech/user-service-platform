CREATE TABLE `reader_deletion_request` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`state` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`previous_access_state` text NOT NULL,
	`request_note` text,
	`decision_note` text,
	`cancellation_note` text,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "reader_deletion_request_state_check" CHECK("reader_deletion_request"."state" IN ('pending_review', 'approved', 'rejected', 'cancelled')),
	CONSTRAINT "reader_deletion_request_snapshot_check" CHECK("reader_deletion_request"."previous_access_state" IN ('active', 'disabled')),
	CONSTRAINT "reader_deletion_request_decision_note_check" CHECK("reader_deletion_request"."state" NOT IN ('approved', 'rejected') OR "reader_deletion_request"."decision_note" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reader_deletion_request_active_user_idx` ON `reader_deletion_request` (`user_id`) WHERE "reader_deletion_request"."state" IN ('pending_review', 'approved');--> statement-breakpoint
CREATE INDEX `reader_deletion_request_user_created_idx` ON `reader_deletion_request` (`user_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER `reader_deletion_snapshot_immutable`
BEFORE UPDATE OF `previous_access_state` ON `reader_deletion_request`
WHEN NEW.`previous_access_state` <> OLD.`previous_access_state`
BEGIN
  SELECT RAISE(ABORT, 'Reader deletion access snapshot is immutable');
END;
