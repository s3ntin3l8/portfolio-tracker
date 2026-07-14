CREATE INDEX IF NOT EXISTS "transactions_portfolio_executed_at_idx" ON "transactions" USING btree ("portfolio_id","executed_at" desc);
