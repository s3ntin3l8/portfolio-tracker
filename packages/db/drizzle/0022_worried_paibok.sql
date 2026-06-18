ALTER TABLE "portfolio_snapshots" ADD COLUMN "market_value" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "portfolio_snapshots" ADD COLUMN "effective_flow" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "portfolios" ADD COLUMN "include_in_aggregate" boolean DEFAULT true NOT NULL;