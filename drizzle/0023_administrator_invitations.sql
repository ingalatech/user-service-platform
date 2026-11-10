CREATE TABLE `administrator_invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`normalized_email` text NOT NULL,
	`token_digest` text NOT NULL,
	`state` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`expires_at` integer NOT NULL,
	`cooldown_until` integer NOT NULL,
	`sealed_payload` text,
	`claim_token` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`accepted_at` integer,
	CONSTRAINT "administrator_invitation_state_check" CHECK (`state` IN ('pending', 'accepted', 'cancelled', 'superseded', 'expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `administrator_invitation_token_digest_unique` ON `administrator_invitation` (`token_digest`);--> statement-breakpoint
CREATE UNIQUE INDEX `administrator_invitation_pending_email_idx` ON `administrator_invitation` (`normalized_email`) WHERE "administrator_invitation"."state" = 'pending';--> statement-breakpoint
CREATE INDEX `administrator_invitation_state_created_idx` ON `administrator_invitation` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `administrator_invitation_expiry_idx` ON `administrator_invitation` (`expires_at`);
