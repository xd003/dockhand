ALTER TABLE "git_stacks" ADD COLUMN "compose_paths" text;--> statement-breakpoint
ALTER TABLE "stack_sources" ADD COLUMN "compose_paths" text;--> statement-breakpoint
ALTER TABLE "git_stacks" DROP COLUMN "auto_update";--> statement-breakpoint
ALTER TABLE "git_stacks" DROP COLUMN "auto_update_schedule";--> statement-breakpoint
ALTER TABLE "git_stacks" DROP COLUMN "auto_update_cron";