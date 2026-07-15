import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { accountHolders, portfolios, transactions, users } from "@portfolio/db";
import { requireUser } from "../../plugins/auth.js";
import { type CoreTransaction, aggregatePortfolios } from "@portfolio/core";
import { logTiming } from "../../lib/timing.js";
import { mapPool } from "../../lib/promise-pool.js";
import {
  ownedPortfolio,
  instrumentMeta,
  ACTIVITY_INCOME_TYPES,
  yearRange,
  PORTFOLIO_VALUATION_CONCURRENCY,
  loadValuation,
  type PortfolioParams,
} from "./shared.js";
import { buildIncomeStats } from "./income-helpers.js";

export function registerIncomeRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { holderId?: string; eventsYear?: string } }>(
    "/networth/income",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const { holderId, eventsYear } = request.query;
      const [u] = await app.db
        .select({ displayCurrency: users.displayCurrency })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      const display = u?.displayCurrency ?? "IDR";

      if (holderId != null) {
        const [holder] = await app.db
          .select()
          .from(accountHolders)
          .where(and(eq(accountHolders.id, holderId), eq(accountHolders.userId, id)))
          .limit(1);
        if (!holder) return reply.code(404).send({ error: "holder_not_found" });
      }

      const pfs = await app.db
        .select({ id: portfolios.id, cashCounted: portfolios.cashCounted })
        .from(portfolios)
        .where(
          holderId != null
            ? and(eq(portfolios.userId, id), eq(portfolios.accountHolderId, holderId))
            : eq(portfolios.userId, id),
        );

      const perPortfolio = await mapPool(pfs, PORTFOLIO_VALUATION_CONCURRENCY, async (p) => {
        const { coreTxns, summary } = await loadValuation(app, p.id, display, undefined, p.cashCounted);
        return { portfolioId: p.id, coreTxns, summary };
      });

      const txPortfolioId = new Map<string, string>();
      for (const { portfolioId, coreTxns } of perPortfolio) {
        for (const t of coreTxns) {
          if (t.id) txPortfolioId.set(t.id, portfolioId);
        }
      }

      if (eventsYear) {
        const targetYear = parseInt(eventsYear, 10);
        const meta = await instrumentMeta(
          app,
          [...new Set(
            perPortfolio.flatMap((p) => p.coreTxns)
              .filter((t) => t.type === "dividend" || t.type === "coupon")
              .map((t) => t.instrumentId)
              .filter(Boolean),
          )] as string[],
        );
        const events = perPortfolio.flatMap((p) => p.coreTxns)
          .filter((t) =>
            (t.type === "dividend" || t.type === "coupon") &&
            t.executedAt.getUTCFullYear() === targetYear,
          )
          .map((t) => {
            const im = t.instrumentId ? meta.get(t.instrumentId) : undefined;
            return {
              transactionId: t.id ?? null,
              portfolioId: (t.id && txPortfolioId.get(t.id)) ?? null,
              instrumentId: t.instrumentId,
              symbol: im?.symbol ?? null,
              name: im?.name ?? null,
              displayName: im?.displayName ?? null,
              type: t.type,
              date: t.executedAt.toISOString().slice(0, 10),
              amount: t.price,
              currency: t.currency,
              perShare: null as string | null,
              quantity: null as string | null,
            };
          })
          .sort((a, b) => b.date.localeCompare(a.date));
        const durationMs = performance.now() - t0;
        logTiming(request, "GET /networth/income (eventsYear)", durationMs, {
          portfolioCount: pfs.length,
          targetYear,
          eventCount: events.length,
        });
        return { displayCurrency: display, events };
      }

      const summaries = perPortfolio.map((r) => r.summary);
      const allTxns: CoreTransaction[] = perPortfolio.flatMap((r) => r.coreTxns);
      const aggregated = aggregatePortfolios(summaries, display);

      const durationMs = performance.now() - t0;
      logTiming(request, "GET /networth/income", durationMs, { portfolioCount: pfs.length });

      return buildIncomeStats(app, allTxns, aggregated, display, (txId) => txPortfolioId.get(txId));
    },
  );

  app.get<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/income",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      const portfolio = await ownedPortfolio(app, id, portfolioId);
      if (!portfolio) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const { coreTxns, summary } = await loadValuation(
        app,
        portfolioId,
        portfolio.baseCurrency,
        undefined,
        portfolio.cashCounted,
      );
      const result = buildIncomeStats(app, coreTxns, summary, portfolio.baseCurrency, () => portfolioId);
      const durationMs = performance.now() - t0;
      logTiming(request, "GET /portfolios/:id/income", durationMs, {
        portfolioId,
      });
      return result;
    },
  );

  app.get<{
    Params: PortfolioParams;
    Querystring: { year?: string };
  }>(
    "/portfolios/:portfolioId/income-year",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const portfolio = await ownedPortfolio(app, id, request.params.portfolioId);
      if (!portfolio) return reply.code(404).send({ error: "portfolio_not_found" });

      const year = parseInt(request.query.year ?? String(new Date().getUTCFullYear()), 10);
      const { start, end } = yearRange(year);
      const rows = await app.db
        .select()
        .from(transactions)
        .where(and(
          eq(transactions.portfolioId, request.params.portfolioId),
          inArray(transactions.type, ACTIVITY_INCOME_TYPES),
          gte(transactions.executedAt, start),
          lt(transactions.executedAt, end),
        ))
        .orderBy(desc(transactions.executedAt));

      return rows;
    },
  );
}
