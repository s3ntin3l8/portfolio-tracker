import { pgEnum } from "drizzle-orm/pg-core";

export const assetClassEnum = pgEnum("asset_class", [
  "equity",
  "gold",
  "bond",
  "mutual_fund",
  "etf",
  "crypto",
  "derivative",
]);

export const unitEnum = pgEnum("unit", ["shares", "grams", "units"]);

export const txTypeEnum = pgEnum("transaction_type", [
  "buy",
  "sell",
  "dividend",
  "coupon",
  "interest",
  "fee",
  "tax",
  "split",
  "bonus",
  "rights",
  "savings_plan",
  "deposit",
  "withdrawal",
  "bonus_cash",
  "loan_drawdown",
  "loan_repayment",
  "transfer_in",
  "transfer_out",
  "adjustment",
]);

export const txStatusEnum = pgEnum("transaction_status", [
  "normal",
  "archived",
  "cash_neutral",
  "draft",
]);

export const txSourceEnum = pgEnum("transaction_source", [
  "screenshot",
  "csv",
  "manual",
  "pytr",
  "pdf",
  "ibkr",
]);

export const txSourceTypeEnum = pgEnum("tx_source_type", [
  "csv",
  "pdf",
  "screenshot",
  "pytr",
  "manual",
  "ibkr",
]);

export const corpActionTypeEnum = pgEnum("corporate_action_type", ["split", "bonus", "rights"]);

export const importStatusEnum = pgEnum("import_status", ["draft", "confirmed", "discarded"]);

export const trConnectionStatusEnum = pgEnum("tr_connection_status", [
  "disconnected",
  "awaiting_2fa",
  "connected",
  "expired",
  "error",
]);

export const ibkrConnectionStatusEnum = pgEnum("ibkr_connection_status", [
  "disconnected",
  "connected",
  "expired",
  "error",
]);

export const dividendStatusEnum = pgEnum("dividend_status", ["announced", "paid"]);

export const lossPotEnum = pgEnum("loss_pot", ["stock", "general"]);
