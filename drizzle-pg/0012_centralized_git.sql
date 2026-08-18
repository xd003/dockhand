CREATE TABLE "git_mode_transition" (
	"id" serial PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'stack',
	"state" text DEFAULT 'idle',
	"job_id" text,
	"started_at" timestamp,
	"finished_at" timestamp,
	"snapshot" text,
	"error" text,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "hawser_stacks_dir" text;--> statement-breakpoint
ALTER TABLE "git_stacks" ADD COLUMN "compose_paths" text;--> statement-breakpoint
ALTER TABLE "stack_sources" ADD COLUMN "compose_paths" text;--> statement-breakpoint
ALTER TABLE "git_stacks" ADD COLUMN "git_model" text DEFAULT 'stack' NOT NULL;--> statement-breakpoint
CREATE TABLE "git_stack_migration" (
	"id" serial PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'idle' NOT NULL,
	"job_id" text,
	"stack_ids" text,
	"snapshot" text,
	"error" text,
	"started_at" timestamp,
	"finished_at" timestamp,
	"updated_at" timestamp DEFAULT now()
);