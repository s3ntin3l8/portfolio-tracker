CREATE TABLE "account_holders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'other' NOT NULL,
	"birth_year" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portfolios" ADD COLUMN "account_holder_id" uuid;--> statement-breakpoint
ALTER TABLE "account_holders" ADD CONSTRAINT "account_holders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_holders_user_id_idx" ON "account_holders" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_account_holder_id_account_holders_id_fk" FOREIGN KEY ("account_holder_id") REFERENCES "public"."account_holders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill: lift each portfolio's (accountHolder, birthYear, portfolioType) into a
-- deduplicated account_holders row, then relink. A holder is created for every
-- portfolio that named a holder, carried a birth year, or was a child depot;
-- portfolios sharing the same (name, birth year, child-ness) collapse to one holder.
-- Child portfolios become type 'child' (the new single source of child-ness); all
-- others 'other'. The holder name falls back to the portfolio name when no explicit
-- account_holder was set (e.g. a child depot with a birth year but no name). Runs
-- before the columns are dropped below.
WITH candidates AS (
	SELECT
		id AS portfolio_id,
		user_id,
		COALESCE(NULLIF(btrim("account_holder"), ''), "name") AS holder_name,
		"birth_year" AS birth_year,
		CASE WHEN "portfolio_type" = 'child' THEN 'child' ELSE 'other' END AS holder_type
	FROM "portfolios"
	WHERE "account_holder" IS NOT NULL OR "birth_year" IS NOT NULL OR "portfolio_type" = 'child'
),
distinct_holders AS (
	SELECT DISTINCT user_id, holder_name, birth_year, holder_type FROM candidates
),
inserted AS (
	INSERT INTO "account_holders" ("user_id", "name", "type", "birth_year")
	SELECT user_id, holder_name, holder_type, birth_year FROM distinct_holders
	RETURNING id, user_id, name, type, birth_year
)
UPDATE "portfolios" p
SET "account_holder_id" = i.id
FROM candidates c
JOIN inserted i
	ON i.user_id = c.user_id
	AND i.name = c.holder_name
	AND i.type = c.holder_type
	AND i.birth_year IS NOT DISTINCT FROM c.birth_year
WHERE p.id = c.portfolio_id;--> statement-breakpoint
ALTER TABLE "portfolios" DROP COLUMN "portfolio_type";--> statement-breakpoint
ALTER TABLE "portfolios" DROP COLUMN "birth_year";--> statement-breakpoint
ALTER TABLE "portfolios" DROP COLUMN "account_holder";