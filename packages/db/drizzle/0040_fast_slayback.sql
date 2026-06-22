ALTER TABLE "account_holders" ADD COLUMN "tax_allowance_annual" numeric;--> statement-breakpoint
ALTER TABLE "account_holders" ADD COLUMN "capital_gains_tax_rate" numeric;--> statement-breakpoint
ALTER TABLE "account_holders" ADD COLUMN "church_tax" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "account_holders" ADD COLUMN "tax_residence" text;--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "partial_exemption_rate" numeric;