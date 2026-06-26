ALTER TYPE "public"."transaction_status" ADD VALUE 'draft';--> statement-breakpoint
ALTER TABLE "transaction_sources" ADD COLUMN "confidence" numeric;