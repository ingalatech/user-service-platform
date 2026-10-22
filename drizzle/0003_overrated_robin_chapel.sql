CREATE TABLE `email_verification_token` (
	`target_email` text PRIMARY KEY NOT NULL,
	`token_digest` text NOT NULL,
	`expires_at` integer NOT NULL,
	`issued_at` integer NOT NULL,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_verification_token_token_digest_unique` ON `email_verification_token` (`token_digest`);