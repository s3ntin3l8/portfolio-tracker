import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const accountHolders = pgTable(
  "account_holders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").notNull().default("other"),
    birthYear: integer("birth_year"),
    taxAllowanceAnnual: numeric("tax_allowance_annual"),
    capitalGainsTaxRate: numeric("capital_gains_tax_rate"),
    churchTax: boolean("church_tax").default(false),
    taxResidence: text("tax_residence"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_holders_user_id_idx").on(t.userId)],
).enableRLS();
