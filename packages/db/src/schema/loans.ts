import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  numeric,
  integer,
  date,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { portfolios } from "./portfolios.js";
import { instruments } from "./instruments.js";
import { screenshotImports } from "./screenshot-imports.js";

export const loans = pgTable(
  "loans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instruments.id, { onDelete: "restrict" }),
    importId: uuid("import_id").references(() => screenshotImports.id, {
      onDelete: "set null",
    }),
    contractNo: text("contract_no"),
    provider: text("provider"),
    purchasePrice: numeric("purchase_price").notNull(),
    downPayment: numeric("down_payment").notNull().default("0"),
    adminFee: numeric("admin_fee").notNull().default("0"),
    discount: numeric("discount").notNull().default("0"),
    principal: numeric("principal").notNull(),
    marginTotal: numeric("margin_total").notNull().default("0"),
    tenorMonths: integer("tenor_months").notNull(),
    monthlyInstallment: numeric("monthly_installment").notNull().default("0"),
    startDate: date("start_date").notNull(),
    schedule: jsonb("schedule"),
    costBasisMode: text("cost_basis_mode").notNull().default("purchase_price"),
    currency: text("currency").notNull().default("IDR"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("loans_portfolio_id_idx").on(t.portfolioId),
    uniqueIndex("loans_portfolio_contract_idx")
      .on(t.portfolioId, t.provider, t.contractNo)
      .where(sql`${t.contractNo} is not null`),
  ],
).enableRLS();
