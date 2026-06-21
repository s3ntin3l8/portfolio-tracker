CREATE TYPE "public"."tx_source_type" AS ENUM('csv', 'pdf', 'screenshot', 'pytr', 'manual');--> statement-breakpoint
CREATE TABLE "transaction_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"source_type" "tx_source_type" NOT NULL,
	"import_id" uuid,
	"document_id" uuid,
	"external_id" text,
	"order_ref" text,
	"tax" numeric,
	"fees" numeric,
	"executed_price" numeric,
	"fx_rate" numeric,
	"venue" text,
	"tax_components" jsonb,
	"raw_data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transaction_sources" ADD CONSTRAINT "transaction_sources_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_sources" ADD CONSTRAINT "transaction_sources_import_id_screenshot_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."screenshot_imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_sources" ADD CONSTRAINT "transaction_sources_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transaction_sources_tx_id_idx" ON "transaction_sources" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transaction_sources_document_id_idx" ON "transaction_sources" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_sources_dedup_idx" ON "transaction_sources" USING btree ("transaction_id","source_type","external_id") WHERE "transaction_sources"."external_id" is not null;