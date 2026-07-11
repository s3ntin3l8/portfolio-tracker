ALTER TABLE "documents" ADD COLUMN "category" text DEFAULT 'receipt' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "tax_year" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_user_source_event_unique_idx" ON "documents" USING btree ("user_id","source_event_id") WHERE "documents"."source_event_id" is not null and "documents"."category" = 'tax_report';