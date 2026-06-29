import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Locale-aware money formatting (tabular figures rendered via the mono font). */
export function formatMoney(
  amount: number,
  currency = "IDR",
  locale = "en",
  opts: Intl.NumberFormatOptions = {},
) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "IDR" ? 0 : 2,
    ...opts,
  }).format(amount);
}

/** A loosely-typed next-intl translator scoped to the `Anomalies` namespace. The dynamic
 *  `codes.<code>` key can't be statically verified, so callers pass `ta` cast to this shape. */
export type AnomalyTranslator = (key: string, values?: Record<string, string>) => string;

/**
 * Localized label/tooltip for a transaction-scoped anomaly. For `negative_cash` it folds the
 * formatted cash balance (and its currency) into the message; every other code uses the bare
 * localized string. Shared by the transactions table tooltip and the detail sheet.
 */
export function anomalyLabel(
  anomaly: { code: string; meta?: Record<string, unknown> | null },
  ta: AnomalyTranslator,
  locale: string,
): string {
  if (anomaly.code === "negative_cash" && anomaly.meta) {
    const currency = String(anomaly.meta.currency ?? "");
    return ta("codes.negative_cash", {
      currency,
      balance: formatMoney(Number(anomaly.meta.balance), currency, locale),
    });
  }
  return ta(`codes.${anomaly.code}`);
}

/**
 * Money with an explicit leading "+" for non-negatives (negatives already carry "−"),
 * mirroring the signed style of formatPercent. Zero is rendered as "+0".
 */
export function formatSignedMoney(
  amount: number,
  currency = "IDR",
  locale = "en",
  opts: Intl.NumberFormatOptions = {},
) {
  return `${amount >= 0 ? "+" : ""}${formatMoney(amount, currency, locale, opts)}`;
}

export function formatPercent(value: number, locale = "en") {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: "exceptZero",
  }).format(value);
}
