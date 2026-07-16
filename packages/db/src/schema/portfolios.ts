import { pgTable, uuid, text, numeric, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { accountHolders } from "./account-holders.js";

export const portfolios = pgTable(
  "portfolios",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    baseCurrency: text("base_currency").notNull().default("IDR"),
    accountHolderId: uuid("account_holder_id").references(() => accountHolders.id, {
      onDelete: "set null",
    }),
    brokerage: text("brokerage"),
    accountNumber: text("account_number"),
    iban: text("iban"),
    includeInAggregate: boolean("include_in_aggregate").notNull().default(true),
    cashCounted: boolean("cash_counted").notNull().default(false),
    allowNegativeCash: boolean("allow_negative_cash").notNull().default(false),
    documentRetention: boolean("document_retention").notNull().default(false),
    taxAllowanceAnnual: numeric("tax_allowance_annual"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("portfolios_user_id_idx").on(t.userId)],
).enableRLS();
