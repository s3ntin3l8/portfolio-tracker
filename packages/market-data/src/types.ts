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
  /** Native quote currency (e.g. `"USD"` for a USD-denominated listing on Xetra).
   *  Absent when the provider encodes currency in the symbol pair (gold, crypto).
   *  Callers should fall back to `instrument.currency` when this is absent. */
  currency?: string;
}

/** A discovered instrument's metadata, enough to prefill the manual-entry form. */
export interface InstrumentSearchResult {
  symbol: string;
  name: string;
  market: string; // 'IDX' | 'XETRA' | ...
  assetClass: AssetClass;
  currency: string;
  isin?: string;
  wkn?: string;
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

/**
 * Instrument profile data returned by a market-data provider, used to enrich
 * the `instruments.sector` (stocks) or `instruments.sector_weights` (ETFs)
 * columns in the background metadata job.
 */
export interface InstrumentProfile {
  /** GICS-style sector (e.g. "Financials", "Technology"). Set for individual
   *  stocks. Null for ETFs — use `sectorWeights` instead. */
  sector?: string | null;
  /**
   * Per-sector allocation weights for ETFs. Keys are GICS-style sector names;
   * values are fractions 0–1. Sum is typically ≤ 1 (remaining fraction may be
   * cash/unclassified). Null for non-ETFs.
   * Example: { "Technology": 0.29, "Financials": 0.13, … }
   */
  sectorWeights?: Record<string, number> | null;
  /** GICS industry (sub-sector). Informational; not stored in the DB yet. */
  industry?: string | null;
  /** Country of incorporation / primary listing. */
  country?: string | null;
}

/** A dividend event for an instrument, as returned by a market-data provider. */
export interface DividendEvent {
  /** Ex-dividend date: YYYY-MM-DD. */
  exDate: string;
  /** Cash payment date: YYYY-MM-DD, or null/undefined when not yet known. */
  payDate?: string | null;
  /** Per-share cash amount in the instrument's native currency (unadjusted). */
  amountPerShare: string;
  currency: string;
}

export interface MarketDataProvider {
  readonly name: string;
  supports(assetClass: AssetClass, market: string): boolean;
  getQuote(ref: InstrumentRef): Promise<Quote | null>;
  getHistory?(ref: InstrumentRef, range: string): Promise<Candle[]>;
  /**
   * Fetch daily closes from `fromDate` (YYYY-MM-DD, inclusive) to today.
   * Used for inception-bounded backfill so the prices table only stores
   * [firstHeld, today] per instrument. Returns empty when not supported.
   */
  getHistoryFrom?(ref: InstrumentRef, fromDate: string): Promise<Candle[]>;
  /** Free-text ticker/name discovery (not `supports`-gated; cross-market). */
  search?(query: string): Promise<InstrumentSearchResult[]>;
  /** Resolve an ISIN to a symbol + exchange (+ optional name/type for enrichment). */
  resolveISIN?(
    isin: string,
  ): Promise<{ symbol: string; exchange: string; name?: string; type?: string } | null>;
  /** Resolve a WKN to a symbol + exchange (+ optional name/type for enrichment). */
  resolveWKN?(
    wkn: string,
  ): Promise<{ symbol: string; exchange: string; name?: string; type?: string } | null>;
  /** Live API quota/usage from the provider, when it exposes a usage endpoint. */
  getUsage?(): Promise<ProviderUsage | null>;
  /**
   * Fetch historical + upcoming dividend events for an instrument.
   * `fromDate` (YYYY-MM-DD) limits the window; defaults to 2 years back.
   */
  getDividends?(ref: InstrumentRef, fromDate?: string): Promise<DividendEvent[]>;
  /**
   * Fetch instrument profile metadata (sector, industry, country). Used by the
   * background `refresh-instrument-metadata` job to populate `instruments.sector`.
   * Returns null when the provider does not support profile lookups or the
   * instrument is not found.
   */
  getProfile?(ref: InstrumentRef): Promise<InstrumentProfile | null>;
}

/** A 12-char ISIN: 2-letter country, 9 alphanumerics, 1 check digit. */
export const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

export function isIsin(value: string): boolean {
  return ISIN_PATTERN.test(value.trim().toUpperCase());
}

/**
 * WKN: 6-char alphanumeric, capitals only, no I or O (BaFin format since July 2003).
 * Pure-numeric WKNs (pre-2003) are unambiguous; alphanumeric WKNs can look like tickers,
 * so treat isWkn() as a hint and fall through to name/ticker search when resolution fails.
 */
export const WKN_PATTERN = /^[0-9A-HJ-NP-Z]{6}$/;

export function isWkn(value: string): boolean {
  return WKN_PATTERN.test(value.trim().toUpperCase());
}
