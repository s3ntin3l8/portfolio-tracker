CREATE TABLE "provider_settings" (
	"provider" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
