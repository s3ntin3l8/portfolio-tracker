ALTER TABLE "users" ADD COLUMN "onboarding_completed_at" timestamp with time zone;--> statement-breakpoint
-- Backfill: every user that already exists predates this flow entirely — mark them
-- already onboarded so the new post-login redirect gate doesn't retroactively send
-- established users (with real portfolios) through onboarding. New signups after this
-- migration still insert with this column unset (NULL), which is what the gate checks.
UPDATE "users" SET "onboarding_completed_at" = now() WHERE "onboarding_completed_at" IS NULL;
