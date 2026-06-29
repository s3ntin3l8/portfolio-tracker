ALTER TABLE "screenshot_imports" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
CREATE INDEX "screenshot_imports_user_batch_idx" ON "screenshot_imports" USING btree ("user_id","batch_id");