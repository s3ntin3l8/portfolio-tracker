import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { accountHolders, portfolios, transactions, users } from "@portfolio/db";
import { toDateKey, type CoreTransaction, aggregatePortfolios } from "@portfolio/core";
import { mapPool } from "../../lib/promise-pool.js";

import {
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
      request.timingName = "GET /networth/income";
      const id = request.userId;
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
        const { coreTxns, summary } = await loadValuation(
          app,
          p.id,
          display,
          undefined,
          p.cashCounted,
        );
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
        const meta = await instrumentMeta(app, [
          ...new Set(
            perPortfolio
              .flatMap((p) => p.coreTxns)
              .filter((t) => t.type === "dividend" || t.type === "coupon")
              .map((t) => t.instrumentId)
              .filter(Boolean),
          ),
        ] as string[]);
        const events = perPortfolio
          .flatMap((p) => p.coreTxns)
          .filter(
            (t) =>
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
              date: toDateKey(t.executedAt),
              amount: t.price,
              currency: t.currency,
              perShare: null as string | null,
              quantity: null as string | null,
            };
          })
          .sort((a, b) => b.date.localeCompare(a.date));
        request.timingName = "GET /networth/income (eventsYear)";
        request.timingMeta = {
          portfolioCount: pfs.length,
          targetYear,
          eventCount: events.length,
        };
        return { displayCurrency: display, events };
      }

      const summaries = perPortfolio.map((r) => r.summary);
      const allTxns: CoreTransaction[] = perPortfolio.flatMap((r) => r.coreTxns);
      const aggregated = aggregatePortfolios(summaries, display);

      request.timingMeta = { portfolioCount: pfs.length };

      return buildIncomeStats(app, allTxns, aggregated, display, (txId) => txPortfolioId.get(txId));
    },
  );

  app.get<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/income",
    { preHandler: [app.authenticate, app.requirePortfolio] },
    async (request, reply) => {
      const id = request.userId;
      const { portfolioId } = request.params;
      const portfolio = request.portfolio;
      const { coreTxns, summary } = await loadValuation(
        app,
        portfolioId,
        portfolio.baseCurrency,
        undefined,
        portfolio.cashCounted,
      );
      const result = buildIncomeStats(
        app,
        coreTxns,
        summary,
        portfolio.baseCurrency,
        () => portfolioId,
      );
      request.timingName = "GET /portfolios/:id/income";
      request.timingMeta = {
        portfolioId,
      };
      return result;
    },
  );

  app.get<{
    Params: PortfolioParams;
    Querystring: { year?: string };
  }>(
    "/portfolios/:portfolioId/income-year",
    { preHandler: [app.authenticate, app.requirePortfolio] },
    async (request, reply) => {
      const id = request.userId;

      const year = parseInt(request.query.year ?? String(new Date().getUTCFullYear()), 10);
      const { start, end } = yearRange(year);
      const rows = await app.db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.portfolioId, request.params.portfolioId),
            inArray(transactions.type, ACTIVITY_INCOME_TYPES),
            gte(transactions.executedAt, start),
            lt(transactions.executedAt, end),
          ),
        )
        .orderBy(desc(transactions.executedAt));

      return rows;
    },
  );
}
