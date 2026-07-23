export const ACQUISITION_TYPES = ["buy", "sell", "savings_plan"] as const;
/** No longer offered in the manual form (Add Transaction v2 moves splits/bonus shares/
 *  rights to the "Instrument event" destination's admin-gated, instrument-global Corporate
 *  action recorder — see `NewEntryTabs`). Kept here only so `isShareReceiptType` and
 *  existing legacy transactions of these types keep rendering correctly in edit/detail. */
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

/** The v2 design's 4-way "intent bucket" switcher — replaces the old flat type-chip
 *  picker. Selecting a bucket resets `type` to its default; the sub-type chip row below
 *  it offers the bucket's own types, labeled by `subTypeLabelKey`. */
export const BUCKETS = ["trade", "income", "transfer", "cash"] as const;
export type Bucket = (typeof BUCKETS)[number];

export const BUCKET_DEFAULT_TYPE: Record<Bucket, TxType> = {
  trade: "buy",
  income: "dividend",
  transfer: "transfer_in",
  cash: "deposit",
};

export const BUCKET_TYPES: Record<Bucket, readonly string[]> = {
  trade: ACQUISITION_TYPES,
  income: INCOME_TYPES,
  transfer: TRANSFER_TYPES,
  cash: CASH_TYPES,
};

/** i18n key (under `Manage.tx`) for the sub-type row's label — "Action" for trade,
 *  "Type" for income, "Direction" for transfer, "Category" for cash. */
export const BUCKET_SUBTYPE_LABEL_KEY: Record<
  Bucket,
  "bucketSubtypeAction" | "bucketSubtypeType" | "bucketSubtypeDirection" | "bucketSubtypeCategory"
> = {
  trade: "bucketSubtypeAction",
  income: "bucketSubtypeType",
  transfer: "bucketSubtypeDirection",
  cash: "bucketSubtypeCategory",
};

/** Which bucket a type belongs to — `null` for legacy share-receipt types (no longer
 *  selectable via the bucket switcher, but still valid on an existing transaction being
 *  edited; see `SHARE_RECEIPT_TYPES`). */
export function bucketForType(type: string): Bucket | null {
  for (const b of BUCKETS) {
    if ((BUCKET_TYPES[b] as readonly string[]).includes(type)) return b;
  }
  return null;
}

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
