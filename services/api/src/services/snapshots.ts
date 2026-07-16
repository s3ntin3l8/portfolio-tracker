import { inArray, isNotNull, lt } from "drizzle-orm";
import {
  cashFlow,
  convert,
  isTradeType,
  toDateKey,
  type FxRateFn,
  type PriceSeriesKind,
} from "@portfolio/core";
import {
  instruments,
  portfolioIntradaySnapshots,
  portfolios,
  portfolioSnapshots,
  transactions,
} from "@portfolio/db";
import type { MarketDataService } from "@portfolio/market-data";
import type { DB } from "../db/client.js";
import { valuePortfolio } from "./valuation.js";
import { isMarketOpen } from "./market-hours.js";

/** Rows are pruned after ~8 days — comfortably enough for a 7D chart with headroom. */
const INTRADAY_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;

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
  const date = toDateKey(now);
  const pfs = await db.select().from(portfolios);
  let count = 0;
  for (const p of pfs) {
    const { summary, coreTxns, metaById } = await valuePortfolio(
      db,
      marketData,
      ttlMs,
      p.id,
      p.baseCurrency,
      undefined,
      p.cashCounted,
      undefined,
      now,
    );

    // Compute today's effectiveFlow: -Σ cashFlow(tx) for qualifying txns executed today.
    // This measures flows into/out of the SECURITIES sleeve only (holdings market value),
    // mirroring the TWR definition in packages/core/src/twr.ts — the canonical source. TWR
    // pairs it with marketValue (not net worth), so it is robust to unrecorded cash. Only
    // buy/savings_plan/sell and dividend/coupon (realSeries) count. deposit/withdrawal/
    // transfer_*/fee/interest are INTENTIONALLY excluded: they land in cash and don't move
    // market value, so effectiveFlow is 0 on a pure-deposit day BY DESIGN (not a bug). This
    // is deliberately NOT boundary-aware — external cash is instead captured by the money-
    // weighted XIRR lens (boundaryFlows/externalFlows in routes/transactions.ts).
    // PriceSeriesKind for each instrument: equity/etf/crypto/gold → realSeries; bond/nav → flatProxy.
    function kindOf(instrId: string): PriceSeriesKind {
      const meta = instrId ? metaById.get(instrId) : undefined;
      if (!meta) return "none";
      if (meta.assetClass === "bond" || meta.assetClass === "mutual_fund") return "flatProxy";
      return "realSeries";
    }

    const todayMs = new Date(`${date}T00:00:00.000Z`).getTime();
    const tomorrowMs = todayMs + 86_400_000;
    let effectiveFlow = new (await import("decimal.js")).Decimal(0);
    for (const tx of coreTxns) {
      const exMs = tx.executedAt.getTime();
      if (exMs < todayMs || exMs >= tomorrowMs) continue;
      const { type } = tx;
      if (isTradeType(type)) {
        const cf = cashFlow(tx);
        effectiveFlow = effectiveFlow.sub(cf);
      } else if ((type === "dividend" || type === "coupon") && tx.instrumentId) {
        if (kindOf(tx.instrumentId) === "realSeries") {
          const cf = cashFlow(tx);
          effectiveFlow = effectiveFlow.sub(cf);
        }
      }
      // deposit/withdrawal/transfer/fee/interest: cash only, no MV change → not a flow (by design).
    }

    await db
      .insert(portfolioSnapshots)
      .values({
        portfolioId: p.id,
        date,
        netWorth: summary.netWorth,
        marketValue: summary.totalMarketValue,
        effectiveFlow: effectiveFlow.toString(),
        currency: p.baseCurrency,
      })
      .onConflictDoUpdate({
        target: [portfolioSnapshots.portfolioId, portfolioSnapshots.date],
        set: {
          netWorth: summary.netWorth,
          marketValue: summary.totalMarketValue,
          effectiveFlow: effectiveFlow.toString(),
          currency: p.baseCurrency,
        },
      });
    count++;
  }
  return count;
}

/**
 * Capture an intraday net-worth point (for the 1D/7D chart) for every portfolio
 * that currently holds at least one instrument whose market is open — a plain
 * insert (not upsert; many rows/portfolio/day are expected), followed by a prune
 * of rows older than the retention window. Skips entirely (no DB writes at all)
 * when no held market is open anywhere, to avoid flat overnight rows and
 * unbounded growth from a job that runs every 15 minutes.
 */
export async function recordIntradaySnapshots(
  db: DB,
  marketData: MarketDataService,
  ttlMs: number,
  now: Date = new Date(),
): Promise<number> {
  // Which instruments are held by which portfolio (mirrors refreshHeldPrices's
  // held-instruments query, but portfolio-scoped since the gate is per-portfolio).
  const held = await db
    .selectDistinct({
      portfolioId: transactions.portfolioId,
      instrumentId: transactions.instrumentId,
    })
    .from(transactions)
    .where(isNotNull(transactions.instrumentId));

  const instrumentIds = [
    ...new Set(held.map((r) => r.instrumentId).filter((x): x is string => x !== null)),
  ];
  if (instrumentIds.length === 0) return 0;

  const instrumentRows = await db
    .select({ id: instruments.id, market: instruments.market })
    .from(instruments)
    .where(inArray(instruments.id, instrumentIds));
  const marketById = new Map(instrumentRows.map((i) => [i.id, i.market]));

  const heldInstrumentsByPortfolio = new Map<string, Set<string>>();
  for (const r of held) {
    if (!r.instrumentId) continue;
    const set = heldInstrumentsByPortfolio.get(r.portfolioId) ?? new Set<string>();
    set.add(r.instrumentId);
    heldInstrumentsByPortfolio.set(r.portfolioId, set);
  }

  const openPortfolioIds = new Set<string>();
  for (const [portfolioId, instrIds] of heldInstrumentsByPortfolio) {
    for (const instrId of instrIds) {
      const market = marketById.get(instrId);
      if (market && isMarketOpen(market, now)) {
        openPortfolioIds.add(portfolioId);
        break;
      }
    }
  }
  if (openPortfolioIds.size === 0) return 0;

  const pfs = await db.select().from(portfolios);
  let count = 0;
  for (const p of pfs) {
    if (!openPortfolioIds.has(p.id)) continue;
    const { summary } = await valuePortfolio(
      db,
      marketData,
      ttlMs,
      p.id,
      p.baseCurrency,
      undefined,
      p.cashCounted,
      undefined,
      now,
    );
    await db.insert(portfolioIntradaySnapshots).values({
      portfolioId: p.id,
      capturedAt: now,
      netWorth: summary.netWorth,
      marketValue: summary.totalMarketValue,
      currency: p.baseCurrency,
    });
    count++;
  }

  await db
    .delete(portfolioIntradaySnapshots)
    .where(
      lt(portfolioIntradaySnapshots.capturedAt, new Date(now.getTime() - INTRADAY_RETENTION_MS)),
    );

  return count;
}

/**
 * Lower-bound date (YYYY-MM-DD) for a range string, or null for "all"/unknown
 * (no bound). Mirrors the ranges the instrument-history endpoint accepts.
 */
export function rangeStart(range: string, now: Date = new Date()): string | null {
  if (range === "ytd") {
    return `${now.getUTCFullYear()}-01-01`;
  }
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
  return toDateKey(d);
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
    const converted = Number(convert(r.netWorth, r.currency, displayCurrency, fxFor(r.date)));
    byDate.set(r.date, (byDate.get(r.date) ?? 0) + converted);
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, netWorth]) => ({ date, netWorth: String(netWorth) }));
}
