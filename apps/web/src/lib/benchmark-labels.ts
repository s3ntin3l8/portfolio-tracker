// Friendly names for common Yahoo Finance benchmark tickers (the free-text field in
// Settings → Investing accepts any Yahoo symbol — see benchmark-settings-form.tsx).
// Unrecognized tickers fall back to the raw symbol, so this never blocks a custom
// benchmark from working; it only makes the well-known ones read better.
const BENCHMARK_LABELS: Record<string, string> = {
  "^GSPC": "S&P 500",
  "^DJI": "Dow Jones",
  "^IXIC": "Nasdaq Composite",
  "^RUT": "Russell 2000",
  "^STOXX50E": "Euro Stoxx 50",
  "^GDAXI": "DAX",
  "^N225": "Nikkei 225",
  "^JKSE": "IDX Composite",
};

/** A human-readable name for a benchmark ticker, falling back to the ticker itself. */
export function benchmarkLabel(symbol: string): string {
  return BENCHMARK_LABELS[symbol] ?? symbol;
}
