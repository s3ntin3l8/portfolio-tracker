import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, inArray, sql } from "drizzle-orm";
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
} from "@portfolio/core";
import { getMarketData } from "../../../services/market-data.js";
import { valuePortfolioCached, type InstrumentMeta } from "../../../services/valuation.js";
import { toCoreTxns } from "../../../services/tx-core.js";
import { netManualAdjustments } from "../../../services/pytr/reconcile.js";
import { withDerivationCache } from "../../../lib/derivation-cache.js";
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

/** Window-function summary aggregates (ride alongside LIMIT/OFFSET via OVER()).
 *  The keys are prefixed `__` so callers can strip them from the result rows. */
export function summaryWindowAggregates(t: typeof transactions) {
  return {
    __totalInvested: sql<string>`coalesce(sum(${investedCase(t)}) over (), '0')`,
    __totalProceeds: sql<string>`coalesce(sum(${proceedsCase(t)}) over (), '0')`,
    __totalIncome: sql<string>`coalesce(sum(${incomeCase(t)}) over (), '0')`,
  };
}

/** Aggregate-only summary (used in the fallback query for empty result pages). */
export function summaryAggregates(t: typeof transactions) {
  return {
    totalInvested: sql<string>`COALESCE(SUM(${investedCase(t)}), '0')`,
    totalProceeds: sql<string>`COALESCE(SUM(${proceedsCase(t)}), '0')`,
    totalIncome: sql<string>`COALESCE(SUM(${incomeCase(t)}), '0')`,
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
