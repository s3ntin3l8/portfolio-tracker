import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  accountHolders,
  allocationTargets,
  portfolios,
  userPreferences,
  users,
} from "@portfolio/db";
import { getFxRates, makeFxRateFn } from "../../services/fx.js";
import {
  type SparplanStats,
  mergeSparplanStats,
  detectSparplans,
  rebalancingDrift,
  rebalancingTrades,
  contributionSplit,
  allowanceUsageYTD,
  harvestSuggestions,
  type DriftRow,
  type TradeAction,
} from "@portfolio/core";
import { cacheKey } from "../helpers.js";
import type { PortfolioParams } from "./shared.js";
import {
  loadValuation,
  buildSparplanStats,
  buildTradeLog,
  instrumentMeta,
  sparplanCache,
  networthSparplanCache,
  PORTFOLIO_VALUATION_CONCURRENCY,
} from "./shared.js";
import { mapPool } from "../../lib/promise-pool.js";
import { withDerivationCache } from "../../lib/derivation-cache.js";

export function registerSparplanRoutes(app: FastifyInstance) {
  // Sparplan detection for a single portfolio (in its base currency).
  app.get<{ Params: PortfolioParams; Querystring: { includeSales?: string } }>(
    "/portfolios/:portfolioId/sparplan",
    { preHandler: [app.authenticate, app.requirePortfolio] },
    async (request, reply) => {
      request.timingName = "GET /portfolios/:id/sparplan";
      const id = request.userId;
      const { portfolioId } = request.params;
      const includeSales = request.query.includeSales === "true";
      const portfolio = request.portfolio;
      const { coreTxns, summary, prices, metaById } = await loadValuation(
        app,
        portfolioId,
        portfolio.baseCurrency,
        undefined,
        portfolio.cashCounted,
      );
      const stats = await withDerivationCache(
        sparplanCache,
        cacheKey(portfolioId, portfolio.cashCounted ? "inside" : "outside"),
        () => buildSparplanStats(app, coreTxns, portfolio.baseCurrency),
      );

      // Phase B: load instrument targets and compute drift + contribution split.
      const targetRows = await app.db
        .select()
        .from(allocationTargets)
        .where(
          and(
            eq(allocationTargets.userId, id),
            eq(allocationTargets.portfolioId, portfolioId),
            eq(allocationTargets.dimension, "instrument"),
          ),
        );

      if (targetRows.length === 0) {
        request.timingMeta = { portfolioId, hasTargets: false };
        return stats;
      }

      // Build a market-value map from summary holdings keyed by instrumentId.
      const valueByInstrument = new Map<string, string>();
      for (const h of summary.holdings) {
        if (h.marketValueDisplay !== null) {
          valueByInstrument.set(h.instrumentId, h.marketValueDisplay);
        } else {
          valueByInstrument.set(h.instrumentId, h.costBasisDisplay);
        }
      }

      const targets = targetRows.map((r) => ({
        key: r.targetKey,
        targetPct: Number(r.targetPct),
      }));

      // Compute total value across only the targeted instruments to normalise pct
      // correctly: targets sum to 100 over the targeted sleeves, so actual pct must too.
      const targetedIds = new Set(targets.map((t) => t.key));
      const targetedTotal = [...targetedIds].reduce((acc, key) => {
        return acc + Number(valueByInstrument.get(key) ?? "0");
      }, 0);

      // Build AllocationSlice-compatible objects with pct normalised over targeted total.
      const slices = targets.map((t) => {
        const value = valueByInstrument.get(t.key) ?? "0";
        const pct = targetedTotal > 0 ? (Number(value) / targetedTotal) * 100 : 0;
        return { key: t.key, value, pct };
      });

      const drift: DriftRow[] = rebalancingDrift(slices, targets);

      // Contribution split: allocate `activeMonthlyTotalDisplay` across sleeves.
      const sleeves = targets.map((t) => ({
        key: t.key,
        value: valueByInstrument.get(t.key) ?? "0",
        targetPct: t.targetPct,
      }));
      const split = contributionSplit(sleeves, stats.activeMonthlyTotalDisplay);

      // Phase D: tax-aware trade recommendations when ?includeSales=true.
      if (!includeSales) {
        request.timingMeta = { portfolioId, hasTargets: true, includeSales: false };
        return { ...stats, drift, contributionSplit: split };
      }

      // The global tax regime decides whether the German FSA/harvest-cap logic below
      // even applies. Read it BEFORE the `taxAllowanceAnnual` guard — an Indonesian
      // user will almost never have an FSA configured, so if that guard ran first
      // (as it originally did) it would always early-return `taxUnavailable: true`
      // and the ID branch below would never execute.
      const [prefsRow] = await app.db
        .select({ taxRegime: userPreferences.taxRegime })
        .from(userPreferences)
        .where(eq(userPreferences.userId, id))
        .limit(1);
      const taxRegime = prefsRow?.taxRegime ?? "DE";

      if (taxRegime === "ID") {
        // Indonesian final tax has no allowance/FSA concept to cap sells against —
        // emit uncapped trade recommendations straight from the drift, skip the
        // FSA-required check entirely, and don't return `allowanceUsed`/
        // `taxUnavailable` (the frontend gates those German-only figures on their
        // absence).
        const tradeActions: TradeAction[] = rebalancingTrades(drift, String(targetedTotal), {
          mode: "trade",
        });
        request.timingMeta = {
          portfolioId,
          hasTargets: true,
          includeSales: true,
          taxRegime: "ID",
        };
        return { ...stats, drift, contributionSplit: split, tradeActions, taxRegime };
      }

      // Fetch the portfolio's holder tax profile for the personal tax rate.
      // The FSA slice (Freistellungsauftrag allocation) lives on the portfolio itself.
      const holderId = portfolio.accountHolderId;
      let holderTaxRate: string | null = null;

      if (holderId) {
        const [holder] = await app.db
          .select({ capitalGainsTaxRate: accountHolders.capitalGainsTaxRate })
          .from(accountHolders)
          .where(and(eq(accountHolders.id, holderId), eq(accountHolders.userId, id)))
          .limit(1);
        if (holder) holderTaxRate = holder.capitalGainsTaxRate;
      }

      if (!portfolio.taxAllowanceAnnual) {
        request.timingMeta = {
          portfolioId,
          hasTargets: true,
          includeSales: true,
          taxRegime: prefsRow?.taxRegime ?? "DE",
          fsaConfigured: false,
        };
        return { ...stats, drift, contributionSplit: split, taxUnavailable: true, taxRegime };
      }

      // Compute harvest suggestions using FIFO trade log.
      const tradeLog = await buildTradeLog(
        app,
        coreTxns,
        prices,
        portfolio.baseCurrency,
        "fifo",
        undefined,
        metaById,
      );
      const tfRates: Record<string, string> = {};
      for (const t of tradeLog.trades) {
        const meta = metaById.get(t.instrumentId);
        if (!meta) continue;
        if (meta.partialExemptionRate !== null) {
          tfRates[t.instrumentId] = meta.partialExemptionRate;
        } else if (meta.assetClass === "etf") {
          tfRates[t.instrumentId] = "0.30";
        } else if (meta.assetClass === "mutual_fund") {
          tfRates[t.instrumentId] = "0.15";
        }
      }
      const allowanceAnnual = portfolio.taxAllowanceAnnual;
      const taxRate = holderTaxRate ?? "0.25";
      const usage = allowanceUsageYTD({ tradeLog, tfRates, allowanceAnnual, taxRate });
      const suggestions = harvestSuggestions({
        tradeLog,
        tfRates,
        allowanceAnnual,
        taxRate,
        usage,
      });

      // Build maxSellByKey: instrumentId → harvestableGross (max tax-free sell value).
      const maxSellByKey: Record<string, string> = {};
      for (const s of suggestions) {
        maxSellByKey[s.instrumentId] = s.harvestableGross;
      }

      // Compute trade actions with sells capped to the harvestable amount.
      // totalValue must equal targetedTotal so that deltas are relative to the
      // targeted-instrument universe (same base the drift percentages map to).
      const tradeActions: TradeAction[] = rebalancingTrades(drift, String(targetedTotal), {
        mode: "trade",
        maxSellByKey,
      });

      // Compute how much of the allowance would be used by the sell actions.
      // We sum unrealizedAdjusted for each instrument that has a sell action,
      // clamped to the remaining allowance.
      const sellKeys = new Set(tradeActions.filter((a) => a.side === "sell").map((a) => a.key));
      let allowanceUsedNum = 0;
      for (const s of suggestions) {
        if (sellKeys.has(s.instrumentId)) {
          allowanceUsedNum += Number(s.unrealizedAdjusted);
        }
      }
      // Clamp to remaining allowance so the display never exceeds the budget.
      const remainingNum = Number(usage.remaining);
      const allowanceUsed = String(Math.min(allowanceUsedNum, remainingNum).toFixed(2));

      request.timingMeta = {
        portfolioId,
        hasTargets: true,
        includeSales: true,
        taxRegime,
        fsaConfigured: true,
        hasSellActions: tradeActions.some((a) => a.side === "sell"),
      };
      return {
        ...stats,
        drift,
        contributionSplit: split,
        tradeActions,
        allowanceUsed,
        remainingAllowance: usage.remaining,
        taxRegime,
      };
    },
  );

  // Aggregate Sparplan detection across all of the user's portfolios (or a holder
  // subset). Detection runs per portfolio and is merged (not concatenated) to avoid
  // two portfolios with the same instrument collapsing into one plan.
  app.get<{ Querystring: { holderId?: string } }>(
    "/networth/sparplan",
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

      if (holderId != null) {
        const [holder] = await app.db
          .select()
          .from(accountHolders)
          .where(and(eq(accountHolders.id, holderId), eq(accountHolders.userId, id)))
          .limit(1);
        if (!holder) return reply.code(404).send({ error: "holder_not_found" });
      }

      const pfs = await app.db
        .select({
          id: portfolios.id,
          cashCounted: portfolios.cashCounted,
          baseCurrency: portfolios.baseCurrency,
        })
        .from(portfolios)
        .where(
          holderId != null
            ? and(eq(portfolios.userId, id), eq(portfolios.accountHolderId, holderId))
            : eq(portfolios.userId, id),
        );

      const result = await withDerivationCache(
        networthSparplanCache,
        cacheKey(id, display, holderId ?? ""),
        async () => {
          // Detect per portfolio in the display currency, then merge (not concatenate).
          // Independent per portfolio — bounded-concurrency instead of a serial `for` await
          // (see PORTFOLIO_VALUATION_CONCURRENCY). mapPool preserves input order.
          const portfolioResults = await mapPool(
            pfs,
            PORTFOLIO_VALUATION_CONCURRENCY,
            async (p) => {
              const { coreTxns } = await loadValuation(
                app,
                p.id,
                display,
                undefined,
                p.cashCounted,
              );
              const ccys = [...new Set(coreTxns.map((t) => t.currency))];
              const rates = await getFxRates(app.db, ccys, display);
              const fx = makeFxRateFn(rates, display);
              return detectSparplans({ txns: coreTxns, displayCurrency: display, fx });
            },
          );
          const perPortfolio: SparplanStats[] = portfolioResults;
          const allInstrumentIds = new Set<string>();
          for (const stats of perPortfolio) {
            for (const plan of stats.plans) allInstrumentIds.add(plan.instrumentId);
          }

          const merged = mergeSparplanStats(perPortfolio, display);
          const meta = await instrumentMeta(app, [...allInstrumentIds]);
          // TODO Phase B: networth instrument drift — complex (multiple portfolios, base currencies).
          // Drift + contributionSplit are only wired on the portfolio-scoped endpoint for MVP.
          return {
            ...merged,
            plans: merged.plans.map((p) => ({
              ...p,
              symbol: meta.get(p.instrumentId)?.symbol ?? null,
              name: meta.get(p.instrumentId)?.name ?? null,
            })),
          };
        },
      );
      request.timingName = "GET /networth/sparplan";
      request.timingMeta = { portfolioCount: pfs.length };
      return result;
    },
  );
}
