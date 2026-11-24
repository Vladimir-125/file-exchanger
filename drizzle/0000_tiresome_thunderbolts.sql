CREATE TABLE `email_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`sid` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transfer_files` (
	`id` text PRIMARY KEY NOT NULL,
	`transfer_id` text NOT NULL,
	`original_name` text NOT NULL,
	`stored_name` text NOT NULL,
	`size` integer NOT NULL,
	`mime` text NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`transfer_id`) REFERENCES `transfers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text,
	`owner_id` integer,
	`password_hash` text,
	`enc_salt` text,
	`upload_token_hash` text NOT NULL,
	`status` text NOT NULL,
	`total_size` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transfers_key_unique` ON `transfers` (`key`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text NOT NULL,
	`confirmed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);