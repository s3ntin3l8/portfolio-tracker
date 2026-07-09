ALTER TABLE "transaction_sources" ADD COLUMN "per_share" numeric;--> statement-breakpoint
ALTER TABLE "transaction_sources" ADD COLUMN "shares" numeric;--> statement-breakpoint
ALTER TABLE "transaction_sources" ADD COLUMN "native_currency" text;--> statement-breakpoint
ALTER TABLE "transaction_sources" ADD COLUMN "gross_native" numeric;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "per_share" numeric;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "shares" numeric;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "native_currency" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "gross_native" numeric;