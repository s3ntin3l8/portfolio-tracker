export const ASSET_CLASSES = [
  "equity",
  "gold",
  "bond",
  "mutual_fund",
  "etf",
  "crypto",
  "derivative",
] as const;

export type AssetClass = (typeof ASSET_CLASSES)[number];

export function isAssetClass(value: string): value is AssetClass {
  return (ASSET_CLASSES as readonly string[]).includes(value);
}

/** Enough to identify an instrument for a quote/history lookup. */
export interface InstrumentRef {
  symbol: string;
  market: string; // 'IDX' | 'XAU' | ...
  assetClass: AssetClass;
  currency: string;
  isin?: string;
}

export interface Quote {
  price: string; // decimal string
  currency: string;
  asOf: string; // ISO timestamp
  /** Prior session's close, when the provider reports it (for day-change). */
  previousClose?: string | null;
}

export interface Candle {
  date: string; // YYYY-MM-DD
  close: string;
}

/** A discovered instrument's metadata, enough to prefill the manual-entry form. */
export interface InstrumentSearchResult {
  symbol: string;
  name: string;
  market: string; // 'IDX' | 'XETRA' | ...
  assetClass: AssetClass;
  currency: string;
  isin?: string;
  source: string; // the provider that surfaced it (display/debug)
}

/** A keyed provider's reported API consumption against its plan, for one time window. */
export interface ProviderUsage {
  /** The window the counts cover: per-minute, per-day, or per-month. */
  window: "minute" | "day" | "month";
  /** Calls/credits consumed in the window, or null when the API doesn't report it. */
  used: number | null;
  /** The plan cap for the window, or null when the API doesn't report it (e.g. GoldAPI). */
  limit: number | null;
  /** When the window resets, ISO timestamp, when the API reports it. */
  resetAt?: string;
}

export interface MarketDataProvider {
  readonly name: string;
  supports(assetClass: AssetClass, market: string): boolean;
  getQuote(ref: InstrumentRef): Promise<Quote | null>;
  getHistory?(ref: InstrumentRef, range: string): Promise<Candle[]>;
  /** Free-text ticker/name discovery (not `supports`-gated; cross-market). */
  search?(query: string): Promise<InstrumentSearchResult[]>;
  /** Resolve an ISIN to a symbol + exchange (+ optional name/type for enrichment). */
  resolveISIN?(
    isin: string,
  ): Promise<{ symbol: string; exchange: string; name?: string; type?: string } | null>;
  /** Live API quota/usage from the provider, when it exposes a usage endpoint. */
  getUsage?(): Promise<ProviderUsage | null>;
}

/** A 12-char ISIN: 2-letter country, 9 alphanumerics, 1 check digit. */
export const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

export function isIsin(value: string): boolean {
  return ISIN_PATTERN.test(value.trim().toUpperCase());
}
