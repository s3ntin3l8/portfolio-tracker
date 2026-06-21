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
