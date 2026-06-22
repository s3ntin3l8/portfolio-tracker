ALTER TYPE "public"."transaction_source" ADD VALUE 'pdf';
--> statement-breakpoint
-- Backfill: re-label PDF-origin transactions that were incorrectly tagged
-- source='screenshot' before the dkb-pdf/tr-pdf parser tags were introduced.
--
-- Discriminator 1: a transaction_sources row with sourceType='pdf' (present when
-- the import carried taxComponents — e.g. DKB/TR settlement PDFs with tax detail).
UPDATE "transactions"
SET "source" = 'pdf'
WHERE "source" = 'screenshot'
  AND EXISTS (
    SELECT 1 FROM "transaction_sources" s
    WHERE s."transaction_id" = "transactions"."id"
      AND s."source_type" = 'pdf'
  );
--> statement-breakpoint
-- Discriminator 2: the import has a retained PDF document (catches plain PDF imports
-- without taxComponents that left no 'pdf' source row under the old code).
UPDATE "transactions"
SET "source" = 'pdf'
WHERE "source" = 'screenshot'
  AND "import_id" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "documents" d
    WHERE d."import_id" = "transactions"."import_id"
      AND d."mime_type" = 'application/pdf'
      AND d."status" = 'retained'
  );
-- Note: plain PDF imports with retention OFF and no taxComponents cannot be
-- identified by either discriminator; those rows stay 'screenshot' until re-import.
