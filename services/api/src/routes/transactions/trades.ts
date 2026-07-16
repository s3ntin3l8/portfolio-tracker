import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { accountHolders, portfolios, users } from "@portfolio/db";
import { type InstrumentMeta } from "../../services/valuation.js";
import { type TradeLog, mergeTradeLogs } from "@portfolio/core";
import { withDerivationCache } from "../../lib/derivation-cache.js";
import { mapPool } from "../../lib/promise-pool.js";
import { cacheKey } from "../helpers.js";
import type { PortfolioParams } from "./shared.js";
import {
  costBasisFromQuery,
  methodFromQuery,
  buildTradeLog,
  attachInstruments,
  tradesCache,
  networthTradesCache,
  loadValuation,
  PORTFOLIO_VALUATION_CONCURRENCY,
} from "./shared.js";

export function registerTradesRoutes(app: FastifyInstance) {
  app.get<{ Params: PortfolioParams; Querystring: { method?: string; costBasis?: string } }>(
    "/portfolios/:portfolioId/trades",
    { preHandler: [app.authenticate, app.requirePortfolio] },
    async (request, reply) => {
      const id = request.userId;
      const { portfolioId } = request.params;
      const portfolio = request.portfolio;
      const method = methodFromQuery(request.query);
      const costBasisMode = costBasisFromQuery(request.query);
      const cached = await withDerivationCache(
        tradesCache,
        cacheKey(portfolioId, method, costBasisMode),
        async () => {
          const { coreTxns, prices, metaById } = await loadValuation(
            app,
            portfolioId,
            portfolio.baseCurrency,
            costBasisMode,
            portfolio.cashCounted,
          );
          const log = await buildTradeLog(
            app,
            coreTxns,
            prices,
            portfolio.baseCurrency,
            method,
            costBasisMode,
            metaById,
          );
          return attachInstruments(log, metaById);
        },
      );
      request.timingName = "GET /portfolios/:id/trades";
      request.timingMeta = {
        portfolioId,
        method,
        costBasis: costBasisMode,
      };
      return cached;
    },
  );

  app.get<{ Querystring: { method?: string; costBasis?: string; holderId?: string } }>(
    "/networth/trades",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const id = request.userId;
      const { holderId } = request.query;
      const method = methodFromQuery(request.query);
      const costBasisMode = costBasisFromQuery(request.query);

      if (holderId != null) {
        const [holder] = await app.db
          .select()
          .from(accountHolders)
          .where(and(eq(accountHolders.id, holderId), eq(accountHolders.userId, id)))
          .limit(1);
        if (!holder) return reply.status(404).send({ error: "holder_not_found" });
      }

      const pfs = await app.db
        .select({ id: portfolios.id, cashCounted: portfolios.cashCounted })
        .from(portfolios)
        .where(
          holderId != null
            ? and(eq(portfolios.userId, id), eq(portfolios.accountHolderId, holderId))
            : eq(portfolios.userId, id),
        );

      const result = await withDerivationCache(
        networthTradesCache,
        cacheKey(id, method, costBasisMode, holderId ?? ""),
        async () => {
          const [u] = await app.db
            .select({ displayCurrency: users.displayCurrency })
            .from(users)
            .where(eq(users.id, id))
            .limit(1);
          const display = u?.displayCurrency ?? "IDR";

          const perPortfolio = await mapPool(pfs, PORTFOLIO_VALUATION_CONCURRENCY, async (p) => {
            const { coreTxns, prices, metaById } = await loadValuation(
              app,
              p.id,
              display,
              costBasisMode,
              p.cashCounted,
            );
            const log = await buildTradeLog(
              app,
              coreTxns,
              prices,
              display,
              method,
              costBasisMode,
              metaById,
            );
            return { log, metaById };
          });
          const logs: TradeLog[] = perPortfolio.map((r) => r.log);
          const meta = new Map<string, InstrumentMeta>();
          for (const { metaById } of perPortfolio) {
            for (const [k, v] of metaById) meta.set(k, v);
          }
          return attachInstruments(mergeTradeLogs(logs, display, method), meta);
        },
      );
      request.timingName = "GET /networth/trades";
      request.timingMeta = { portfolioCount: pfs.length };
      return result;
    },
  );
}
