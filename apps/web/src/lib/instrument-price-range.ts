/**
 * The Instrument-detail page's own price-history range chips — deliberately a separate,
 * smaller vocabulary from the portfolio net-worth `ChartRange` (`charts/range-toggle.tsx`).
 * This is per-instrument daily candle history from the market-data provider chain (Yahoo/
 * CoinGecko/…), not the portfolio's timestamped intraday snapshots — so 1D/7D/3M/YTD don't
 * apply here, and "6M" (which the provider chain already understands, see below) does.
 * Kept fully decoupled from `ChartRange` rather than extended into it, so this one screen's
 * needs don't leak into the shared portfolio-history range picker.
 */
export const INSTRUMENT_PRICE_RANGES = ["1m", "6m", "1y", "all"] as const;
export type InstrumentPriceRange = (typeof INSTRUMENT_PRICE_RANGES)[number];

/**
 * Maps our app-level tokens to the market-data provider chain's own vocabulary — Yahoo's
 * chart-API range tokens ("1mo"/"6mo"/"1y"/"max"), which `packages/market-data`'s CoinGecko
 * provider also explicitly understands (see `rangeToDays`). `GET /instruments/:id/history?
 * range=` passes this straight through to whichever provider serves the instrument, with no
 * enum validation of its own — so this mapping lives here, not in the API.
 */
const API_RANGE: Record<InstrumentPriceRange, string> = {
  "1m": "1mo",
  "6m": "6mo",
  "1y": "1y",
  all: "max",
};

export function toApiRange(range: InstrumentPriceRange): string {
  return API_RANGE[range];
}
