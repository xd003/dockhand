ALTER TABLE "git_stacks" ADD COLUMN "compose_paths" text;--> statement-breakpoint
ALTER TABLE "stack_sources" ADD COLUMN "compose_paths" text;--> statement-breakpoint
-- Promote per-stack scheduled sync settings to the repository. Only fill in
-- repositories that do not already have auto_update enabled, so existing
-- repo-level config is preserved. The stack-level auto_update columns are
-- deliberately kept (additive migration) so earlier releases can still read
-- them on downgrade.
--
-- When several stacks in the same repository have different schedules, the
-- schedule that runs most often wins (sub-hourly > hourly > daily > weekly):
-- the frequency rank below is derived from the cron expression and the
-- stack-level schedule type, and the stack id is only a deterministic
-- tie-breaker. Both subqueries use the same ORDER BY so they pick the same
-- winning stack.
UPDATE "git_repositories"
SET
	"auto_update" = true,
	"auto_update_schedule" = (
		SELECT "auto_update_schedule" FROM "git_stacks"
		WHERE "git_stacks"."repository_id" = "git_repositories"."id"
			AND "git_stacks"."auto_update" = true
		ORDER BY
			CASE
				WHEN "git_stacks"."auto_update_cron" ~ '^\*/' THEN 6
				WHEN "git_stacks"."auto_update_cron" ~ '^\S+\s+\*' THEN 5
				WHEN "git_stacks"."auto_update_cron" ~ '^\S+\s+\*/' THEN 5
				WHEN "git_stacks"."auto_update_schedule" = 'daily' THEN 3
				WHEN "git_stacks"."auto_update_cron" ~ '\*$' THEN 2
				ELSE 1
			END DESC,
			"git_stacks"."id" ASC
		LIMIT 1
	),
	"auto_update_cron" = (
		SELECT "auto_update_cron" FROM "git_stacks"
		WHERE "git_stacks"."repository_id" = "git_repositories"."id"
			AND "git_stacks"."auto_update" = true
		ORDER BY
			CASE
				WHEN "git_stacks"."auto_update_cron" ~ '^\*/' THEN 6
				WHEN "git_stacks"."auto_update_cron" ~ '^\S+\s+\*' THEN 5
				WHEN "git_stacks"."auto_update_cron" ~ '^\S+\s+\*/' THEN 5
				WHEN "git_stacks"."auto_update_schedule" = 'daily' THEN 3
				WHEN "git_stacks"."auto_update_cron" ~ '\*$' THEN 2
				ELSE 1
			END DESC,
			"git_stacks"."id" ASC
		LIMIT 1
	)
WHERE "id" IN (
	SELECT DISTINCT "repository_id" FROM "git_stacks" WHERE "auto_update" = true
)
AND COALESCE("auto_update", false) = false;--> statement-breakpoint
-- Keep existing webhook-enabled stacks deploying: the webhook receiver now
-- requires force_redeploy, which defaults to false for pre-existing stacks,
-- so backfill it where a webhook is already configured.
UPDATE "git_stacks" SET "force_redeploy" = true WHERE "webhook_enabled" = true;--> statement-breakpoint
-- Promote stack-level webhook configuration to the repository so the
-- repository webhook works out of the box and existing webhook-enabled
-- stacks keep deploying. Only fill in repositories that do not already have
-- a webhook enabled, so existing repo-level config is preserved. When
-- several stacks in the same repository have webhooks, the lowest stack id
-- wins deterministically; the other stacks' secrets stay valid through the
-- deprecated stack-level webhook endpoint, so external systems do not need
-- re-pointing.
UPDATE "git_repositories"
SET
	"webhook_enabled" = true,
	"webhook_secret" = (
		SELECT "webhook_secret" FROM "git_stacks"
		WHERE "git_stacks"."repository_id" = "git_repositories"."id"
			AND "git_stacks"."webhook_enabled" = true
			AND "git_stacks"."webhook_secret" IS NOT NULL
		ORDER BY "git_stacks"."id" ASC
		LIMIT 1
	)
WHERE "id" IN (
	SELECT DISTINCT "repository_id" FROM "git_stacks"
	WHERE "webhook_enabled" = true AND "webhook_secret" IS NOT NULL
)
AND COALESCE("webhook_enabled", false) = false;
