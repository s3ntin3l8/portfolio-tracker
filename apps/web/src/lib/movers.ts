import type { HoldingValuation, PeriodMover } from "@portfolio/api-client";

/** A single best/worst-performer row for the Insights "Best & worst" card. */
export interface Mover {
  instrumentId: string;
  symbol: string;
  name: string;
  assetClass: string;
  /** Signed day-change fraction (e.g. 0.032 = +3.2%), already divided by 100 from the
   *  API's percentage-point string — matches the old dashboard's Top Movers convention. */
  pct: number;
}

function toMover(h: HoldingValuation): Mover {
  return {
    instrumentId: h.instrumentId,
    symbol: h.instrument?.symbol ?? "—",
    name: h.instrument?.name ?? h.instrumentId,
    assetClass: h.instrument?.assetClass ?? "cash",
    pct: Number(h.dayChangePct) / 100,
  };
}

/**
 * The best (largest positive day change) and worst (largest negative day change) open
 * holdings, ranked by *signed* `dayChangePct` — not by magnitude, unlike the old
 * dashboard's "Top Movers" panel (which ranked by `|pct|` to surface any big swing).
 * Requires at least two holdings with a known day move; returns null otherwise (a
 * single mover can't sensibly be both "best" and "worst").
 */
/** Convert a server-side `PeriodMover` (signed fraction, e.g. 0.05) into a client `Mover`. */
export function periodToMover(p: PeriodMover): Mover {
  return {
    instrumentId: p.instrumentId,
    symbol: p.symbol,
    name: p.name ?? p.instrumentId,
    assetClass: p.assetClass,
    pct: p.pct,
  };
}

export function bestAndWorst(holdings: HoldingValuation[]): { best: Mover; worst: Mover } | null {
  const withMove = holdings.filter((h) => h.dayChangePct !== null && Number(h.quantity) !== 0);
  if (withMove.length < 2) return null;

  const sorted = [...withMove].sort((a, b) => Number(b.dayChangePct) - Number(a.dayChangePct));
  return {
    best: toMover(sorted[0]),
    worst: toMover(sorted[sorted.length - 1]),
  };
}
