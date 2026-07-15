import type { FastifyInstance } from "fastify";
import { Decimal } from "decimal.js";
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import {
  corporateActions,
  instruments,
  portfolios,
  portfolioSnapshots,
  prices,
  transactions,
  userPreferences,
  users,
} from "@portfolio/db";
import {
  type CorporateAction,
  aggregateValueFlows,
  chainIndex,
  computeHoldings,
  convert,
  dailyReturns,
  annualizedVolatility,
  sharpeRatio,
  sortinoRatio,
  streakAnalysis,
  maxDrawdown,
  splitAdjustmentFactor,
} from "@portfolio/core";
import { toCoreTxns } from "../../services/tx-core.js";
import { getFxRatesForDates, makeFxRateFn } from "../../services/fx.js";
import { getMarketData } from "../../services/market-data.js";
import {
  getUserBenchmarkConfig,
  fetchBenchmarkPrices,
  getBenchmarkPrices,
  computeBenchmarkIndex,
  computeActiveReturn,
} from "../../services/benchmark.js";
import { rangeStart } from "../../services/snapshots.js";
import { requireUser } from "../../plugins/auth.js";
import { insightsCache } from "./shared.js";
import { logTiming } from "../../lib/timing.js";
import { withDerivationCache } from "../../lib/derivation-cache.js";

export function registerInsightsRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { range?: string; holderId?: string; portfolioId?: string } }>(
    "/insights",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const { holderId, portfolioId } = request.query;
      const range = request.query.range ?? "all";

      const pfs = await app.db
        .select({ id: portfolios.id, includeInAggregate: portfolios.includeInAggregate, cashCounted: portfolios.cashCounted })
        .from(portfolios)
        .where(
          portfolioId != null
            ? and(eq(portfolios.userId, id), eq(portfolios.id, portfolioId))
            : holderId != null
              ? and(eq(portfolios.userId, id), eq(portfolios.accountHolderId, holderId))
              : eq(portfolios.userId, id),
        );
      if (pfs.length === 0) {
        return reply.send({
          drawdown: { maxDrawdownPct: "0", peakDate: null, troughDate: null, currentDrawdownPct: "0" },
          volatility: { annualizedVolatility: null, sharpeRatio: null, sortinoRatio: null },
          streaks: { bestStreak: null, worstStreak: null, bestMonth: null, worstMonth: null, bestYear: null, worstYear: null, positiveMonths: 0, negativeMonths: 0, totalMonths: 0 },
          benchmark: null,
          concentrationTrend: [],
          bestWorstMonthly: { best: null, worst: null },
          bestWorstYearly: { best: null, worst: null },
        });
      }

      const [u] = await app.db
        .select({ displayCurrency: users.displayCurrency })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      const display = u?.displayCurrency ?? "IDR";

      const cacheKey = `insights:${id}:${range}:${holderId ?? ""}:${portfolioId ?? ""}`;
      const result = await withDerivationCache(insightsCache, cacheKey, async () => {
        // ── Portfolio history (TWR index) ──────────────────────────────
        const start = rangeStart(range);
        const conds = [inArray(portfolioSnapshots.portfolioId, pfs.map((p) => p.id))];
        if (start) conds.push(gte(portfolioSnapshots.date, start));
        const snapshots = await app.db
          .select()
          .from(portfolioSnapshots)
          .where(and(...conds))
          .orderBy(asc(portfolioSnapshots.date));

        if (snapshots.length === 0) {
          return {
            drawdown: { maxDrawdownPct: "0", peakDate: null, troughDate: null, currentDrawdownPct: "0" },
            volatility: { annualizedVolatility: null, sharpeRatio: null, sortinoRatio: null },
            streaks: { bestStreak: null, worstStreak: null, bestMonth: null, worstMonth: null, bestYear: null, worstYear: null, positiveMonths: 0, negativeMonths: 0, totalMonths: 0 },
            benchmark: null,
            concentrationTrend: [],
            bestWorstMonthly: { best: null, worst: null },
            bestWorstYearly: { best: null, worst: null },
          } as const;
        }

        // Fetched up front (not just after aggregation) so its native currency can be
        // folded into the same FX rate fetch below — the benchmark's raw prices need
        // converting to `display` before indexing, same as the portfolio's own snapshots.
        const bmConfig = await getUserBenchmarkConfig(app.db, id, display);

        const currencies = [...new Set([...snapshots.map((r) => r.currency), bmConfig.currency])];
        const dates = [...new Set(snapshots.map((r) => r.date))];
        const ratesByDate = await getFxRatesForDates(app.db, currencies, display, dates);

        const perPortfolio = new Map<string, { date: string; marketValue: string; effectiveFlow: string; netWorth: string; currency: string }[]>();
        for (const r of snapshots) {
          const list = perPortfolio.get(r.portfolioId) ?? [];
          list.push(r);
          perPortfolio.set(r.portfolioId, list);
        }

        const allFlows: { date: string; marketValue: string; effectiveFlow: string }[][] = [];
        for (const [, pfRows] of perPortfolio) {
          const converted = pfRows.map((r) => {
            const fx = makeFxRateFn(ratesByDate.get(r.date) ?? {}, display);
            return {
              date: r.date,
              marketValue: convert(r.marketValue ?? "0", r.currency, display, fx),
              effectiveFlow: convert(r.effectiveFlow ?? "0", r.currency, display, fx),
            };
          });
          allFlows.push(converted);
        }

        const aggregated = aggregateValueFlows(allFlows);
        const indexed = chainIndex(aggregated);

        // ── Drawdown ───────────────────────────────────────────────────
        // Fed the cashflow-normalized TWR index (same series volatility/streaks use
        // below), not raw net worth: a deposit/withdrawal moves net worth without
        // being a real gain/loss, and would otherwise register as a phantom drawdown.
        const drawdown = maxDrawdown(indexed.map((p) => ({ date: p.date, netWorth: p.index })));

        // ── Volatility & Sharpe ────────────────────────────────────────
        const idxPoints = indexed.map((p) => ({ date: p.date, index: p.index }));
        const returns = dailyReturns(idxPoints);

        // Read risk-free rate from preference first, fall back to currency-based auto-detect
        const [rfrPref] = await app.db
          .select({ rate: userPreferences.riskFreeRate })
          .from(userPreferences)
          .where(eq(userPreferences.userId, id))
          .limit(1);
        const autoRfr: Record<string, number> = { EUR: 0.03, USD: 0.05, IDR: 0.06 };
        const riskFreeRate = Number(rfrPref?.rate ?? autoRfr[display] ?? 0.04);
        const volatility = {
          annualizedVolatility: returns.length >= 2 ? String(annualizedVolatility(returns)) : null,
          sharpeRatio: returns.length >= 2 ? String(sharpeRatio(returns, riskFreeRate)) : null,
          sortinoRatio: returns.length >= 2 ? String(sortinoRatio(returns, riskFreeRate)) : null,
        };

        // ── Streaks ────────────────────────────────────────────────────
        const streaks = streakAnalysis(idxPoints);

        // ── Benchmark comparison ───────────────────────────────────────
        let benchmark: { symbol: string; activeReturn: string; trackingError: string; correlation: string } | null = null;
        if (indexed.length > 0) {
          const bmDates = indexed.map((p) => p.date);
          const existingBm = await getBenchmarkPrices(app.db, id, bmConfig.symbol, bmDates);
          const missingDates = bmDates.filter((d) => !existingBm.has(d));
          if (missingDates.length > 0) {
            try {
              const md = await getMarketData();
              await fetchBenchmarkPrices(app.db, md, id, bmConfig.symbol, missingDates[0]);
            } catch { /* non-fatal */ }
          }
          const refreshedBm = await getBenchmarkPrices(app.db, id, bmConfig.symbol, bmDates);
          if (refreshedBm.size > 1) {
            // Convert the benchmark's raw close (native `bmConfig.currency`, e.g. USD for
            // ^GSPC) to the user's display currency before indexing — otherwise a EUR/IDR
            // portfolio's TWR index would be compared against a USD price series, injecting
            // the full USD↔display FX drift into both the active-return level and (via
            // daily diffs) the tracking error.
            let bmFxMissingDates = 0;
            const bmPrices = bmDates
              .filter((d) => refreshedBm.has(d))
              .map((d) => {
                const dayRates = ratesByDate.get(d) ?? {};
                // makeFxRateFn falls back to "1" (unconverted) for a pair it has no rate
                // for; count that so it can be flagged below instead of silently leaving
                // that day's benchmark close in its native currency.
                if (bmConfig.currency !== display && !dayRates[bmConfig.currency]) bmFxMissingDates++;
                const fx = makeFxRateFn(dayRates, display);
                return { date: d, close: convert(refreshedBm.get(d)!, bmConfig.currency, display, fx) };
              });
            if (bmFxMissingDates > 0) {
              app.log.warn(
                { userId: id, symbol: bmConfig.symbol, currency: bmConfig.currency, display, missingDates: bmFxMissingDates },
                "insights: benchmark FX rate missing for some dates — those days left unconverted",
              );
            }
            const bmIndex = computeBenchmarkIndex(bmPrices);
            const active = computeActiveReturn(
              indexed.map((p) => ({ date: p.date, pct: p.pct })),
              bmIndex.map((p) => ({ date: p.date, pct: p.pct })),
            );
            if (active) {
              benchmark = { symbol: bmConfig.symbol, ...active };
            }
          }
        }

        // ── Concentration trend (monthly, simplified) ──────────────────
        const concentrationTrend: { date: string; hhi: number; top1Pct: number; classCount: number }[] = [];
        const months = [...new Set(dates.map((d) => d.slice(0, 7)))].slice(-60);
        const pfIds = pfs.map((p) => p.id);
        type PeriodMoverResult = { instrumentId: string; symbol: string; name: string | null; assetClass: string; pct: number };
        type BestWorstPair = { best: PeriodMoverResult | null; worst: PeriodMoverResult | null };
        let bestWorstMonthly: BestWorstPair = { best: null, worst: null };
        let bestWorstYearly: BestWorstPair = { best: null, worst: null };

        if (months.length > 0) {
          const allTxRows = await app.db
            .select()
            .from(transactions)
            .where(inArray(transactions.portfolioId, pfIds));
          const instIds = [...new Set(allTxRows.filter((t) => t.instrumentId).map((t) => t.instrumentId!))];
          const allInstRows = await app.db
            .select()
            .from(instruments)
            .where(inArray(instruments.id, instIds));
          const instMap = new Map(allInstRows.map((i) => [i.id, i]));
          const corpActionRows = await app.db
            .select()
            .from(corporateActions)
            .where(inArray(corporateActions.instrumentId, instIds));
          const corpActions: CorporateAction[] = corpActionRows.map((ca) => ({
            instrumentId: ca.instrumentId,
            type: ca.type,
            ratio: ca.ratio,
            exDate: new Date(ca.exDate),
          }));

          // Fetch all prices for held instruments (≤60 months × few dozen instruments)
          const allPrices = await app.db
            .select()
            .from(prices)
            .where(inArray(prices.instrumentId, instIds))
            .orderBy(asc(prices.date));
          const pricesByInst: Map<string, { date: string; close: string }[]> = new Map();
          for (const p of allPrices) {
            const list = pricesByInst.get(p.instrumentId) ?? [];
            list.push({ date: p.date, close: p.close });
            pricesByInst.set(p.instrumentId, list);
          }
          const latestPriceBefore = (instId: string, asOfDate: string): string | null => {
            const list = pricesByInst.get(instId);
            if (!list || list.length === 0) return null;
            for (let i = list.length - 1; i >= 0; i--) {
              if (list[i].date <= asOfDate) return list[i].close;
            }
            return null;
          };

          const coreTxns = toCoreTxns(allTxRows);
          for (const month of months) {
            const monthDates = dates.filter((d) => d.startsWith(month));
            if (monthDates.length === 0) continue;
            const asOfDate = monthDates[monthDates.length - 1];
            const asOf = new Date(`${asOfDate}T23:59:59.999Z`);

            const holdings = computeHoldings(coreTxns, corpActions, asOf);

            // Compute market values using closest-known prices
            let totalMv = 0;
            const mvByInst: { mv: number; assetClass: string }[] = [];
            for (const h of holdings) {
              const qty = Number(h.quantity);
              if (qty <= 0 || !h.instrumentId) continue;
              const price = latestPriceBefore(h.instrumentId, asOfDate);
              if (!price) continue;
              const mv = qty * Number(price);
              const inst = instMap.get(h.instrumentId);
              mvByInst.push({ mv, assetClass: inst?.assetClass ?? "equity" });
              totalMv += mv;
            }

            if (totalMv > 0 && mvByInst.length > 0) {
              const fractions = mvByInst.map((x) => x.mv / totalMv);
              const hhi = fractions.reduce((sum, f) => sum + f * f, 0);
              const top1Fraction = Math.max(...fractions);
              const classes = new Set(mvByInst.map((x) => x.assetClass));

              concentrationTrend.push({
                date: month,
                hhi: Math.round(hhi * 10000) / 10000,
                top1Pct: Math.round(top1Fraction * 10000) / 100,
                classCount: classes.size,
              });
            }
          }

          // ── Period best/worst performers (MTD, YTD) ──────────────────────
          const latestDate = dates[dates.length - 1];
          const monthStart = latestDate.slice(0, 7) + "-01";
          const yearStart = latestDate.slice(0, 4) + "-01-01";
          const periodEnd = new Date(`${latestDate}T23:59:59.999Z`);

          // Require the instrument to be held at both period start and period
          // end — a recent buy or a partial exit shouldn't show the full period's
          // price swing as "your return", since part of that move happened before
          // the user owned the position (or happened on shares already sold).
          const heldAtStart = new Set(
            computeHoldings(coreTxns, corpActions, new Date(`${monthStart}T00:00:00.000Z`))
              .filter((h) => Number(h.quantity) > 0 && h.instrumentId)
              .map((h) => h.instrumentId!),
          );
          const heldAtYearStart = new Set(
            computeHoldings(coreTxns, corpActions, new Date(`${yearStart}T00:00:00.000Z`))
              .filter((h) => Number(h.quantity) > 0 && h.instrumentId)
              .map((h) => h.instrumentId!),
          );
          const heldAtEnd = new Map(
            computeHoldings(coreTxns, corpActions, periodEnd)
              .filter((h) => Number(h.quantity) > 0 && h.instrumentId)
              .map((h) => [h.instrumentId!, h]),
          );

          const computePeriodMovers = (startDate: string, heldAtStartSet: Set<string>): BestWorstPair => {
            const movers: PeriodMoverResult[] = [];
            for (const instId of heldAtEnd.keys()) {
              if (!heldAtStartSet.has(instId)) continue;
              const rawStart = latestPriceBefore(instId, startDate);
              const rawEnd = latestPriceBefore(instId, latestDate);
              if (!rawStart || !rawEnd || Number(rawStart) <= 0) continue;

              // Split-adjust both prices so a stock split or bonus inside the
              // window doesn't manufacture a phantom gain/loss.  The adjustment
              // factor is applied per-instrument per-date: each raw close is
              // divided by the cumulative factor for future splits.
              const saStart = splitAdjustmentFactor(corpActions, instId, startDate);
              const saEnd = splitAdjustmentFactor(corpActions, instId, latestDate);
              if (saStart.isZero() || saEnd.isZero()) continue;
              const adjustedStart = new Decimal(rawStart).div(saStart);
              const adjustedEnd = new Decimal(rawEnd).div(saEnd);
              const pct = adjustedEnd.div(adjustedStart).toNumber() - 1;

              const inst = instMap.get(instId);
              if (!inst) continue;
              movers.push({
                instrumentId: instId,
                symbol: inst.symbol ?? "—",
                name: inst.name,
                assetClass: inst.assetClass ?? "equity",
                pct,
              });
            }
            if (movers.length < 2) return { best: null, worst: null };
            movers.sort((a, b) => b.pct - a.pct);
            return { best: movers[0], worst: movers[movers.length - 1] };
          };

          bestWorstMonthly = computePeriodMovers(monthStart, heldAtStart);
          bestWorstYearly = computePeriodMovers(yearStart, heldAtYearStart);
        }

        return { drawdown, volatility, streaks, benchmark, concentrationTrend, bestWorstMonthly, bestWorstYearly };
      });

      const durationMs = performance.now() - t0;
      logTiming(request, "GET /insights", durationMs, {});
      return result;
    },
  );
}
