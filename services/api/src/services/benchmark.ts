import { and, eq, inArray } from "drizzle-orm";
import { benchmarkPrices, userPreferences } from "@portfolio/db";
import { chainIndex, type DailyValueFlow } from "@portfolio/core";
import type { MarketDataService } from "@portfolio/market-data";
import type { DB } from "../db/client.js";

export interface BenchmarkIndexPoint {
  date: string;
  index: string;
  pct: string;
}

export interface BenchmarkConfig {
  symbol: string;
  currency: string;
}

const DEFAULT_BENCHMARK_SYMBOL = "^GSPC";
const DEFAULT_BENCHMARK_CURRENCY = "USD";

export async function getUserBenchmarkConfig(
  db: DB,
  userId: string,
  _displayCurrency: string,
): Promise<{ symbol: string; currency: string }> {
  const [prefs] = await db
    .select({ symbol: userPreferences.benchmarkSymbol })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  const symbol = prefs?.symbol || DEFAULT_BENCHMARK_SYMBOL;
  return { symbol, currency: DEFAULT_BENCHMARK_CURRENCY };
}

export async function fetchBenchmarkPrices(
  db: DB,
  marketData: MarketDataService,
  userId: string,
  symbol: string,
  fromDate: string,
): Promise<void> {
  const ref = { symbol, market: "US", assetClass: "equity" as const, currency: DEFAULT_BENCHMARK_CURRENCY };
  const candles = await marketData.getHistoryFrom(ref, fromDate);
  if (!candles || candles.length === 0) return;

  const existing = new Map<string, boolean>();
  const rows = await db
    .select({ date: benchmarkPrices.date })
    .from(benchmarkPrices)
    .where(and(eq(benchmarkPrices.userId, userId), eq(benchmarkPrices.symbol, symbol)));
  for (const r of rows) {
    existing.set(r.date, true);
  }

  for (const c of candles) {
    if (existing.has(c.date)) continue;
    await db.insert(benchmarkPrices).values({
      userId,
      symbol,
      date: c.date,
      close: c.close,
      currency: c.currency ?? DEFAULT_BENCHMARK_CURRENCY,
      source: "yahoo",
    }).onConflictDoNothing({ target: [benchmarkPrices.userId, benchmarkPrices.symbol, benchmarkPrices.date] });
  }
}

export async function getBenchmarkPrices(
  db: DB,
  userId: string,
  symbol: string,
  dates: string[],
): Promise<Map<string, string>> {
  if (dates.length === 0) return new Map();
  const rows = await db
    .select({ date: benchmarkPrices.date, close: benchmarkPrices.close })
    .from(benchmarkPrices)
    .where(
      and(
        eq(benchmarkPrices.userId, userId),
        eq(benchmarkPrices.symbol, symbol),
        inArray(benchmarkPrices.date, dates),
      ),
    )
    .orderBy(benchmarkPrices.date);
  const map = new Map<string, string>();
  for (const r of rows) {
    map.set(r.date, r.close);
  }
  return map;
}

export function computeBenchmarkIndex(
  prices: { date: string; close: string }[],
): BenchmarkIndexPoint[] {
  if (prices.length === 0) return [];

  const dailyFlows: DailyValueFlow[] = prices.map((p) => ({
    date: p.date,
    marketValue: p.close,
    effectiveFlow: "0",
  }));

  const indexed = chainIndex(dailyFlows);
  return indexed.map((p) => ({ date: p.date, index: p.index, pct: p.pct }));
}

export function computeActiveReturn(
  portfolioIndex: { date: string; pct: string }[],
  benchmarkIndex: { date: string; pct: string }[],
): { activeReturn: string; trackingError: string; correlation: string } | null {
  if (portfolioIndex.length === 0 || benchmarkIndex.length === 0) return null;

  const bmByDate = new Map(benchmarkIndex.map((p) => [p.date, Number(p.pct)]));
  const raw: { pf: number; bm: number }[] = [];
  for (const p of portfolioIndex) {
    const bmPct = bmByDate.get(p.date);
    if (bmPct !== undefined) {
      raw.push({ pf: Number(p.pct), bm: bmPct });
    }
  }
  if (raw.length < 2) return null;

  // `portfolioIndex`/`benchmarkIndex` are each chained from their OWN first element
  // (chainIndex's base), which don't necessarily coincide with the first date they
  // both actually have data for — e.g. the portfolio's earliest snapshot falling on a
  // weekend/holiday the benchmark market was closed, or benchmark history not yet
  // backfilled all the way to the portfolio's start. Left uncorrected, "pfFinal -
  // bmFinal" would compare the portfolio's return since ITS base against the
  // benchmark's return since a DIFFERENT (later) base — an apples-to-oranges number
  // that can be wildly wrong. Rebase both series to their first common date so every
  // downstream figure (active return, tracking error, correlation) measures the same
  // window for both.
  const pfBase = raw[0].pf;
  const bmBase = raw[0].bm;
  const rebase = (pct: number, base: number) => ((1 + pct / 100) / (1 + base / 100) - 1) * 100;
  const common = raw.map(({ pf, bm }) => ({ pf: rebase(pf, pfBase), bm: rebase(bm, bmBase) }));

  // Active return = portfolio total return - benchmark total return (at end of series)
  const pfFinal = common[common.length - 1].pf;
  const bmFinal = common[common.length - 1].bm;
  const activeReturn = pfFinal - bmFinal;

  // Tracking error = stddev of daily return differences
  const diffs: number[] = [];
  for (let i = 1; i < common.length; i++) {
    const pfDailyRet = common[i].pf - common[i - 1].pf;
    const bmDailyRet = common[i].bm - common[i - 1].bm;
    diffs.push(pfDailyRet - bmDailyRet);
  }

  if (diffs.length < 2) return null;

  const meanDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const variance = diffs.reduce((acc, d) => acc + (d - meanDiff) ** 2, 0) / (diffs.length - 1);
  const trackingError = Math.sqrt(variance) * Math.sqrt(252);

  // Correlation = Pearson's r between portfolio and benchmark daily returns
  const pfRets: number[] = [];
  const bmRets: number[] = [];
  for (let i = 1; i < common.length; i++) {
    pfRets.push(common[i].pf - common[i - 1].pf);
    bmRets.push(common[i].bm - common[i - 1].bm);
  }

  const meanPf = pfRets.reduce((a, b) => a + b, 0) / pfRets.length;
  const meanBm = bmRets.reduce((a, b) => a + b, 0) / bmRets.length;
  let cov = 0;
  let varPf = 0;
  let varBm = 0;
  for (let i = 0; i < pfRets.length; i++) {
    const dPf = pfRets[i] - meanPf;
    const dBm = bmRets[i] - meanBm;
    cov += dPf * dBm;
    varPf += dPf ** 2;
    varBm += dBm ** 2;
  }
  const correlation = varPf > 0 && varBm > 0 ? cov / Math.sqrt(varPf * varBm) : 0;

  // `pf`/`bm` (and thus activeReturn/trackingError above) are in percentage-POINT
  // units, because chainIndex's `pct` is already ×100 (e.g. 12.5 meaning +12.5%).
  // Divide by 100 here so both come out as fractions, matching every other rate the
  // API returns (and what the web card's formatPercent — an Intl percent formatter
  // that itself multiplies by 100 — expects). Correlation is a dimensionless Pearson
  // r and is scale-invariant, so it's returned as-is.
  return {
    activeReturn: String(activeReturn / 100),
    trackingError: String(trackingError / 100),
    correlation: String(correlation),
  };
}
