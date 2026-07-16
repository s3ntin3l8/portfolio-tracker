import {
  pgTable,
  uuid,
  text,
  numeric,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { portfolios } from "./portfolios.js";
import { accountHolders } from "./account-holders.js";
import { lossPotEnum } from "./enums.js";

export const allocationTargets = pgTable(
  "allocation_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    portfolioId: uuid("portfolio_id").references(() => portfolios.id, {
      onDelete: "cascade",
    }),
    dimension: text("dimension").notNull(),
    targetKey: text("target_key").notNull(),
    targetPct: numeric("target_pct").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("allocation_targets_scope_dim_key_idx").on(
      t.userId,
      t.portfolioId,
      t.dimension,
      t.targetKey,
    ),
    index("allocation_targets_user_idx").on(t.userId),
  ],
).enableRLS();

export const lossCarryforward = pgTable(
  "loss_carryforward",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    holderId: uuid("holder_id")
      .notNull()
      .references(() => accountHolders.id, { onDelete: "cascade" }),
    taxYear: integer("tax_year").notNull(),
    pot: lossPotEnum("pot").notNull(),
    amount: numeric("amount").notNull(),
    source: text("source").notNull().default("manual"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("loss_carryforward_holder_year_pot_idx").on(t.holderId, t.taxYear, t.pot),
    index("loss_carryforward_holder_idx").on(t.holderId),
  ],
).enableRLS();
