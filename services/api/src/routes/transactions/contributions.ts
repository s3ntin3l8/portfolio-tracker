import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { accountHolders, portfolios, users, userPreferences } from "@portfolio/db";
import { getFxRates, makeFxRateFn } from "../../services/fx.js";
import {
  type CoreTransaction,
  type PortfolioSummary,
  mergeContributionStats,
  aggregatePortfolios,
  contributionStats,
  type CashFlowPoint,
} from "@portfolio/core";
import { cacheKey } from "../helpers.js";
import type { PortfolioParams } from "./shared.js";
import {
  buildContributions,
  boundaryFlows,
  loadValuation,
  networthContributionsCache,
  enrichContributions,
  PORTFOLIO_VALUATION_CONCURRENCY,
} from "./shared.js";
import { mapPool } from "../../lib/promise-pool.js";
import { withDerivationCache } from "../../lib/derivation-cache.js";

export function registerContributionsRoutes(app: FastifyInstance) {
  // Contribution analytics for a single portfolio (in its base currency).
  app.get<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/contributions",
    { preHandler: [app.authenticate, app.requirePortfolio] },
    async (request, reply) => {
      const id = request.userId;
      const { portfolioId } = request.params;
      const portfolio = request.portfolio;
      const [pref] = await app.db
        .select({ retirementAge: userPreferences.retirementAge })
        .from(userPreferences)
        .where(eq(userPreferences.userId, id))
        .limit(1);
      const { coreTxns, summary } = await loadValuation(
        app,
        portfolioId,
        portfolio.baseCurrency,
        undefined,
        portfolio.cashCounted,
      );
      const result = buildContributions(
        app,
        coreTxns,
        summary,
        portfolio.baseCurrency,
        portfolio.birthYear,
        portfolio.portfolioType === "child" ? "child" : "standard",
        portfolio.cashCounted ? "inside" : "outside",
        pref?.retirementAge ?? null,
      );
      request.timingName = "GET /portfolios/:id/contributions";
      request.timingMeta = { portfolioId };
      return result;
    },
  );

  // Aggregate contribution analytics across all of the user's portfolios (or a holder
  // subset), in their display currency. Optional `holderId` narrows the result to
  // portfolios linked to that account holder and seeds `birthYear`/`portfolioType` from
  // the holder so the child-savings forecast panel works correctly.
  app.get<{ Querystring: { holderId?: string } }>(
    "/networth/contributions",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const id = request.userId;
      const { holderId } = request.query;
      const [u] = await app.db
        .select({ displayCurrency: users.displayCurrency })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      const display = u?.displayCurrency ?? "IDR";

      const [prefs] = await app.db
        .select({ retirementAge: userPreferences.retirementAge })
        .from(userPreferences)
        .where(eq(userPreferences.userId, id))
        .limit(1);
      const retirementAge = prefs?.retirementAge ?? null;

      let holderBirthYear: number | null = null;
      let holderPortfolioType: "standard" | "child" = "standard";
      if (holderId != null) {
        const [holder] = await app.db
          .select()
          .from(accountHolders)
          .where(and(eq(accountHolders.id, holderId), eq(accountHolders.userId, id)))
          .limit(1);
        if (!holder) return reply.code(404).send({ error: "holder_not_found" });
        holderBirthYear = holder.birthYear;
        holderPortfolioType = holder.type === "child" ? "child" : "standard";
      } else {
        // Default to the "self" holder's birth year for the all-portfolios view.
        const [selfHolder] = await app.db
          .select({ birthYear: accountHolders.birthYear })
          .from(accountHolders)
          .where(and(eq(accountHolders.userId, id), eq(accountHolders.type, "self")))
          .limit(1);
        holderBirthYear = selfHolder?.birthYear ?? null;
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
        networthContributionsCache,
        cacheKey(id, display, holderId ?? ""),
        async () => {
          const perPortfolioLoad = await mapPool(
            pfs,
            PORTFOLIO_VALUATION_CONCURRENCY,
            async (p) => {
              const { coreTxns, summary } = await loadValuation(
                app,
                p.id,
                display,
                undefined,
                p.cashCounted,
              );
              return {
                summary,
                txns: coreTxns,
                boundary: p.cashCounted ? ("inside" as const) : ("outside" as const),
              };
            },
          );
          const summaries: PortfolioSummary[] = perPortfolioLoad.map((r) => r.summary);
          const loaded: { txns: CoreTransaction[]; boundary: "inside" | "outside" }[] =
            perPortfolioLoad.map((r) => ({ txns: r.txns, boundary: r.boundary }));
          const allTxns: CoreTransaction[] = perPortfolioLoad.flatMap((r) => r.txns);
          const fx = makeFxRateFn(
            await getFxRates(app.db, [...new Set(allTxns.map((t) => t.currency))], display),
            display,
          );
          const perPortfolio = loaded.map(({ txns, boundary }) =>
            contributionStats({ txns, displayCurrency: display, fx, boundary }),
          );
          const flowsByPortfolio = await mapPool(
            loaded,
            PORTFOLIO_VALUATION_CONCURRENCY,
            ({ txns, boundary }) => boundaryFlows(app, txns, boundary, display),
          );
          const flows: CashFlowPoint[] = flowsByPortfolio.flat();
          const aggregated = aggregatePortfolios(summaries, display);
          return enrichContributions(
            mergeContributionStats(perPortfolio, display),
            aggregated.netWorth,
            flows,
            holderBirthYear,
            holderPortfolioType,
            { retirementAge },
          );
        },
      );
      request.timingName = "GET /networth/contributions";
      request.timingMeta = { portfolioCount: pfs.length };
      return result;
    },
  );
}
