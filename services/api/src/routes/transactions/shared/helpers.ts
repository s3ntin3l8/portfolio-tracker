import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { Decimal } from "decimal.js";
import {
  corporateActions,
  instruments,
  transactions,
  dismissedAnomalies,
  trConnections,
} from "@portfolio/db";
import {
  type Anomaly,
  type CorporateAction,
  type CostBasisMode,
  type TradeMethod,
  type CoreTransaction,
  type ReconciliationGap,
  detectAnomalies,
  convert,
} from "@portfolio/core";
import { getMarketData } from "../../../services/market-data.js";
import { valuePortfolioCached, type InstrumentMeta } from "../../../services/valuation.js";
import { toCoreTxns } from "../../../services/tx-core.js";
import { netManualAdjustments } from "../../../services/pytr/reconcile.js";
import { withDerivationCache } from "../../../lib/derivation-cache.js";
import { getFxRatesForDates, makeFxRateFn } from "../../../services/fx.js";
import { anomaliesCache } from "./caches.js";

export function yearRange(year: number): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(year, 0, 1)),
    end: new Date(Date.UTC(year + 1, 0, 1)),
  };
}

/** CASE expressions shared by the window-function and aggregate variants of the
 *  summary totals (Invested/Proceeds/Income). Kept in one place so the formulas
 *  can't silently drift between the per-portfolio and networth SQL queries. */
function investedCase(t: typeof transactions): ReturnType<typeof sql> {
  return sql`case when ${t.type} in ('buy','savings_plan') then ${t.price}::numeric * ${t.quantity}::numeric + ${t.fees}::numeric else 0 end`;
}
function proceedsCase(t: typeof transactions): ReturnType<typeof sql> {
  return sql`case when ${t.type} = 'sell' then ${t.price}::numeric * ${t.quantity}::numeric - ${t.fees}::numeric else 0 end`;
}
function incomeCase(t: typeof transactions): ReturnType<typeof sql> {
  return sql`case when ${t.type} in ('dividend','coupon','interest','bonus_cash') then ${t.price}::numeric * ${t.quantity}::numeric else 0 end`;
}

export interface TransactionSummary {
  totalInvested: string;
  totalProceeds: string;
  totalIncome: string;
}

/**
 * FX-correct summary totals (Invested/Proceeds/Income), folded to `targetCurrency`.
 *
 * The naive `SUM(price*quantity)` mixes currencies when rows span more than one
 * `transactions.currency` (issue #593) — a EUR + IDR networth view, or a single
 * portfolio holding a foreign-currency instrument. Grouping by `(currency, trade-day)`
 * lets each bucket convert at *that day's* historical rate rather than today's spot
 * rate, matching the row-level `displayRate` convention (#465) and avoiding baking
 * currency drift into "Total Invested" (never manufacture phantom gains).
 *
 * Runs as an independent aggregate query — not tied to pagination — so it's correct
 * across the full filtered set, not just the current page.
 */
export async function computeConvertedSummary(
  app: FastifyInstance,
  conditions: SQL[],
  targetCurrency: string,
  log?: FastifyBaseLogger,
): Promise<TransactionSummary> {
  const dayExpr = sql<string>`(${transactions.executedAt} AT TIME ZONE 'UTC')::date::text`;
  const groups = await app.db
    .select({
      currency: transactions.currency,
      day: dayExpr,
      totalInvested: sql<string>`COALESCE(SUM(${investedCase(transactions)}), '0')`,
      totalProceeds: sql<string>`COALESCE(SUM(${proceedsCase(transactions)}), '0')`,
      totalIncome: sql<string>`COALESCE(SUM(${incomeCase(transactions)}), '0')`,
    })
    .from(transactions)
    .where(and(...conditions))
    .groupBy(transactions.currency, dayExpr);

  if (groups.length === 0) {
    return { totalInvested: "0", totalProceeds: "0", totalIncome: "0" };
  }

  const currencies = [...new Set(groups.map((g) => g.currency))];
  const days = [...new Set(groups.map((g) => g.day))];
  const ratesByDate = await getFxRatesForDates(app.db, currencies, targetCurrency, days);

  let totalInvested = new Decimal(0);
  let totalProceeds = new Decimal(0);
  let totalIncome = new Decimal(0);
  for (const g of groups) {
    if (g.currency !== targetCurrency && !ratesByDate.get(g.day)?.[g.currency]) {
      log?.warn(
        { currency: g.currency, targetCurrency, day: g.day },
        "computeConvertedSummary: no FX rate for bucket, falling back to 1:1",
      );
    }
    const rates = ratesByDate.get(g.day) ?? {};
    const fx = makeFxRateFn(rates, targetCurrency);
    totalInvested = totalInvested.plus(convert(g.totalInvested, g.currency, targetCurrency, fx));
    totalProceeds = totalProceeds.plus(convert(g.totalProceeds, g.currency, targetCurrency, fx));
    totalIncome = totalIncome.plus(convert(g.totalIncome, g.currency, targetCurrency, fx));
  }

  return {
    totalInvested: totalInvested.toString(),
    totalProceeds: totalProceeds.toString(),
    totalIncome: totalIncome.toString(),
  };
}

export interface PortfolioParams {
  portfolioId: string;
}

export const PORTFOLIO_VALUATION_CONCURRENCY = 4;

export const bulkDeleteSchema = z.object({
  ids: z.array(z.guid()).min(1),
});

export async function corporateActionsFor(
  app: FastifyInstance,
  instrumentIds: (string | null)[],
): Promise<CorporateAction[]> {
  const ids = [...new Set(instrumentIds.filter((x): x is string => x !== null))];
  if (ids.length === 0) return [];
  const rows = await app.db
    .select()
    .from(corporateActions)
    .where(inArray(corporateActions.instrumentId, ids));
  return rows.map((r) => ({
    instrumentId: r.instrumentId,
    type: r.type,
    ratio: r.ratio,
    exDate: new Date(r.exDate),
  }));
}

export async function computePortfolioAnomalies(
  app: FastifyInstance,
  portfolio: { id: string; cashCounted: boolean; allowNegativeCash: boolean },
): Promise<Anomaly[]> {
  const { filtered } = await withDerivationCache(anomaliesCache, portfolio.id, async () => {
    const [rows, trConn, dismissed] = await Promise.all([
      app.db.select().from(transactions).where(eq(transactions.portfolioId, portfolio.id)),
      app.db
        .select({ lastReconciliation: trConnections.lastReconciliation })
        .from(trConnections)
        .where(eq(trConnections.portfolioId, portfolio.id))
        .limit(1)
        .then((r) => r[0] ?? null),
      app.db
        .select({
          transactionId: dismissedAnomalies.transactionId,
          code: dismissedAnomalies.code,
        })
        .from(dismissedAnomalies)
        .where(eq(dismissedAnomalies.portfolioId, portfolio.id)),
    ]);
    const coreTxns: CoreTransaction[] = toCoreTxns(rows);
    const cas = await corporateActionsFor(
      app,
      rows.map((r) => r.instrumentId),
    );
    const rawReconciliation = trConn?.lastReconciliation as ReconciliationGap | null | undefined;
    const reconciliation = rawReconciliation
      ? netManualAdjustments(rawReconciliation, coreTxns)
      : rawReconciliation;
    const anomalies = detectAnomalies(coreTxns, cas, {
      cashCounted: portfolio.cashCounted,
      allowNegativeCash: portfolio.allowNegativeCash,
      reconciliationGap: reconciliation ?? null,
    });
    const dismissedSet = new Set(dismissed.map((d) => `${d.transactionId}:${d.code}`));
    const filtered = anomalies.filter(
      (a) => !(a.transactionId && dismissedSet.has(`${a.transactionId}:${a.code}`)),
    );
    return { filtered };
  });
  return filtered;
}

export async function instrumentMeta(
  app: FastifyInstance,
  ids: (string | null)[],
): Promise<Map<string, InstrumentMeta>> {
  const unique = [...new Set(ids.filter((x): x is string => x !== null))];
  if (!unique.length) return new Map();
  const rows = await app.db.select().from(instruments).where(inArray(instruments.id, unique));
  return new Map(
    rows.map((i) => [
      i.id,
      {
        symbol: i.symbol,
        name: i.name,
        displayName: i.displayName ?? null,
        assetClass: i.assetClass,
        unit: i.unit,
        market: i.market,
        sector: i.sector ?? null,
        sectorWeights: (i.sectorWeights as Record<string, number> | null) ?? null,
        countryWeights: (i.countryWeights as Record<string, number> | null) ?? null,
        sectorCheckedAt: i.sectorCheckedAt ? new Date(i.sectorCheckedAt) : null,
        partialExemptionRate: i.partialExemptionRate ?? null,
      },
    ]),
  );
}

export async function loadValuation(
  app: FastifyInstance,
  portfolioId: string,
  displayCurrency: string,
  costBasisMode?: CostBasisMode,
  cashCounted = true,
  log?: FastifyBaseLogger,
) {
  return valuePortfolioCached(
    app.db,
    await getMarketData(),
    app.config.MARKET_DATA_TTL_MS,
    portfolioId,
    displayCurrency,
    costBasisMode,
    cashCounted,
    undefined,
    log,
  );
}

export function costBasisFromQuery(q: { costBasis?: string }): CostBasisMode | undefined {
  return q.costBasis === "total_paid" || q.costBasis === "purchase_price" ? q.costBasis : undefined;
}

export function methodFromQuery(q: { method?: string }): TradeMethod {
  return q.method === "fifo" ? "fifo" : "average";
}
