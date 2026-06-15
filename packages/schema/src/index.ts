import { z } from "zod";

// --- Shared enums (mirror @portfolio/db) ---------------------------------

export const assetClassSchema = z.enum([
  "equity",
  "gold",
  "bond",
  "mutual_fund",
  "etf",
  "crypto",
  "derivative",
]);
export type AssetClass = z.infer<typeof assetClassSchema>;

export const unitSchema = z.enum(["shares", "grams", "units"]);
export type Unit = z.infer<typeof unitSchema>;

export const transactionTypeSchema = z.enum([
  "buy",
  "sell",
  "dividend",
  "coupon",
  "fee",
  "split",
  "bonus",
  "rights",
  "savings_plan",
  "deposit",
  "withdrawal",
]);
export type TransactionType = z.infer<typeof transactionTypeSchema>;

export const transactionSourceSchema = z.enum([
  "screenshot",
  "csv",
  "manual",
  "pytr",
]);
export type TransactionSource = z.infer<typeof transactionSourceSchema>;

// --- Primitives ----------------------------------------------------------

// Money/quantities are decimal strings (matches Postgres `numeric`, preserves
// precision — never a float).
export const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "must be a decimal string");

// ISO-4217-style 3-letter currency code, normalised to upper case.
export const currencyCode = z
  .string()
  .trim()
  .length(3)
  .transform((s) => s.toUpperCase());

// --- API inputs ----------------------------------------------------------

export const portfolioInputSchema = z.object({
  name: z.string().min(1),
  baseCurrency: currencyCode.default("IDR"),
});
export type PortfolioInput = z.infer<typeof portfolioInputSchema>;

// Editable user profile fields. Both optional so the settings screen can PATCH a
// subset; identity fields (email, authSub) come from the IdP and are never updated here.
export const userUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  displayCurrency: currencyCode.optional(),
});
export type UserUpdate = z.infer<typeof userUpdateSchema>;

export const corporateActionTypeSchema = z.enum(["split", "bonus", "rights"]);
export type CorporateActionType = z.infer<typeof corporateActionTypeSchema>;

export const corporateActionInputSchema = z.object({
  instrumentId: z.string().uuid(),
  type: corporateActionTypeSchema,
  ratio: decimalString,
  exDate: z.coerce.date(),
  terms: z.string().optional(),
});
export type CorporateActionInput = z.infer<typeof corporateActionInputSchema>;

export const instrumentInputSchema = z.object({
  isin: z.string().optional(),
  symbol: z.string().min(1),
  market: z.string().min(1),
  assetClass: assetClassSchema,
  unit: unitSchema.default("shares"),
  currency: currencyCode,
  name: z.string().min(1),
});
export type InstrumentInput = z.infer<typeof instrumentInputSchema>;

export const transactionInputSchema = z.object({
  portfolioId: z.string().uuid(),
  instrumentId: z.string().uuid().nullable().optional(),
  type: transactionTypeSchema,
  quantity: decimalString.default("0"),
  price: decimalString.default("0"),
  fees: decimalString.default("0"),
  currency: currencyCode,
  executedAt: z.coerce.date(),
  source: transactionSourceSchema.default("manual"),
  externalId: z.string().optional(),
});
export type TransactionInput = z.infer<typeof transactionInputSchema>;

// --- Screenshot / CSV parse output ---------------------------------------

// What a ScreenshotParser (or CSV row) yields — a *draft* the user confirms before
// it becomes a transaction. Never auto-committed.
export const parsedTransactionSchema = z.object({
  assetClass: assetClassSchema,
  action: z.enum(["buy", "sell", "dividend", "coupon"]),
  ticker: z.string().nullish(),
  isin: z.string().nullish(),
  name: z.string().nullish(),
  quantity: decimalString,
  unit: unitSchema,
  price: decimalString,
  fees: decimalString.default("0"),
  total: decimalString.nullish(),
  currency: currencyCode,
  executedAt: z.coerce.date(),
  confidence: z.number().min(0).max(1),
});
export type ParsedTransaction = z.infer<typeof parsedTransactionSchema>;
