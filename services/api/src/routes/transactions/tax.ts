import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { accountHolders, portfolios, users } from "@portfolio/db";
import type { TradeLog } from "@portfolio/core";
import { allowanceUsageYTD, harvestSuggestions, mergeTradeLogs } from "@portfolio/core";
import {
  derivationCacheKey,
  getCachedFifoTradeLog,
  type InstrumentMeta,
} from "../../services/valuation.js";
import { mapPool } from "../../lib/promise-pool.js";

import {
  loadValuation,
  buildTradeLog,
  PORTFOLIO_VALUATION_CONCURRENCY,
  type PortfolioParams,
} from "./shared.js";
import { lossCarryForwardFor, restOfYearForecastGross, buildTfRates } from "./tax-helpers.js";

export function registerTaxRoutes(app: FastifyInstance) {
  /**
   * GET /portfolios/:portfolioId/tax
   * German Sparerpauschbetrag headroom and harvest suggestions for a single portfolio.
   * The portfolio's own `taxAllowanceAnnual` (the per-depot Freistellungsauftrag slice)
   * must be configured. The holder's capitalGainsTaxRate is used for the tax rate;
   * the holder's taxAllowanceAnnual is the per-person cap (used for the distribution
   * helper returned in the response so the edit modal can show "€X of €cap allocated").
   */
  app.get<{ Params: PortfolioParams; Querystring: { year?: string } }>(
    "/portfolios/:portfolioId/tax",
    { preHandler: [app.authenticate, app.requirePortfolio] },
    async (request, reply) => {
      const id = request.userId;
      const { portfolioId } = request.params;
      const portfolio = request.portfolio;

      if (!portfolio.taxAllowanceAnnual) {
        return reply.code(422).send({ error: "tax_allowance_not_configured" });
      }

      const now = new Date();
      const year = request.query.year ? parseInt(request.query.year, 10) : now.getUTCFullYear();

      const holderId = portfolio.accountHolderId;
      let holderProfile: {
        taxAllowanceAnnual: string | null;
        capitalGainsTaxRate: string | null;
      } | null = null;
      let totalAllocatedForHolder = Number(portfolio.taxAllowanceAnnual);
      let lossCarryForwardInput: { stock?: string; general?: string } | undefined;
      let carryForwardApplied = false;

      if (holderId) {
        const [holderResult, siblingRows, lossCarryForwardResult] = await Promise.all([
          app.db
            .select({
              taxAllowanceAnnual: accountHolders.taxAllowanceAnnual,
              capitalGainsTaxRate: accountHolders.capitalGainsTaxRate,
            })
            .from(accountHolders)
            .where(and(eq(accountHolders.id, holderId), eq(accountHolders.userId, id)))
            .limit(1),
          app.db
            .select({ taxAllowanceAnnual: portfolios.taxAllowanceAnnual })
            .from(portfolios)
            .where(and(eq(portfolios.userId, id), eq(portfolios.accountHolderId, holderId))),
          lossCarryForwardFor(app, holderId, year),
        ]);
        const [holder] = holderResult;
        if (holder) holderProfile = holder;

        totalAllocatedForHolder = siblingRows.reduce(
          (sum, p) => sum + Number(p.taxAllowanceAnnual ?? 0),
          0,
        );

        if (siblingRows.length <= 1) {
          lossCarryForwardInput = lossCarryForwardResult;
          carryForwardApplied = true;
        }
      }

      const holderAllowanceCap = Number(holderProfile?.taxAllowanceAnnual ?? 1000);
      const remainingToDistribute = Math.max(0, holderAllowanceCap - totalAllocatedForHolder);
      const overAllocated = totalAllocatedForHolder > holderAllowanceCap;

      const valuation = await loadValuation(
        app,
        portfolioId,
        portfolio.baseCurrency,
        undefined,
        portfolio.cashCounted,
      );
      const { coreTxns, prices, metaById, summary, corporateActions: cas, fxRates } = valuation;
      const cacheKey = derivationCacheKey(
        portfolioId,
        portfolio.baseCurrency,
        undefined,
        portfolio.cashCounted,
      );
      const tradeLog = await getCachedFifoTradeLog(
        cacheKey,
        coreTxns,
        prices,
        portfolio.baseCurrency,
        metaById,
        cas,
        fxRates,
      );
      const tfRates = buildTfRates(tradeLog.trades, metaById);
      const assetClasses = Object.fromEntries(
        [...metaById.entries()].map(([iid, m]) => [iid, m.assetClass]),
      );
      const allowanceAnnual = portfolio.taxAllowanceAnnual;
      const taxRate = holderProfile?.capitalGainsTaxRate ?? "0.25";

      const forecastIncomeRestOfYear = await restOfYearForecastGross(
        app,
        coreTxns,
        summary,
        portfolio.baseCurrency,
        year,
        now,
      );

      const usage = allowanceUsageYTD({
        tradeLog,
        tfRates,
        allowanceAnnual,
        taxRate,
        year,
        forecastIncomeRestOfYear,
        assetClasses,
        lossCarryForward: lossCarryForwardInput,
      });
      const suggestions = harvestSuggestions({
        tradeLog,
        tfRates,
        allowanceAnnual,
        taxRate,
        year,
        usage,
      });

      request.timingName = "GET /portfolios/:id/tax";
      request.timingMeta = {
        portfolioId,
        year,
        hasHolder: holderId != null,
        carryForwardApplied,
      };
      return {
        year,
        currency: portfolio.baseCurrency,
        allowanceUsage: usage,
        harvestSuggestions: suggestions.map((s) => ({
          ...s,
          instrument: metaById.get(s.instrumentId) ?? null,
        })),
        tfRatesByInstrument: tfRates,
        carryForwardApplied,
        holderDistribution: {
          holderAllowanceCap: holderAllowanceCap.toFixed(2),
          totalAllocated: totalAllocatedForHolder.toFixed(2),
          remainingToDistribute: remainingToDistribute.toFixed(2),
          overAllocated,
        },
      };
    },
  );

  /**
   * GET /networth/tax
   * Aggregated German tax summary across all of the user's portfolios (or filtered by
   * holderId).  Returns one entry per holder that has a `taxAllowanceAnnual` configured.
   */
  app.get<{ Querystring: { year?: string; holderId?: string } }>(
    "/networth/tax",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const id = request.userId;
      const { holderId: filterHolderId } = request.query;
      const year = request.query.year
        ? parseInt(request.query.year, 10)
        : new Date().getUTCFullYear();

      const [u] = await app.db
        .select({ displayCurrency: users.displayCurrency })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      const display = u?.displayCurrency ?? "IDR";

      if (filterHolderId != null) {
        const [holder] = await app.db
          .select()
          .from(accountHolders)
          .where(and(eq(accountHolders.id, filterHolderId), eq(accountHolders.userId, id)))
          .limit(1);
        if (!holder) return reply.status(404).send({ error: "holder_not_found" });
      }

      const holderRows = await app.db
        .select()
        .from(accountHolders)
        .where(
          filterHolderId != null
            ? and(eq(accountHolders.userId, id), eq(accountHolders.id, filterHolderId))
            : eq(accountHolders.userId, id),
        );

      const perHolderResults = await mapPool(holderRows, 2, async (holder) => {
        const pfs = await app.db
          .select({
            id: portfolios.id,
            cashCounted: portfolios.cashCounted,
            taxAllowanceAnnual: portfolios.taxAllowanceAnnual,
          })
          .from(portfolios)
          .where(and(eq(portfolios.userId, id), eq(portfolios.accountHolderId, holder.id)));

        if (pfs.length === 0) return null;

        const totalAllocated = pfs.reduce((sum, p) => sum + Number(p.taxAllowanceAnnual ?? 0), 0);
        if (totalAllocated === 0) return null;

        const now = new Date();
        const perPortfolio = await mapPool(pfs, PORTFOLIO_VALUATION_CONCURRENCY, async (p) => {
          const { coreTxns, prices, metaById, summary } = await loadValuation(
            app,
            p.id,
            display,
            undefined,
            p.cashCounted,
          );
          const log = await buildTradeLog(
            app,
            coreTxns,
            prices,
            display,
            "fifo",
            undefined,
            metaById,
          );
          const pfForecast = await restOfYearForecastGross(
            app,
            coreTxns,
            summary,
            display,
            year,
            now,
          );
          return { log, metaById, forecast: Number(pfForecast) };
        });
        const logs: TradeLog[] = perPortfolio.map((r) => r.log);
        const meta = new Map<string, InstrumentMeta>();
        let totalForecastGross = 0;
        for (const { metaById, forecast } of perPortfolio) {
          for (const [k, v] of metaById) meta.set(k, v);
          totalForecastGross += forecast;
        }
        const mergedLog = mergeTradeLogs(logs, display, "fifo");

        const tfRates = buildTfRates(mergedLog.trades, meta);
        const assetClasses = Object.fromEntries(
          [...meta.entries()].map(([iid, m]) => [iid, m.assetClass]),
        );
        const taxRate = holder.capitalGainsTaxRate ?? "0.25";
        const forecastIncomeRestOfYear =
          totalForecastGross > 0 ? totalForecastGross.toFixed(2) : "0";
        const lossCarryForward = await lossCarryForwardFor(app, holder.id, year);

        const holderAllowanceCap = Number(holder.taxAllowanceAnnual ?? 1000);
        const remainingToDistribute = Math.max(0, holderAllowanceCap - totalAllocated);
        const overAllocated = totalAllocated > holderAllowanceCap;

        const allowanceAnnual = holderAllowanceCap.toFixed(2);

        const usage = allowanceUsageYTD({
          tradeLog: mergedLog,
          tfRates,
          allowanceAnnual,
          taxRate,
          year,
          forecastIncomeRestOfYear,
          assetClasses,
          lossCarryForward,
        });
        const suggestions = harvestSuggestions({
          tradeLog: mergedLog,
          tfRates,
          allowanceAnnual,
          taxRate,
          year,
          usage,
        });

        return {
          holder: {
            id: holder.id,
            name: holder.name,
            taxAllowanceAnnual: holder.taxAllowanceAnnual,
            capitalGainsTaxRate: holder.capitalGainsTaxRate,
            churchTax: holder.churchTax,
            taxResidence: holder.taxResidence,
          },
          year,
          currency: display,
          allowanceUsage: usage,
          harvestSuggestions: suggestions.map((s) => ({
            ...s,
            instrument: meta.get(s.instrumentId) ?? null,
          })),
          tfRatesByInstrument: tfRates,
          carryForwardApplied: true,
          distribution: {
            holderAllowanceCap: holderAllowanceCap.toFixed(2),
            totalAllocated: totalAllocated.toFixed(2),
            remainingToDistribute: remainingToDistribute.toFixed(2),
            overAllocated,
          },
        };
      });
      const result = perHolderResults.filter((r): r is NonNullable<typeof r> => r != null);

      request.timingName = "GET /networth/tax";
      request.timingMeta = {
        holderCount: holderRows.length,
        year,
      };
      return result;
    },
  );
}
