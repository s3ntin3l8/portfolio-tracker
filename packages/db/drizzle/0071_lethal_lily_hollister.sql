ALTER TABLE "instruments" ADD COLUMN "fundamentals" jsonb;--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "fundamentals_checked_at" timestamp with time zone;
