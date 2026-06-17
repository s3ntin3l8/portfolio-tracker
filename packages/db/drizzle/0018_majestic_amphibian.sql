ALTER TYPE "public"."transaction_type" ADD VALUE 'loan_drawdown';--> statement-breakpoint
ALTER TYPE "public"."transaction_type" ADD VALUE 'loan_repayment';--> statement-breakpoint
CREATE TABLE "loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"import_id" uuid,
	"contract_no" text,
	"provider" text,
	"purchase_price" numeric NOT NULL,
	"down_payment" numeric DEFAULT '0' NOT NULL,
	"admin_fee" numeric DEFAULT '0' NOT NULL,
	"discount" numeric DEFAULT '0' NOT NULL,
	"principal" numeric NOT NULL,
	"margin_total" numeric DEFAULT '0' NOT NULL,
	"tenor_months" integer NOT NULL,
	"monthly_installment" numeric DEFAULT '0' NOT NULL,
	"start_date" date NOT NULL,
	"schedule" jsonb,
	"cost_basis_mode" text DEFAULT 'purchase_price' NOT NULL,
	"currency" text DEFAULT 'IDR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "loan_id" uuid;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_import_id_screenshot_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."screenshot_imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loans_portfolio_id_idx" ON "loans" USING btree ("portfolio_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loans_portfolio_contract_idx" ON "loans" USING btree ("portfolio_id","provider","contract_no") WHERE "loans"."contract_no" is not null;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE set null ON UPDATE no action;