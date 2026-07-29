ALTER TABLE `git_stacks` ADD `compose_paths` text;--> statement-breakpoint
ALTER TABLE `git_stacks` DROP COLUMN `auto_update`;--> statement-breakpoint
ALTER TABLE `git_stacks` DROP COLUMN `auto_update_schedule`;--> statement-breakpoint
ALTER TABLE `git_stacks` DROP COLUMN `auto_update_cron`;--> statement-breakpoint
ALTER TABLE `stack_sources` ADD `compose_paths` text;