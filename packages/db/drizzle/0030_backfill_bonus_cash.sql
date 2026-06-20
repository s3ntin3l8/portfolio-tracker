-- Backfill: reclassify existing broker cash-bonus rows (BONUS, KINDERGELD_BONUS,
-- STOCKPERK from the TR CSV import) from type='interest'+kind='bonus' → type='bonus_cash'.
-- Must be a separate migration from the ALTER TYPE that added 'bonus_cash' (0029) because
-- Postgres does not allow using a newly-added enum value in the same transaction as the
-- ALTER TYPE that introduced it.
UPDATE transactions
  SET type = 'bonus_cash'
  WHERE type = 'interest'
    AND kind = 'bonus';
