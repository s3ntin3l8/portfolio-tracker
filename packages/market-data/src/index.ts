// @portfolio/market-data — provider abstraction. Implementations (Sectors/iTick,
// GoldSpot, Antam, mutual-fund NAV, bonds, EODHD) land in phase 2 / phase 5.
export type AssetClass =
  | "equity"
  | "gold"
  | "bond"
  | "mutual_fund"
  | "etf"
  | "crypto"
  | "derivative";

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

