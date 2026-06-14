// @portfolio/market-data — provider abstraction. Implementations (Sectors/iTick,
// GoldSpot, Antam, mutual-fund NAV, bonds, EODHD) land in phase 2 / phase 5.
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

export interface Quote {
  price: number;
  currency: string;
  asOf: string;
}

export interface Candle {
  date: string;
  close: number;
}

export interface Instrument {
  symbol: string;
  isin?: string;
  name: string;
  assetClass: AssetClass;
  currency: string;
}

export interface MarketDataProvider {
  search(query: string): Promise<Instrument[]>;
  getQuote(symbol: string): Promise<Quote>;
  getHistory(symbol: string, range: string): Promise<Candle[]>;
  resolveISIN?(isin: string): Promise<{ symbol: string; exchange: string }>;
  supports(assetClass: AssetClass, market: string): boolean;
}

