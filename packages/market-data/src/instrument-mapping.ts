import type { AssetClass } from "./types.js";

/** Our internal market + the currency instruments on it trade in. */
export interface MarketInfo {
  market: string;
  currency: string;
}

/**
 * Map a provider's exchange identifier (TwelveData `exchange`/`mic_code`, Yahoo
 * `exchange`, OpenFIGI `exchCode`) to our internal market + its trading currency.
 * Indonesia (the primary market) is covered exhaustively; common US/EU venues are
 * included for ISIN lookups. Returns `undefined` for anything unrecognised so callers
 * can fall back to the provider's own currency or skip the result.
 */
const EXCHANGE_MAP: Record<string, MarketInfo> = {
  // Indonesia — IDX (IDR). TwelveData: IDX/XIDX; Yahoo: JKT; OpenFIGI: IJ.
  IDX: { market: "IDX", currency: "IDR" },
  XIDX: { market: "IDX", currency: "IDR" },
  JK: { market: "IDX", currency: "IDR" },
  JKT: { market: "IDX", currency: "IDR" },
  IJ: { market: "IDX", currency: "IDR" },
  JAKARTA: { market: "IDX", currency: "IDR" },
  // United States (USD).
  US: { market: "US", currency: "USD" },
  USA: { market: "US", currency: "USD" },
  NASDAQ: { market: "US", currency: "USD" },
  XNAS: { market: "US", currency: "USD" },
  NMS: { market: "US", currency: "USD" },
  NGM: { market: "US", currency: "USD" },
  NCM: { market: "US", currency: "USD" },
  NYSE: { market: "US", currency: "USD" },
  XNYS: { market: "US", currency: "USD" },
  NYQ: { market: "US", currency: "USD" },
  PCX: { market: "US", currency: "USD" },
  UN: { market: "US", currency: "USD" },
  UW: { market: "US", currency: "USD" },
  UQ: { market: "US", currency: "USD" },
  // Germany / Xetra (EUR).
  XETR: { market: "XETRA", currency: "EUR" },
  XETRA: { market: "XETRA", currency: "EUR" },
  GER: { market: "XETRA", currency: "EUR" },
  GR: { market: "XETRA", currency: "EUR" },
  GY: { market: "XETRA", currency: "EUR" },
  FRA: { market: "XETRA", currency: "EUR" },
  // Singapore (SGD).
  SGX: { market: "SGX", currency: "SGD" },
  XSES: { market: "SGX", currency: "SGD" },
  SES: { market: "SGX", currency: "SGD" },
  SI: { market: "SGX", currency: "SGD" },
};

export function mapExchange(exchange: string | undefined | null): MarketInfo | undefined {
  if (!exchange) return undefined;
  return EXCHANGE_MAP[exchange.trim().toUpperCase()];
}

/**
 * Normalise a provider's instrument-type/security-type string to our `AssetClass`.
 * Falls back to `equity` (the dominant case) when the type is missing or unknown.
 */
export function assetClassFromType(type: string | undefined | null): AssetClass {
  const t = (type ?? "").toLowerCase();
  if (t.includes("etf") || t.includes("etp") || t.includes("fund of")) return "etf";
  if (t.includes("mutual") || t.includes("reksa")) return "mutual_fund";
  if (t.includes("bond") || t.includes("note") || t.includes("govt") || t.includes("corp"))
    return "bond";
  if (t.includes("crypto") || t.includes("digital currency")) return "crypto";
  if (
    t.includes("future") ||
    t.includes("option") ||
    t.includes("warrant") ||
    t.includes("derivative")
  )
    return "derivative";
  return "equity";
}
