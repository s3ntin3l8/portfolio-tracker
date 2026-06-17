CREATE TYPE "public"."dividend_status" AS ENUM('announced', 'paid');--> statement-breakpoint
CREATE TABLE "dividend_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"ex_date" date NOT NULL,
	"pay_date" date,
	"amount_per_share" numeric NOT NULL,
	"currency" text NOT NULL,
	"status" "dividend_status" DEFAULT 'announced' NOT NULL,
	"source" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dividend_events" ADD CONSTRAINT "dividend_events_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dividend_events_instrument_exdate_idx" ON "dividend_events" USING btree ("instrument_id","ex_date");