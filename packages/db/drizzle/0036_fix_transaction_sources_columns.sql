ALTER TABLE "transaction_sources" ADD COLUMN IF NOT EXISTS "tax" numeric;--> statement-breakpoint
ALTER TABLE "transaction_sources" ADD COLUMN IF NOT EXISTS "fees" numeric;--> statement-breakpoint
ALTER TABLE "transaction_sources" ADD COLUMN IF NOT EXISTS "executed_price" numeric;--> statement-breakpoint
ALTER TABLE "transaction_sources" ADD COLUMN IF NOT EXISTS "fx_rate" numeric;--> statement-breakpoint
ALTER TABLE "transaction_sources" ADD COLUMN IF NOT EXISTS "venue" text;
