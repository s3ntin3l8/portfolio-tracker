CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_description_trgm_idx" ON "transactions" USING gin ("description" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "instruments_symbol_trgm_idx" ON "instruments" USING gin ("symbol" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "instruments_name_trgm_idx" ON "instruments" USING gin ("name" gin_trgm_ops);
