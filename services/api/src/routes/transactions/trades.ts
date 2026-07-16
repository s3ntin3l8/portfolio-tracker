import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { accountHolders, portfolios, users } from "@portfolio/db";
import { requireUser } from "../../plugins/auth.js";
import { type InstrumentMeta } from "../../services/valuation.js";
import { type TradeLog, mergeTradeLogs } from "@portfolio/core";
import { withDerivationCache } from "../../lib/derivation-cache.js";
import { logTiming } from "../../lib/timing.js";
import { mapPool } from "../../lib/promise-pool.js";
import { ownedPortfolio, cacheKey } from "../helpers.js";
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
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      const portfolio = await ownedPortfolio(app, id, portfolioId);
      if (!portfolio) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
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
      const durationMs = performance.now() - t0;
      logTiming(request, "GET /portfolios/:id/trades", durationMs, {
        portfolioId,
        method,
        costBasis: costBasisMode,
      });
      return cached;
    },
  );

  app.get<{ Querystring: { method?: string; costBasis?: string; holderId?: string } }>(
    "/networth/trades",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
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
      const durationMs = performance.now() - t0;
      logTiming(request, "GET /networth/trades", durationMs, { portfolioCount: pfs.length });
      return result;
    },
  );
}
