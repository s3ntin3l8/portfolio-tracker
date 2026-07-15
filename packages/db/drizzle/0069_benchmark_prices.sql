CREATE TABLE IF NOT EXISTS "benchmark_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"date" date NOT NULL,
	"close" numeric NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"source" text DEFAULT 'yahoo' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "benchmark_prices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "benchmark_symbol" text;
--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "risk_free_rate" numeric;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "benchmark_prices" ADD CONSTRAINT "benchmark_prices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "benchmark_prices_user_symbol_date_idx" ON "benchmark_prices" USING btree ("user_id","symbol","date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "benchmark_prices_user_symbol_idx" ON "benchmark_prices" USING btree ("user_id","symbol");
