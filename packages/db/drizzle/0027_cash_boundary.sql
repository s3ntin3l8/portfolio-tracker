-- Replace the per-portfolio contribution_mode ("auto"/"purchases") with cash_counted,
-- the investment-boundary flag (see CLAUDE.md "one boundary per portfolio").
-- Preserve behaviour on migrate: auto -> cash inside (cash counts), purchases -> cash outside.
ALTER TABLE "portfolios" ADD COLUMN "cash_counted" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "portfolios" SET "cash_counted" = ("contribution_mode" = 'auto');
--> statement-breakpoint
ALTER TABLE "portfolios" DROP COLUMN "contribution_mode";
