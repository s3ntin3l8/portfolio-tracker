ALTER TABLE "instruments" ADD COLUMN "wkn" text;--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_wkn_unique" UNIQUE("wkn");