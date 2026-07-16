import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import {
  accountHolders,
  dividendEvents,
  instruments,
  lossCarryforward,
  portfolios,
  users,
} from "@portfolio/db";
import { requireUser } from "../../plugins/auth.js";
import type { CoreTransaction, PortfolioSummary, IncomeEntry, TradeLog } from "@portfolio/core";
import {
  cashFlow,
  allowanceUsageYTD,
  harvestSuggestions,
  projectCoupons,
  projectDividends,
  convert,
  mergeTradeLogs,
} from "@portfolio/core";
import { getFxRates, makeFxRateFn } from "../../services/fx.js";
import {
  derivationCacheKey,
  getCachedFifoTradeLog,
  type InstrumentMeta,
} from "../../services/valuation.js";
import { logTiming } from "../../lib/timing.js";
import { mapPool } from "../../lib/promise-pool.js";
import {
  ownedPortfolio,
  loadValuation,
  buildTradeLog,
  PORTFOLIO_VALUATION_CONCURRENCY,
  type PortfolioParams,
} from "./shared.js";

async function lossCarryForwardFor(
  app: FastifyInstance,
  holderId: string,
  taxYear: number,
): Promise<{ stock?: string; general?: string }> {
  const rows = await app.db
    .select({ pot: lossCarryforward.pot, amount: lossCarryforward.amount })
    .from(lossCarryforward)
    .where(and(eq(lossCarryforward.holderId, holderId), eq(lossCarryforward.taxYear, taxYear)));
  const result: { stock?: string; general?: string } = {};
  for (const r of rows) {
    if (r.pot === "stock") result.stock = r.amount;
    else if (r.pot === "general") result.general = r.amount;
  }
  return result;
}

/**
 * Compute the gross rest-of-year (today → Dec 31) dividend + coupon income forecast for
 * one portfolio, in `display` currency.  Used by the tax endpoints to feed
 * `forecastIncomeRestOfYear` into `allowanceUsageYTD`.
 *
 * - Projected-from-history dividends are grossed up via each instrument's trailing-12-month
 *   withholding ratio (gross = net + tax, default ratio 1.0 when no withholding recorded).
 * - Announced dividend_events amounts and projected bond coupons are already gross.
 * - Returns "0" when `year` is not the current UTC calendar year.
 */
async function restOfYearForecastGross(
  app: FastifyInstance,
  coreTxns: CoreTransaction[],
  summary: PortfolioSummary,
  display: string,
  year: number,
  now: Date = new Date(),
): Promise<string> {
  if (year !== now.getUTCFullYear()) return "0";

  const heldIds = summary.holdings.filter((h) => Number(h.quantity) > 0).map((h) => h.instrumentId);
  if (heldIds.length === 0) return "0";

  const heldQtyMap = new Map<string, string>(
    summary.holdings.filter((h) => Number(h.quantity) > 0).map((h) => [h.instrumentId, h.quantity]),
  );

  const qtyAt = (_instrumentId: string, _at: Date): string => heldQtyMap.get(_instrumentId) ?? "0";

  const pastDivEvents: IncomeEntry[] = coreTxns
    .filter((t) => t.type === "dividend" && t.instrumentId)
    .map((t) => ({
      instrumentId: t.instrumentId,
      symbol: null,
      name: null,
      assetClass: null,
      type: t.type,
      price: t.price,
      currency: t.currency,
      executedAt: t.executedAt,
    }));

  const yearAgo = new Date(now);
  yearAgo.setUTCFullYear(yearAgo.getUTCFullYear() - 1);
  const grossUpNet = new Map<string, number>();
  const grossUpTax = new Map<string, number>();
  for (const t of coreTxns) {
    if (t.type !== "dividend" || !t.instrumentId || t.executedAt < yearAgo) continue;
    const net = Number(cashFlow(t).toString());
    const tax = Number(t.tax ?? "0");
    if (net <= 0) continue;
    grossUpNet.set(t.instrumentId, (grossUpNet.get(t.instrumentId) ?? 0) + net);
    grossUpTax.set(t.instrumentId, (grossUpTax.get(t.instrumentId) ?? 0) + tax);
  }

  const projectedDivs = projectDividends(pastDivEvents, heldQtyMap, qtyAt, now);

  const todayStr = now.toISOString().slice(0, 10);
  const yearEndStr = new Date(Date.UTC(now.getUTCFullYear(), 11, 31)).toISOString().slice(0, 10);

  const announcedRows =
    heldIds.length > 0
      ? await app.db
          .select()
          .from(dividendEvents)
          .where(inArray(dividendEvents.instrumentId, heldIds))
      : [];

  const futureByInstrument = new Map<
    string,
    { exDate: string; amount: string; currency: string }[]
  >();
  for (const row of announcedRows) {
    const qty = heldQtyMap.get(row.instrumentId);
    if (!qty) continue;
    const totalAmount = String(Number(row.amountPerShare) * Number(qty));
    const list = futureByInstrument.get(row.instrumentId) ?? [];
    list.push({ exDate: row.exDate, amount: totalAmount, currency: row.currency });
    futureByInstrument.set(row.instrumentId, list);
  }

  const instrumentsWithAnnounced = new Set(
    [...futureByInstrument.entries()]
      .filter(([_, rows]) => rows.some((r) => r.exDate > todayStr && r.exDate <= yearEndStr))
      .map(([id]) => id),
  );
  const blendedProjected = projectedDivs.filter(
    (d) => d.instrumentId && !instrumentsWithAnnounced.has(d.instrumentId!),
  );
  const announcedRestOfYear = [...futureByInstrument.values()]
    .flat()
    .filter((d) => d.exDate > todayStr && d.exDate <= yearEndStr);

  const bondRows =
    heldIds.length > 0
      ? await app.db
          .select()
          .from(instruments)
          .where(and(inArray(instruments.id, heldIds), eq(instruments.assetClass, "bond")))
      : [];
  const qtyById = new Map(summary.holdings.map((h) => [h.instrumentId, h.quantity]));
  const bondPositions = bondRows
    .filter((b) => b.faceValue && b.couponRate && b.maturityDate)
    .map((b) => ({
      instrumentId: b.id,
      symbol: b.symbol,
      name: b.name,
      quantity: qtyById.get(b.id) ?? "0",
      faceValue: b.faceValue as string,
      couponRate: b.couponRate as string,
      couponSchedule: b.couponSchedule,
      maturityDate: b.maturityDate as string,
      currency: b.currency,
    }));
  const yearEnd = new Date(Date.UTC(now.getUTCFullYear(), 11, 31, 23, 59, 59, 999));
  const restOfYearCoupons = projectCoupons(bondPositions, yearEnd, now);

  const allCcys = new Set<string>([
    ...blendedProjected.map((d) => d.currency),
    ...announcedRestOfYear.map((d) => d.currency),
    ...restOfYearCoupons.map((c) => c.currency),
  ]);
  if (allCcys.size === 0) return "0";

  const rates = await getFxRates(app.db, [...allCcys], display);
  const fx = makeFxRateFn(rates, display);

  let totalGross = 0;

  for (const d of blendedProjected) {
    const net = Number(convert(d.amount, d.currency, display, fx));
    const instrumentId = d.instrumentId!;
    const netSum = grossUpNet.get(instrumentId) ?? 0;
    const taxSum = grossUpTax.get(instrumentId) ?? 0;
    const ratio = netSum > 0 ? (netSum + taxSum) / netSum : 1.0;
    totalGross += net * ratio;
  }

  for (const d of announcedRestOfYear) {
    totalGross += Number(convert(d.amount, d.currency, display, fx));
  }

  for (const c of restOfYearCoupons) {
    totalGross += Number(convert(c.amount, c.currency, display, fx));
  }

  return totalGross > 0 ? totalGross.toFixed(2) : "0";
}

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
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const { portfolioId } = request.params;

      const portfolio = await ownedPortfolio(app, id, portfolioId);
      if (!portfolio) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }

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

      const durationMs = performance.now() - t0;
      logTiming(request, "GET /portfolios/:id/tax", durationMs, {
        portfolioId,
        year,
        hasHolder: holderId != null,
        carryForwardApplied,
      });
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
      const t0 = performance.now();
      const { id } = requireUser(request);
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
        if (!holder) return reply.status(404).send({ code: "holder_not_found" });
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

        const tfRates: Record<string, string> = {};
        for (const t of mergedLog.trades) {
          const m = meta.get(t.instrumentId);
          if (!m) continue;
          if (m.partialExemptionRate !== null) {
            tfRates[t.instrumentId] = m.partialExemptionRate;
          } else if (m.assetClass === "etf") {
            tfRates[t.instrumentId] = "0.30";
          } else if (m.assetClass === "mutual_fund") {
            tfRates[t.instrumentId] = "0.15";
          }
        }
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

      const durationMs = performance.now() - t0;
      logTiming(request, "GET /networth/tax", durationMs, {
        holderCount: holderRows.length,
        year,
      });
      return result;
    },
  );
}
