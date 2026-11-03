ALTER TABLE `reader_access_state` ADD `mutation_token` text;--> statement-breakpoint
ALTER TABLE `reader_message_workflow` ADD `claim_token` text;--> statement-breakpoint
ALTER TABLE `reader_message_workflow` ADD `claimed_at` integer;