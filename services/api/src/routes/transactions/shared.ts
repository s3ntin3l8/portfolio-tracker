import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  accountHolders,
  allocationTargets,
  corporateActions,
  instruments,
  portfolios,
} from "@portfolio/db";
import {
  type Anomaly,
  type CoreTransaction,
  type CostBasisMode,
  type CorporateAction,
  type CashFlowPoint,
  type ContributionStats,
  type PortfolioSummary,
  type TradeLog,
  type TradeMethod,
  type DriftRow,
  type SparplanStats,
  computeTrades,
  rebalancingDrift,
  cashFlow,
  xirr,
  convert,
  contributionStats,
  detectSparplans,
} from "@portfolio/core";
import { getMarketData } from "../../services/market-data.js";
import {
  valuePortfolioCached,
  type InstrumentMeta,
} from "../../services/valuation.js";
import { getFxRates, makeFxRateFn } from "../../services/fx.js";
import { flattenJoinRow } from "../../lib/portfolio.js";
import { createStore, type CacheEntry } from "../../lib/derivation-cache.js";

export type { CacheEntry };

export const anomaliesCache = createStore<{ filtered: Anomaly[] }>();
export const transactionsCache = createStore<{
  rows: unknown[];
  total: number;
  summary?: {
    totalInvested: string;
    totalProceeds: string;
    totalIncome: string;
  };
}>();
export const tradesCache = createStore<{
  trades: unknown[];
  realizedByYear: unknown[];
  dividendsByYear: unknown[];
}>();
export const performanceCache = createStore<{
  xirr: number | null;
  netWorth: string;
  asOf: string;
}>();
export const historyCache = createStore<unknown[]>();
export const insightsCache = createStore<unknown>();

export const sparplanCache = createStore<SparplanStats>();
export const networthSparplanCache = createStore<SparplanStats>();
export const networthTradesCache = createStore<TradeLog>();
export const networthContributionsCache = createStore<ContributionStats>();
export const networthTransactionsCache = createStore<{
  rows: unknown[];
  total: number;
}>();

export const ACTIVITY_INCOME_TYPES = [
  "dividend",
  "coupon",
  "interest",
  "bonus_cash",
] as const;

export function yearRange(year: number): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(year, 0, 1)),
    end: new Date(Date.UTC(year + 1, 0, 1)),
  };
}

export interface PortfolioParams {
  portfolioId: string;
}

export const PORTFOLIO_VALUATION_CONCURRENCY = 4;

export const bulkDeleteSchema = z.object({
  ids: z.array(z.guid()).min(1),
});

export async function ownedPortfolio(
  app: FastifyInstance,
  userId: string,
  portfolioId: string,
) {
  const [row] = await app.db
    .select()
    .from(portfolios)
    .leftJoin(accountHolders, eq(portfolios.accountHolderId, accountHolders.id))
    .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
    .limit(1);
  return row ? flattenJoinRow(row) : null;
}

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
  return q.costBasis === "total_paid" || q.costBasis === "purchase_price"
    ? q.costBasis
    : undefined;
}

export function methodFromQuery(q: { method?: string }): TradeMethod {
  return q.method === "fifo" ? "fifo" : "average";
}

export async function buildTradeLog(
  app: FastifyInstance,
  coreTxns: CoreTransaction[],
  prices: Record<string, { price: string; currency: string }>,
  target: string,
  method: TradeMethod,
  costBasisMode: CostBasisMode | undefined,
  instrumentsMeta?: Map<string, InstrumentMeta>,
  existingCorporateActions?: CorporateAction[],
  existingFxRates?: Record<string, string>,
): Promise<TradeLog> {
  const currencies = new Set<string>(coreTxns.map((t) => t.currency));
  for (const p of Object.values(prices)) currencies.add(p.currency);
  const fx = makeFxRateFn(
    existingFxRates ?? (await getFxRates(app.db, [...currencies], target)),
    target,
  );
  const cas =
    existingCorporateActions ??
    (await corporateActionsFor(app, coreTxns.map((t) => t.instrumentId)));
  return computeTrades({
    transactions: coreTxns,
    corporateActions: cas,
    prices,
    displayCurrency: target,
    fx,
    method,
    costBasisMode,
    instruments: instrumentsMeta,
  });
}

export function attachInstruments(
  log: TradeLog,
  meta: Map<string, InstrumentMeta>,
) {
  return {
    ...log,
    trades: log.trades.map((t) => ({
      ...t,
      instrument: meta.get(t.instrumentId) ?? null,
    })),
  };
}

export async function loadDrift(
  app: FastifyInstance,
  userId: string,
  portfolioId: string | null,
  allocation: {
    byAssetClass: { key: string; value: string; pct: number }[];
    byCurrency: { key: string; value: string; pct: number }[];
    byRegion: { key: string; value: string; pct: number }[];
    bySector: { key: string; value: string; pct: number }[];
  },
): Promise<Record<string, DriftRow[]>> {
  const rows = await app.db
    .select()
    .from(allocationTargets)
    .where(
      and(
        eq(allocationTargets.userId, userId),
        portfolioId
          ? eq(allocationTargets.portfolioId, portfolioId)
          : isNull(allocationTargets.portfolioId),
      ),
    );

  if (rows.length === 0) return {};

  const byDimension = new Map<string, { key: string; targetPct: number }[]>();
  for (const r of rows) {
    const existing = byDimension.get(r.dimension) ?? [];
    existing.push({ key: r.targetKey, targetPct: Number(r.targetPct) });
    byDimension.set(r.dimension, existing);
  }

  const DIMENSION_SLICES: Record<string, typeof allocation.byAssetClass> = {
    asset_class: allocation.byAssetClass,
    currency: allocation.byCurrency,
    region: allocation.byRegion,
    sector: allocation.bySector,
  };

  const result: Record<string, DriftRow[]> = {};
  for (const [dimension, targets] of byDimension) {
    const slices = DIMENSION_SLICES[dimension];
    if (!slices) continue;
    const drift = rebalancingDrift(slices, targets);
    if (drift.length > 0) result[dimension] = drift;
  }
  return result;
}

export async function externalFlows(
  app: FastifyInstance,
  txns: CoreTransaction[],
  target: string,
): Promise<CashFlowPoint[]> {
  const relevant = txns.filter(
    (t) => t.type === "deposit" || t.type === "withdrawal",
  );
  const rates = await getFxRates(
    app.db,
    [...new Set(relevant.map((t) => t.currency))],
    target,
  );
  const fx = makeFxRateFn(rates, target);
  return relevant.map((t) => ({
    amount:
      Number(convert(t.price, t.currency, target, fx)) *
      (t.type === "deposit" ? -1 : 1),
    date: t.executedAt,
  }));
}

export async function boundaryFlows(
  app: FastifyInstance,
  txns: CoreTransaction[],
  boundary: "inside" | "outside",
  target: string,
): Promise<CashFlowPoint[]> {
  if (boundary === "inside") return externalFlows(app, txns, target);
  const isInvestmentFlow = (t: CoreTransaction): boolean => {
    if (t.type === "sell" || t.type === "dividend" || t.type === "coupon")
      return true;
    if (t.type === "buy" || t.type === "savings_plan")
      return t.kind !== "saveback";
    if (t.type === "transfer_in" || t.type === "transfer_out") return true;
    if (t.type === "bonus") return t.kind === "transfer_in";
    return false;
  };
  const relevant = txns.filter(isInvestmentFlow);
  const rates = await getFxRates(
    app.db,
    [...new Set(relevant.map((t) => t.currency))],
    target,
  );
  const fx = makeFxRateFn(rates, target);
  return relevant.map((t) => ({
    amount: Number(convert(cashFlow(t).toString(), t.currency, target, fx)),
    date: t.executedAt,
  }));
}

export function enrichContributions(
  stats: ContributionStats,
  currentValue: string,
  flows: CashFlowPoint[],
  birthYear: number | null = null,
  portfolioType: "standard" | "child" = "standard",
  opts: { totalReturn?: boolean } = {},
) {
  const net = Number(stats.netContributed);
  const simpleGainPct = net > 0 ? (Number(currentValue) - net) / net : null;

  const gross = Number(stats.totalContributed);
  const positiveFlows = flows.reduce((s, f) => {
    const amt = Number(f.amount);
    return amt > 0 ? s + amt : s;
  }, 0);
  const totalReturnPct =
    (opts.totalReturn ?? true) && gross > 0
      ? (Number(currentValue) + positiveFlows - gross) / gross
      : null;

  const asOf = new Date();
  const allFlows: CashFlowPoint[] = [
    ...flows,
    { amount: Number(currentValue), date: asOf },
  ];
  const rate = flows.length ? xirr(allFlows) : NaN;
  const xirrVal = Number.isFinite(rate) ? rate : null;
  const seedAnnualReturn =
    xirrVal !== null && xirrVal > -0.5 && xirrVal < 0.5
      ? xirrVal.toString()
      : "0.07";

  return {
    ...stats,
    currentValue,
    simpleGainPct,
    totalReturnPct,
    xirr: xirrVal,
    seedAnnualReturn,
    birthYear,
    portfolioType,
    asOf: asOf.toISOString(),
  };
}

export async function buildContributions(
  app: FastifyInstance,
  coreTxns: CoreTransaction[],
  summary: PortfolioSummary,
  display: string,
  birthYear: number | null = null,
  portfolioType: "standard" | "child" = "standard",
  boundary: "inside" | "outside" = "inside",
) {
  const ccys = [...new Set(coreTxns.map((t) => t.currency))];
  const rates = await getFxRates(app.db, ccys, display);
  const fx = makeFxRateFn(rates, display);
  const stats = contributionStats({
    txns: coreTxns,
    displayCurrency: display,
    fx,
    boundary,
  });
  const flows = await boundaryFlows(app, coreTxns, boundary, display);
  return enrichContributions(stats, summary.netWorth, flows, birthYear, portfolioType, {
    totalReturn: boundary === "outside",
  });
}

export async function buildSparplanStats(
  app: FastifyInstance,
  coreTxns: CoreTransaction[],
  display: string,
): Promise<
  SparplanStats & {
    plans: (SparplanStats["plans"][number] & {
      symbol: string | null;
      name: string | null;
    })[];
  }
> {
  const ccys = [...new Set(coreTxns.map((t) => t.currency))];
  const rates = await getFxRates(app.db, ccys, display);
  const fx = makeFxRateFn(rates, display);
  const stats = detectSparplans({ txns: coreTxns, displayCurrency: display, fx });
  const meta = await instrumentMeta(
    app,
    stats.plans.map((p) => p.instrumentId),
  );
  return {
    ...stats,
    plans: stats.plans.map((p) => ({
      ...p,
      symbol: meta.get(p.instrumentId)?.symbol ?? null,
      name: meta.get(p.instrumentId)?.name ?? null,
    })),
  };
}
