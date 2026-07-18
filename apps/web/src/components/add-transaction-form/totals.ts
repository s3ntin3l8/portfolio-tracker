import { isTradeType, isTransferType } from "@portfolio/core";

// Mirrors the form's own local INCOME_TYPES (narrower than @portfolio/core's isIncomeType —
// excludes interest/bonus_cash, which the form buckets under Cash) — see pricing-fields.tsx.
const INCOME_TYPES = ["dividend", "coupon"] as const;

export type TxTotalKind = "trade-buy" | "trade-sell" | "transfer" | "income";

export interface TxTotal {
  kind: TxTotalKind;
  /** qty × price — meaningful only for `kind === "trade-*"`. */
  subtotal: number;
  fees: number;
  tax: number;
  /** Signed grand total (fees/tax already applied per `kind`'s sign convention). */
  total: number;
}

/** `"1,234.5"` → `1234.5`. Undoes `formatGrouped` display formatting; NaN for blank/invalid. */
export function stripGrouping(v: string | null | undefined): number {
  if (!v) return NaN;
  return parseFloat(v.replace(/,/g, ""));
}

/**
 * Live transaction total — mirrors the Add Transaction v2 design's `_tickTotal`/summary-line
 * logic exactly (buy: subtotal+fees+tax; sell: subtotal−fees−tax; transfer: qty×cost basis;
 * income: amount−tax). Returns `null` when the type has no total concept (cash/share-receipt)
 * or the required fields aren't filled in yet.
 */
export function computeTxTotal(
  type: string,
  quantity: string,
  price: string,
  fees: string,
  tax: string,
): TxTotal | null {
  const qn = stripGrouping(quantity);
  const pn = stripGrouping(price);
  const fn = stripGrouping(fees) || 0;
  const tn = stripGrouping(tax) || 0;

  if (isTradeType(type) && isFinite(qn) && isFinite(pn)) {
    const subtotal = qn * pn;
    const isSell = type === "sell";
    return {
      kind: isSell ? "trade-sell" : "trade-buy",
      subtotal,
      fees: fn,
      tax: tn,
      total: isSell ? subtotal - fn - tn : subtotal + fn + tn,
    };
  }
  if (isTransferType(type) && isFinite(qn) && isFinite(pn)) {
    const subtotal = qn * pn;
    return { kind: "transfer", subtotal, fees: 0, tax: 0, total: subtotal };
  }
  if ((INCOME_TYPES as readonly string[]).includes(type) && isFinite(pn)) {
    return { kind: "income", subtotal: pn, fees: 0, tax: tn, total: pn - tn };
  }
  return null;
}

/** i18n key (under `Manage.tx`) for a total's label, keyed by `TxTotal.kind`. Shared between
 *  the mobile inline total card and the desktop Summary rail so the two never drift. */
export function totalLabelKey(
  kind: TxTotalKind,
): "totalEstimated" | "totalProceeds" | "totalCostBasis" | "totalNetIncome" {
  switch (kind) {
    case "trade-sell":
      return "totalProceeds";
    case "transfer":
      return "totalCostBasis";
    case "income":
      return "totalNetIncome";
    case "trade-buy":
    default:
      return "totalEstimated";
  }
}

/** `1234.5, "USD"` → `"USD 1,234.50"`. IDR has no decimals; everything else shows 2. */
export function formatMoney(n: number, currency: string): string {
  if (!isFinite(n)) return "";
  const dec = currency === "IDR" ? 0 : 2;
  const formatted = n.toLocaleString("en-US", {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
  return currency ? `${currency} ${formatted}` : formatted;
}
