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

export interface MarketDataProvider {
  readonly name: string;
  supports(assetClass: AssetClass, market: string): boolean;
  getQuote(ref: InstrumentRef): Promise<Quote | null>;
  getHistory?(ref: InstrumentRef, range: string): Promise<Candle[]>;
  resolveISIN?(isin: string): Promise<{ symbol: string; exchange: string } | null>;
}
