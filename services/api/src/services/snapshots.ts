import { convert, type FxRateFn } from "@portfolio/core";
import { portfolios, portfolioSnapshots } from "@portfolio/db";
import type { MarketDataService } from "@portfolio/market-data";
import type { DB } from "../db/client.js";
import { valuePortfolio } from "./valuation.js";

/** A point on a net-worth-over-time series. */
export interface NetWorthPoint {
  date: string; // YYYY-MM-DD
  netWorth: string;
}

/**
 * Record today's net-worth snapshot for every portfolio, in its base currency.
 * Idempotent per (portfolio, date) — re-running the job overwrites the day's value,
 * so a manual trigger or a retried cron never double-counts. Returns the row count.
 */
export async function recordDailySnapshots(
  db: DB,
  marketData: MarketDataService,
  ttlMs: number,
  now: Date = new Date(),
): Promise<number> {
  const date = now.toISOString().slice(0, 10);
  const pfs = await db.select().from(portfolios);
  let count = 0;
  for (const p of pfs) {
    const { summary } = await valuePortfolio(
      db,
      marketData,
      ttlMs,
      p.id,
      p.baseCurrency,
    );
    await db
      .insert(portfolioSnapshots)
      .values({
        portfolioId: p.id,
        date,
        netWorth: summary.netWorth,
        currency: p.baseCurrency,
      })
      .onConflictDoUpdate({
        target: [portfolioSnapshots.portfolioId, portfolioSnapshots.date],
        set: { netWorth: summary.netWorth, currency: p.baseCurrency },
      });
    count++;
  }
  return count;
}

/**
 * Lower-bound date (YYYY-MM-DD) for a range string, or null for "all"/unknown
 * (no bound). Mirrors the ranges the instrument-history endpoint accepts.
 */
export function rangeStart(range: string, now: Date = new Date()): string | null {
  const days: Record<string, number> = {
    "1m": 30,
    "3m": 90,
    "6m": 180,
    "1y": 365,
    "2y": 730,
    "5y": 1825,
  };
  const span = days[range];
  if (!span) return null;
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - span);
  return d.toISOString().slice(0, 10);
}

/**
 * Collapse per-portfolio snapshots into one net-worth series in `displayCurrency`,
 * summing same-date values and converting each via the FX function for that row's own
 * date (`fxFor(date)`), so historical points use the rate that applied on the day.
 */
export function aggregateByDate(
  rows: { date: string; netWorth: string; currency: string }[],
  fxFor: (date: string) => FxRateFn,
  displayCurrency: string,
): NetWorthPoint[] {
  const byDate = new Map<string, number>();
  for (const r of rows) {
    const converted = Number(
      convert(r.netWorth, r.currency, displayCurrency, fxFor(r.date)),
    );
    byDate.set(r.date, (byDate.get(r.date) ?? 0) + converted);
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, netWorth]) => ({ date, netWorth: String(netWorth) }));
}
