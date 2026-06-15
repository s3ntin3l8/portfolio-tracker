CREATE TYPE "public"."tr_connection_status" AS ENUM('disconnected', 'awaiting_2fa', 'connected', 'expired', 'error');--> statement-breakpoint
CREATE TABLE "tr_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"portfolio_id" uuid,
	"phone_enc" text NOT NULL,
	"pin_enc" text NOT NULL,
	"session_enc" text,
	"status" "tr_connection_status" DEFAULT 'disconnected' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tr_connections_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "tr_connections" ADD CONSTRAINT "tr_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tr_connections" ADD CONSTRAINT "tr_connections_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Defense-in-depth: enable RLS with no policies (see 0001_enable_rls). Holds encrypted
-- TR secrets; the API connects as a BYPASSRLS role and scopes by user, so this only
-- shuts the Supabase Data API.
ALTER TABLE "tr_connections" ENABLE ROW LEVEL SECURITY;