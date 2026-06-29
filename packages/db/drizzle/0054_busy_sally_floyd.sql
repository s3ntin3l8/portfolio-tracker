CREATE TABLE "dismissed_anomalies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portfolios" ADD COLUMN "allow_negative_cash" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "dismissed_anomalies" ADD CONSTRAINT "dismissed_anomalies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dismissed_anomalies" ADD CONSTRAINT "dismissed_anomalies_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dismissed_anomalies" ADD CONSTRAINT "dismissed_anomalies_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dismissed_anomalies_pf_tx_code_idx" ON "dismissed_anomalies" USING btree ("portfolio_id","transaction_id","code");--> statement-breakpoint
CREATE INDEX "dismissed_anomalies_portfolio_id_idx" ON "dismissed_anomalies" USING btree ("portfolio_id");