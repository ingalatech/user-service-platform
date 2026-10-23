CREATE TABLE `admin_bootstrap_guard` (
	`id` integer PRIMARY KEY NOT NULL,
	`owner_nonce` text NOT NULL,
	`completed_at` integer
);
