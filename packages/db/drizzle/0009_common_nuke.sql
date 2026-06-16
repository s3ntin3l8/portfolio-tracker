CREATE TABLE "provider_usage" (
	"provider" text PRIMARY KEY NOT NULL,
	"day" date,
	"calls_day" integer DEFAULT 0 NOT NULL,
	"month" text,
	"calls_month" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
