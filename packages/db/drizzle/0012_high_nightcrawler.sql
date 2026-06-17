ALTER TABLE "transactions" ADD COLUMN "tax" numeric;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "executed_price" numeric;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "fx_rate" numeric;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "venue" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "document_refs" jsonb;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "description" text;