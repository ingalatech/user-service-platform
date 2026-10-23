-- Existing pre-lease rows are not active leases; epoch zero makes them
-- immediately recoverable while preserving completed_at as the durable state.
ALTER TABLE `admin_bootstrap_guard` ADD `expires_at` integer NOT NULL DEFAULT 0;
