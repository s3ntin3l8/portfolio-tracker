export const ACQUISITION_TYPES = ["buy", "sell", "savings_plan"] as const;
export const SHARE_RECEIPT_TYPES = ["bonus", "split", "rights"] as const;
export const INCOME_TYPES = ["dividend", "coupon"] as const;
export const CASH_TYPES = [
  "deposit",
  "withdrawal",
  "fee",
  "tax",
  "interest",
  "bonus_cash",
  "adjustment",
] as const;
export const TRANSFER_TYPES = ["transfer_in", "transfer_out"] as const;

export type SelectableType =
  | (typeof ACQUISITION_TYPES)[number]
  | (typeof SHARE_RECEIPT_TYPES)[number]
  | (typeof TRANSFER_TYPES)[number]
  | (typeof INCOME_TYPES)[number]
  | (typeof CASH_TYPES)[number];

export type TxType = SelectableType | "loan_drawdown" | "loan_repayment";

export const ASSET_CLASSES = ["equity", "gold", "bond", "mutual_fund", "etf", "crypto"] as const;

export function marketForAssetClass(assetClass: string): string {
  if (assetClass === "gold") return "ANTAM";
  if (assetClass === "crypto") return "CRYPTO";
  return "IDX";
}

export function clampAssetClass(value: string): (typeof ASSET_CLASSES)[number] {
  return (ASSET_CLASSES as readonly string[]).includes(value)
    ? (value as (typeof ASSET_CLASSES)[number])
    : "equity";
}

export function unitForClass(assetClass: string): "shares" | "grams" | "units" {
  if (assetClass === "gold") return "grams";
  if (assetClass === "mutual_fund" || assetClass === "crypto") return "units";
  return "shares";
}

export function goldSymbolFromLabel(label: string): string {
  const slug = label
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "GOLD";
}
