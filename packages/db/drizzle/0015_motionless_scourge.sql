CREATE TABLE "tr_resolved_events" (
	"portfolio_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"resolution" text NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tr_resolved_events_portfolio_id_event_id_pk" PRIMARY KEY("portfolio_id","event_id")
);
--> statement-breakpoint
ALTER TABLE "tr_resolved_events" ADD CONSTRAINT "tr_resolved_events_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE cascade ON UPDATE no action;