ALTER TABLE "instruments" ADD COLUMN "country_weights" jsonb;--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "country_checked_at" timestamp with time zone;