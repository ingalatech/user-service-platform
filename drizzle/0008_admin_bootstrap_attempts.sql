CREATE TABLE `admin_bootstrap_attempt` (
	`user_id` text PRIMARY KEY NOT NULL,
	`owner_nonce` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL
);
