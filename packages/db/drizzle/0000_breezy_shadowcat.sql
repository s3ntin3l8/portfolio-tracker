CREATE TYPE "public"."asset_class" AS ENUM('equity', 'gold', 'bond', 'mutual_fund', 'etf', 'crypto', 'derivative');--> statement-breakpoint
CREATE TYPE "public"."corporate_action_type" AS ENUM('split', 'bonus', 'rights');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('draft', 'confirmed', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."transaction_source" AS ENUM('screenshot', 'csv', 'manual', 'pytr');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('buy', 'sell', 'dividend', 'coupon', 'fee', 'split', 'bonus', 'rights', 'savings_plan', 'deposit', 'withdrawal');--> statement-breakpoint
CREATE TYPE "public"."unit" AS ENUM('shares', 'grams', 'units');--> statement-breakpoint
CREATE TABLE "corporate_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"type" "corporate_action_type" NOT NULL,
	"ratio" numeric NOT NULL,
	"ex_date" date NOT NULL,
	"terms" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base" text NOT NULL,
	"quote" text NOT NULL,
	"rate" numeric NOT NULL,
	"date" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"isin" text,
	"symbol" text NOT NULL,
	"market" text NOT NULL,
	"exchange_code" text,
	"asset_class" "asset_class" NOT NULL,
	"unit" "unit" DEFAULT 'shares' NOT NULL,
	"currency" text NOT NULL,
	"name" text NOT NULL,
	"face_value" numeric,
	"coupon_rate" numeric,
	"coupon_schedule" text,
	"maturity_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instruments_isin_unique" UNIQUE("isin")
);
--> statement-breakpoint
CREATE TABLE "last_prices" (
	"instrument_id" uuid PRIMARY KEY NOT NULL,
	"price" numeric NOT NULL,
	"currency" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"base_currency" text DEFAULT 'IDR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"date" date NOT NULL,
	"close" numeric NOT NULL,
	"currency" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "screenshot_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"portfolio_id" uuid,
	"storage_path" text,
	"parser" text,
	"model" text,
	"parsed_json" jsonb,
	"confidence" numeric,
	"status" "import_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"instrument_id" uuid,
	"type" "transaction_type" NOT NULL,
	"quantity" numeric DEFAULT '0' NOT NULL,
	"price" numeric DEFAULT '0' NOT NULL,
	"fees" numeric DEFAULT '0' NOT NULL,
	"currency" text NOT NULL,
	"executed_at" timestamp with time zone NOT NULL,
	"source" "transaction_source" DEFAULT 'manual' NOT NULL,
	"import_id" uuid,
	"savings_plan_id" text,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_sub" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"display_currency" text DEFAULT 'IDR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_auth_sub_unique" UNIQUE("auth_sub")
);
--> statement-breakpoint
ALTER TABLE "corporate_actions" ADD CONSTRAINT "corporate_actions_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "last_prices" ADD CONSTRAINT "last_prices_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screenshot_imports" ADD CONSTRAINT "screenshot_imports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screenshot_imports" ADD CONSTRAINT "screenshot_imports_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_import_id_screenshot_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."screenshot_imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fx_rates_base_quote_date_idx" ON "fx_rates" USING btree ("base","quote","date");--> statement-breakpoint
CREATE UNIQUE INDEX "instruments_market_symbol_idx" ON "instruments" USING btree ("market","symbol");--> statement-breakpoint
CREATE INDEX "portfolios_user_id_idx" ON "portfolios" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prices_instrument_date_idx" ON "prices" USING btree ("instrument_id","date");--> statement-breakpoint
CREATE INDEX "transactions_portfolio_id_idx" ON "transactions" USING btree ("portfolio_id");--> statement-breakpoint
CREATE INDEX "transactions_instrument_id_idx" ON "transactions" USING btree ("instrument_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_dedup_idx" ON "transactions" USING btree ("portfolio_id","source","external_id") WHERE "transactions"."external_id" is not null;