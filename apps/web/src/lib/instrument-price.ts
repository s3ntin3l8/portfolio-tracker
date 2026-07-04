/**
 * The Instrument-detail price hero's "Last price · {change} · {pct} today" headline.
 * Derived purely from daily candle history (already loaded for the chart, no new fetch) —
 * the last close is the price, the prior close is the comparison base — rather than mixing
 * in `HoldingValuation.dayChange` (only available when the instrument is held), so held and
 * unheld instruments compute this the same way.
 */
export interface LastPriceInfo {
  price: number;
  currency: string;
  /** Absolute and percentage change vs. the prior close; null when there's only one candle
   *  (no comparison base yet). */
  change: number | null;
  changePct: number | null;
}

export function lastPriceInfo(
  history: { close: string; currency?: string }[],
  fallbackCurrency: string,
): LastPriceInfo | null {
  if (history.length === 0) return null;
  const last = history[history.length - 1];
  const price = Number(last.close);
  const currency = last.currency ?? fallbackCurrency;
  if (history.length < 2) return { price, currency, change: null, changePct: null };

  const prev = Number(history[history.length - 2].close);
  const change = price - prev;
  const changePct = prev !== 0 ? change / prev : null;
  return { price, currency, change, changePct };
}
