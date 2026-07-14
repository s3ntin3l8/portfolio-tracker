CREATE INDEX IF NOT EXISTS "transactions_import_id_status_idx" ON "transactions" USING btree ("import_id","status");
