import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  numeric,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { portfolios } from "./portfolios.js";
import { importStatusEnum } from "./enums.js";

export const screenshotImports = pgTable(
  "screenshot_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    portfolioId: uuid("portfolio_id").references(() => portfolios.id, {
      onDelete: "set null",
    }),
    storagePath: text("storage_path"),
    parser: text("parser"),
    model: text("model"),
    parsedJson: jsonb("parsed_json"),
    confidence: numeric("confidence"),
    contentHash: text("content_hash"),
    status: importStatusEnum("status").notNull().default("draft"),
    batchId: uuid("batch_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("screenshot_imports_user_content_hash_idx")
      .on(t.userId, t.contentHash)
      .where(sql`${t.status} <> 'discarded' AND ${t.contentHash} IS NOT NULL`),
    index("screenshot_imports_user_batch_idx").on(t.userId, t.batchId),
  ],
).enableRLS();
