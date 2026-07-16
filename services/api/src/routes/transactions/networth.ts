import type { FastifyInstance } from "fastify";
import { and, asc, eq, gte } from "drizzle-orm";
import { accountHolders, portfolioSnapshots, portfolios, users } from "@portfolio/db";
import {
  aggregatePortfolios,
  allocationBreakdown,
  xirr,
  periodXirr,
  type CashFlowPoint,
  convert,
  toDateKey,
} from "@portfolio/core";
import { requireUser } from "../../plugins/auth.js";
import { getFxRatesForDates, makeFxRateFn } from "../../services/fx.js";
import { loadSparklines } from "../../services/sparklines.js";
import { enqueueInstrumentMetadata } from "../../services/scheduler.js";
import { needsSectorEnrichment, needsNameEnrichment } from "../../services/instrument-metadata.js";
import { logTiming } from "../../lib/timing.js";
import { mapPool } from "../../lib/promise-pool.js";
import {
  instrumentMeta,
  loadValuation,
  costBasisFromQuery,
  loadDrift,
  boundaryFlows,
  PORTFOLIO_VALUATION_CONCURRENCY,
} from "./shared.js";

export function registerNetworthRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { costBasis?: string; holderId?: string; period?: string } }>(
    "/networth",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const { holderId } = request.query;
      const [u] = await app.db
        .select({ displayCurrency: users.displayCurrency })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      const display = u?.displayCurrency ?? "IDR";
      const costBasisMode = costBasisFromQuery(request.query);

      // Period selector: ytd | 1y | 5y | max (default)
      const period = ["ytd", "1y", "5y"].includes(request.query.period ?? "")
        ? (request.query.period as "ytd" | "1y" | "5y")
        : "max";
      const today = new Date();
      let periodStart: Date | null = null;
      if (period === "ytd") {
        periodStart = new Date(today.getFullYear(), 0, 1);
      } else if (period === "1y") {
        periodStart = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
      } else if (period === "5y") {
        periodStart = new Date(today.getFullYear() - 5, today.getMonth(), today.getDate());
      }

      if (holderId != null) {
        const [holder] = await app.db
          .select()
          .from(accountHolders)
          .where(and(eq(accountHolders.id, holderId), eq(accountHolders.userId, id)))
          .limit(1);
        if (!holder) return reply.status(404).send({ error: "holder_not_found" });
      }

      const pfs = await app.db
        .select()
        .from(portfolios)
        .where(
          holderId != null
            ? and(eq(portfolios.userId, id), eq(portfolios.accountHolderId, holderId))
            : eq(portfolios.userId, id),
        );

      // Each portfolio's money-weighted flows are computed under its own boundary
      // (cash-inside vs cash-outside), then concatenated — the aggregate spans
      // portfolios with different boundaries, so there is no single boundary to pass.
      // Bounded-concurrency (see PORTFOLIO_VALUATION_CONCURRENCY): each portfolio is
      // independent, so this used to be a serial `for` await — one portfolio's DB round
      // trips blocked the next's. mapPool preserves input order, so the merge below is
      // byte-for-byte identical to the old sequential push loop.
      const perPortfolio = await mapPool(pfs, PORTFOLIO_VALUATION_CONCURRENCY, async (p) => {
        const { coreTxns, summary } = await loadValuation(
          app,
          p.id,
          display,
          costBasisMode,
          p.cashCounted,
        );
        const flows = await boundaryFlows(
          app,
          coreTxns,
          p.cashCounted ? "inside" : "outside",
          display,
        );
        return { summary, flows };
      });
      const summaries = perPortfolio.map((r) => r.summary);
      const instrumentIds = new Set<string>();
      const flows: CashFlowPoint[] = perPortfolio.flatMap((r) => r.flows);
      for (const { summary } of perPortfolio) {
        for (const h of summary.holdings) instrumentIds.add(h.instrumentId);
      }

      const aggregated = aggregatePortfolios(summaries, display);
      const meta = await instrumentMeta(app, [...instrumentIds]);
      const spark = await loadSparklines(app.db, [...instrumentIds]);
      const holdings = aggregated.holdings.map((h) => ({
        ...h,
        instrument: meta.get(h.instrumentId) ?? null,
        sparkline: spark.get(h.instrumentId),
      }));

      // Self-heal: enqueue a sector sweep if any held instrument hasn't been
      // enriched yet (or has a stale attempt). Debounced to once per 6h.
      if (needsSectorEnrichment([...meta.values()]) || needsNameEnrichment([...meta.values()])) {
        void enqueueInstrumentMetadata();
      }

      const asOf = new Date();
      flows.push({ amount: Number(aggregated.netWorth), date: asOf });
      const rate = xirr(flows);

      const allocation = allocationBreakdown(aggregated, meta);
      const drift = await loadDrift(app, id, null, allocation);

      // Period-scoped XIRR and P&L: look up the earliest snapshot per portfolio at or
      // after periodStart, FX-convert each to display currency on its own snapshot date,
      // and sum them. One query per portfolio avoids the cross-portfolio ordering hazard.
      //
      // We track the actual snapshot anchor date (not the nominal periodStart) so that
      // the flow-filter in periodXirr is aligned: flows embedded in the snapshot value
      // must not be re-added as explicit post-flows.
      let startNav: number | null = null;
      let anchorDate: Date | null = null; // actual snapshot date (may lag periodStart by a day or two)
      if (periodStart !== null && pfs.length > 0) {
        const periodStartStr = toDateKey(periodStart);
        // Per-portfolio snapshot + FX fetch is independent — bounded-concurrency instead
        // of a serial `for` await. The reduction below (sum, count, max-date) is
        // order-independent, so parallelizing the I/O doesn't change the result.
        const perPortfolio = await mapPool(pfs, PORTFOLIO_VALUATION_CONCURRENCY, async (pf) => {
          // Fetch the earliest snapshot at or after periodStart for this portfolio.
          const [snap] = await app.db
            .select()
            .from(portfolioSnapshots)
            .where(
              and(
                eq(portfolioSnapshots.portfolioId, pf.id),
                gte(portfolioSnapshots.date, periodStartStr),
              ),
            )
            .orderBy(asc(portfolioSnapshots.date))
            .limit(1);
          if (!snap) {
            // Portfolio has no snapshot at or after periodStart (brand-new or no history).
            return null;
          }
          const ratesByDate = await getFxRatesForDates(app.db, [snap.currency], display, [
            snap.date,
          ]);
          const fx = makeFxRateFn(ratesByDate.get(snap.date) ?? {}, display);
          return {
            nav: Number(convert(snap.netWorth, snap.currency, display, fx)),
            date: snap.date,
          };
        });

        let totalStartNav = 0;
        let missingPortfolios = 0;
        let latestSnapDate: string | null = null;
        for (const r of perPortfolio) {
          if (!r) {
            missingPortfolios++;
            continue;
          }
          totalStartNav += r.nav;
          // Use the latest snapshot date across all portfolios as the flow-filter anchor.
          // This ensures no portfolio's snapshot embeds flows that are then re-added.
          if (latestSnapDate === null || r.date > latestSnapDate) {
            latestSnapDate = r.date;
          }
        }
        // Only produce a startNav when all portfolios contributed — partial sums would
        // under-count the denominator and manufacture phantom period gains.
        if (missingPortfolios === 0 && latestSnapDate !== null) {
          startNav = totalStartNav;
          anchorDate = new Date(`${latestSnapDate}T00:00:00.000Z`);
        }
      }

      const currentNetWorth = Number(aggregated.netWorth);
      // flows has the terminal inflow as its last entry; strip it to get boundary-only flows.
      const boundaryOnlyFlows = flows.slice(0, -1);
      const pXirr =
        anchorDate !== null && startNav !== null
          ? periodXirr(boundaryOnlyFlows, currentNetWorth, startNav, anchorDate, asOf)
          : null;
      const periodPnL =
        anchorDate !== null && startNav !== null ? String(currentNetWorth - startNav) : null;
      const periodPnLPct =
        anchorDate !== null && startNav !== null && startNav > 0
          ? String((currentNetWorth - startNav) / startNav)
          : null;

      const durationMs = performance.now() - t0;
      logTiming(request, "GET /networth", durationMs, {
        portfolioCount: pfs.length,
        period,
        holderId: holderId ?? null,
        costBasisMode,
      });

      return {
        ...aggregated,
        holdings,
        allocation,
        ...(Object.keys(drift).length > 0 ? { drift } : {}),
        xirr: Number.isFinite(rate) ? rate : null,
        periodXirr: pXirr,
        periodPnL,
        periodPnLPct,
        period,
        portfolioCount: pfs.length,
        asOf: asOf.toISOString(),
      };
    },
  );
}
