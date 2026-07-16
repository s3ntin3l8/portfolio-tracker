import type { FastifyInstance } from "fastify";
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import {
  accountHolders,
  portfolios,
  users,
  portfolioIntradaySnapshots,
  portfolioSnapshots,
} from "@portfolio/db";
import { getFxRates, getFxRatesForDates, makeFxRateFn } from "../../services/fx.js";
import { getMarketData } from "../../services/market-data.js";
import { rangeStart } from "../../services/snapshots.js";
import { aggregateValueFlows, xirr, chainIndex, convert } from "@portfolio/core";
import { cacheKey } from "../helpers.js";
import type { PortfolioParams } from "./shared.js";
import { loadValuation, historyCache, performanceCache, boundaryFlows } from "./shared.js";
import { withDerivationCache } from "../../lib/derivation-cache.js";
import {
  getUserBenchmarkConfig,
  fetchBenchmarkPrices,
  getBenchmarkPrices,
  computeBenchmarkIndex,
} from "../../services/benchmark.js";

export function registerHistoryRoutes(app: FastifyInstance) {
  // Net-worth-over-time for one portfolio, from the daily snapshots (base currency).
  app.get<{ Params: PortfolioParams; Querystring: { range?: string } }>(
    "/portfolios/:portfolioId/history",
    { preHandler: [app.authenticate, app.requirePortfolio] },
    async (request, reply) => {
      request.timingName = "GET /portfolios/:id/history";
      const id = request.userId;
      const { portfolioId } = request.params;
      const range = request.query.range ?? "1y";

      // 1D/7D: read the intraday (timestamped) table instead of the day-grained one.
      // No stored intraday history exists to backfill — this is prospective-only, so an
      // empty array is a normal, expected response until the capture job has run.
      if (range === "1d" || range === "7d") {
        const since = new Date(Date.now() - (range === "1d" ? 1 : 7) * 86_400_000);
        const rows = await app.db
          .select()
          .from(portfolioIntradaySnapshots)
          .where(
            and(
              eq(portfolioIntradaySnapshots.portfolioId, portfolioId),
              gte(portfolioIntradaySnapshots.capturedAt, since),
            ),
          )
          .orderBy(asc(portfolioIntradaySnapshots.capturedAt));
        request.timingMeta = {
          portfolioId,
          range,
          pointCount: rows.length,
        };
        return rows.map((r) => ({
          at: r.capturedAt.toISOString(),
          netWorth: r.netWorth,
          marketValue: r.marketValue ?? "0",
        }));
      }

      const start = rangeStart(range);
      const conds = [eq(portfolioSnapshots.portfolioId, portfolioId)];
      if (start) conds.push(gte(portfolioSnapshots.date, start));
      const rows = await app.db
        .select()
        .from(portfolioSnapshots)
        .where(and(...conds))
        .orderBy(asc(portfolioSnapshots.date));

      // Compute TWR chain from stored (marketValue, effectiveFlow) pairs.
      const series = rows.map((r) => ({
        date: r.date,
        marketValue: r.marketValue ?? "0",
        effectiveFlow: r.effectiveFlow ?? "0",
      }));
      const indexed = chainIndex(series);
      const indexById = new Map(indexed.map((p) => [p.date, p]));

      const result = rows.map((r) => ({
        date: r.date,
        netWorth: r.netWorth,
        marketValue: r.marketValue ?? "0",
        index: indexById.get(r.date)?.index ?? "100",
        pct: indexById.get(r.date)?.pct ?? "0",
      }));
      request.timingMeta = {
        portfolioId,
        range,
        pointCount: rows.length,
      };
      return result;
    },
  );

  // Money-weighted return (XIRR) from external cash flows + current net worth.
  app.get<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/performance",
    { preHandler: [app.authenticate, app.requirePortfolio] },
    async (request, reply) => {
      const id = request.userId;
      const { portfolioId } = request.params;
      const portfolio = request.portfolio;
      const boundary = portfolio.cashCounted ? "inside" : "outside";
      const cached = await withDerivationCache(
        performanceCache,
        `${portfolioId}:${boundary}`,
        async () => {
          const { coreTxns, summary } = await loadValuation(
            app,
            portfolioId,
            portfolio.baseCurrency,
            undefined,
            portfolio.cashCounted,
          );

          const flows = await boundaryFlows(app, coreTxns, boundary, portfolio.baseCurrency);
          const asOf = new Date();
          flows.push({ amount: Number(summary.netWorth), date: asOf });

          const rate = xirr(flows);
          return {
            xirr: Number.isFinite(rate) ? rate : null,
            netWorth: summary.netWorth,
            asOf: asOf.toISOString(),
          };
        },
      );
      request.timingName = "GET /portfolios/:id/performance";
      request.timingMeta = {
        portfolioId,
      };
      return cached;
    },
  );

  // Aggregate net-worth-over-time across all of the user's portfolios, summing each
  // day's snapshots converted to the display currency.
  app.get<{
    Querystring: { range?: string; include?: string; exclude?: string; holderId?: string };
  }>("/networth/history", { preHandler: app.authenticate }, async (request, reply) => {
    const id = request.userId;
    const { holderId } = request.query;
    const range = request.query.range ?? "1y";
    const includeParam = request.query.include ?? "";
    const excludeParam = request.query.exclude ?? "";

    if (holderId != null) {
      const [holder] = await app.db
        .select()
        .from(accountHolders)
        .where(and(eq(accountHolders.id, holderId), eq(accountHolders.userId, id)))
        .limit(1);
      if (!holder) return reply.status(404).send({ error: "holder_not_found" });
    }

    const pfs = await app.db
      .select({ id: portfolios.id, includeInAggregate: portfolios.includeInAggregate })
      .from(portfolios)
      .where(
        holderId != null
          ? and(eq(portfolios.userId, id), eq(portfolios.accountHolderId, holderId))
          : eq(portfolios.userId, id),
      );
    if (pfs.length === 0) return [];

    const pfIds = (() => {
      const inc = includeParam.split(",").filter(Boolean);
      const exc = excludeParam.split(",").filter(Boolean);
      if (inc.length > 0) {
        return pfs.filter((p) => inc.includes(p.id)).map((p) => p.id);
      }
      return pfs.filter((p) => p.includeInAggregate && !exc.includes(p.id)).map((p) => p.id);
    })();
    if (pfIds.length === 0) return [];

    const [u] = await app.db
      .select({ displayCurrency: users.displayCurrency })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    const display = u?.displayCurrency ?? "IDR";

    const ck = cacheKey(id, range, holderId ?? "", includeParam, excludeParam);
    const cached = await withDerivationCache(historyCache, ck, async () => {
      // 1D/7D: aggregate the intraday (timestamped) table instead of the day-grained one.
      if (range === "1d" || range === "7d") {
        const since = new Date(Date.now() - (range === "1d" ? 1 : 7) * 86_400_000);
        const rows = await app.db
          .select()
          .from(portfolioIntradaySnapshots)
          .where(
            and(
              inArray(portfolioIntradaySnapshots.portfolioId, pfIds),
              gte(portfolioIntradaySnapshots.capturedAt, since),
            ),
          )
          .orderBy(asc(portfolioIntradaySnapshots.capturedAt));
        if (rows.length === 0) return [];

        const currencies = [...new Set(rows.map((r) => r.currency))];
        const fx = makeFxRateFn(await getFxRates(app.db, currencies, display), display);

        const byAt = new Map<string, { netWorth: number; marketValue: number }>();
        for (const r of rows) {
          const at = r.capturedAt.toISOString();
          const entry = byAt.get(at) ?? { netWorth: 0, marketValue: 0 };
          entry.netWorth += Number(convert(r.netWorth, r.currency, display, fx));
          entry.marketValue += Number(convert(r.marketValue ?? "0", r.currency, display, fx));
          byAt.set(at, entry);
        }
        return [...byAt.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([at, v]) => ({
            at,
            netWorth: String(v.netWorth),
            marketValue: String(v.marketValue),
          }));
      }

      const start = rangeStart(range);
      const conds = [inArray(portfolioSnapshots.portfolioId, pfIds)];
      if (start) conds.push(gte(portfolioSnapshots.date, start));
      const rows = await app.db
        .select()
        .from(portfolioSnapshots)
        .where(and(...conds))
        .orderBy(asc(portfolioSnapshots.date));

      const currencies = [...new Set(rows.map((r) => r.currency))];
      const dates = [...new Set(rows.map((r) => r.date))];
      const ratesByDate = await getFxRatesForDates(app.db, currencies, display, dates);

      const perPortfolio = new Map<
        string,
        {
          date: string;
          marketValue: string;
          effectiveFlow: string;
          netWorth: string;
          currency: string;
        }[]
      >();
      for (const r of rows) {
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
      const indexById = new Map(indexed.map((p) => [p.date, p]));

      const nwByDate = new Map<string, number>();
      for (const r of rows) {
        const fx = makeFxRateFn(ratesByDate.get(r.date) ?? {}, display);
        const nw = Number(convert(r.netWorth, r.currency, display, fx));
        nwByDate.set(r.date, (nwByDate.get(r.date) ?? 0) + nw);
      }

      const result = aggregated.map((p) => ({
        date: p.date,
        netWorth: String(nwByDate.get(p.date) ?? 0),
        marketValue: p.marketValue,
        index: indexById.get(p.date)?.index ?? "100",
        pct: indexById.get(p.date)?.pct ?? "0",
      }));

      // Benchmark comparison: fetch prices and compute parallel TWR index.
      const bmConfig = await getUserBenchmarkConfig(app.db, id, display);
      if (result.length > 0) {
        const bmDates = result.map((p) => p.date);
        const existingBm = await getBenchmarkPrices(app.db, id, bmConfig.symbol, bmDates);
        const missingDates = bmDates.filter((d) => !existingBm.has(d));
        if (missingDates.length > 0) {
          const earliest = missingDates[0];
          try {
            const md = await getMarketData();
            await fetchBenchmarkPrices(app.db, md, id, bmConfig.symbol, earliest);
          } catch {
            /* non-fatal — benchmark is best-effort */
          }
        }
        const refreshedBm = await getBenchmarkPrices(app.db, id, bmConfig.symbol, bmDates);
        if (refreshedBm.size > 1) {
          const bmPrices = bmDates
            .filter((d) => refreshedBm.has(d))
            .map((d) => ({ date: d, close: refreshedBm.get(d)! }));
          const bmIndex = computeBenchmarkIndex(bmPrices);
          const bmById = new Map(bmIndex.map((p) => [p.date, p]));
          for (const p of result) {
            const bp = bmById.get(p.date);
            if (bp) {
              (p as { benchmarkIndex?: string; benchmarkPct?: string }).benchmarkIndex = bp.index;
              (p as { benchmarkIndex?: string; benchmarkPct?: string }).benchmarkPct = bp.pct;
            }
          }
        }
      }

      return result;
    });
    request.timingName = "GET /networth/history";
    request.timingMeta = {
      portfolioCount: cached.length,
      range,
      resultCount: cached.length,
    };
    return cached;
  });
}
