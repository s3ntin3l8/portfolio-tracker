import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import { Decimal } from "decimal.js";
import { and, asc, count, desc, eq, getTableColumns, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  accountHolders,
  allocationTargets,
  corporateActions,
  dismissedAnomalies,
  dividendEvents,
  documents,
  instruments,
  lossCarryforward,
  portfolioIntradaySnapshots,
  portfolios,
  portfolioSnapshots,
  prices,
  transactions,
  transactionSources,
  trConnections,
  trResolvedEvents,
  userPreferences,
  users,
} from "@portfolio/db";
import {
  deleteReceiptsForTransactions,
  getDocumentForTransaction,
} from "../storage/receipts.js";
import { gatherDocumentNaming, buildDocumentName } from "../storage/naming.js";
import {
  sourcesFromPreFetched,
  txFlagsFromSourcesRows,
} from "../services/enrichment.js";
import { transactionInputSchema } from "@portfolio/schema";
import {
  computeHoldings,
  buildShareTimelines,
  sharesHeldAt,
  detectAnomalies,
  aggregatePortfolios,
  allocationBreakdown,
  rebalancingDrift,
  rebalancingTrades,
  xirr,
  periodXirr,
  projectCoupons,
  projectDividends,
  projectNextYearDividends,
  trailingIncomeByInstrument,
  trailingYield,
  aggregateIncome,
  convert,
  cashFlow,
  contributionStats,
  mergeContributionStats,
  detectSparplans,
  mergeSparplanStats,
  chainIndex,
  aggregateValueFlows,
  computeTrades,
  mergeTradeLogs,
  allowanceUsageYTD,
  harvestSuggestions,
  maxDrawdown,
  dailyReturns,
  annualizedVolatility,
  sharpeRatio,
  sortinoRatio,
  streakAnalysis,
  type Anomaly,
  type CoreTransaction,
  type CostBasisMode,
  type CorporateAction,
  type CashFlowPoint,
  type ContributionStats,
  type PortfolioSummary,
  type TradeLog,
  type TradeMethod,
  contributionSplit,
  splitAdjustmentFactor,
  type SparplanStats,
  type DriftRow,
  type TradeAction,
  type IncomeEntry,
  type ReconciliationGap,
} from "@portfolio/core";
import { getMarketData } from "../services/market-data.js";
import { valuePortfolioCached, derivationCacheKey, getCachedFifoTradeLog, type InstrumentMeta } from "../services/valuation.js";
import { toCoreTxns } from "../services/tx-core.js";
import { getFxRates, getFxRatesForDates, makeFxRateFn } from "../services/fx.js";
import {
  getUserBenchmarkConfig,
  fetchBenchmarkPrices,
  getBenchmarkPrices,
  computeBenchmarkIndex,
  computeActiveReturn,
} from "../services/benchmark.js";
import { rangeStart } from "../services/snapshots.js";
import { requireUser } from "../plugins/auth.js";
import { enqueueRecompute, enqueueInstrumentMetadata } from "../services/scheduler.js";
import { reassignTransactions } from "../services/reassign.js";
import { mergeTransactions, previewMerge, MergeBlockedError } from "../services/merge.js";
import { needsSectorEnrichment, needsNameEnrichment } from "../services/instrument-metadata.js";
import { loadSparklines } from "../services/sparklines.js";
import { flattenJoinRow } from "../lib/portfolio.js";
import { mapPool } from "../lib/promise-pool.js";
import { logTiming } from "../lib/timing.js";
import { netManualAdjustments } from "../services/pytr/reconcile.js";
import { withDerivationCache, createStore } from "../lib/derivation-cache.js";

const anomaliesCache = createStore<{ filtered: Anomaly[] }>();
const transactionsCache = createStore<{ rows: unknown[]; total: number; summary?: { totalInvested: string; totalProceeds: string; totalIncome: string } }>();
const tradesCache = createStore<{ trades: unknown[]; realizedByYear: unknown[]; dividendsByYear: unknown[] }>();
const performanceCache = createStore<{ xirr: number | null; netWorth: string; asOf: string }>();
const historyCache = createStore<unknown[]>();
const insightsCache = createStore<unknown>();

const sparplanCache = createStore<SparplanStats>();
const networthSparplanCache = createStore<SparplanStats>();
const networthTradesCache = createStore<TradeLog>();
const networthContributionsCache = createStore<ContributionStats>();
const networthTransactionsCache = createStore<{ rows: unknown[]; total: number }>();

const ACTIVITY_INCOME_TYPES = ["dividend", "coupon", "interest", "bonus_cash"] as const;

/**
 * Half-open [start, end) UTC bounds for a calendar year, for filtering `executedAt`.
 * A `gte`/`lt` range on the raw column is sargable (can use an index on `executedAt`);
 * `EXTRACT(YEAR FROM executed_at) = y` forces a per-row function evaluation that defeats
 * the `transactions_portfolio_executed_at_idx` composite index.
 */
function yearRange(year: number): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(year, 0, 1)),
    end: new Date(Date.UTC(year + 1, 0, 1)),
  };
}

interface PortfolioParams {
  portfolioId: string;
}

// Per-portfolio valuation loops (`/networth`, and its snapshot/period-XIRR sub-loops)
// used to `await` one portfolio at a time. Each iteration issues several DB queries
// (see `valuePortfolio`), so running them fully concurrently for a user with many
// portfolios could saturate the postgres-js pool (`max: 10` in `db/client.ts`, shared
// with pg-boss's own `max: 5`) and self-starve. Bounded via `mapPool` instead.
const PORTFOLIO_VALUATION_CONCURRENCY = 4;

const bulkDeleteSchema = z.object({
  ids: z.array(z.guid()).min(1),
});

export async function transactionsRoute(app: FastifyInstance) {
  // Confirm the portfolio exists and belongs to the user. Joins the account holder so
  // callers can read the derived birthYear/portfolioType (see lib/portfolio).
  async function ownedPortfolio(userId: string, portfolioId: string) {
    const [row] = await app.db
      .select()
      .from(portfolios)
      .leftJoin(accountHolders, eq(portfolios.accountHolderId, accountHolders.id))
      .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
      .limit(1);
    return row ? flattenJoinRow(row) : null;
  }

  // Load corporate actions for the given instruments, shaped for @portfolio/core.
  async function corporateActionsFor(instrumentIds: (string | null)[]): Promise<CorporateAction[]> {
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

  // Derived read-time fallback for dividend perShare/shares when the source data didn't
  // carry them (#508 — pytr sync/TR CSV/IBKR dividends often only carry the net cash
  // total). Never persisted: only fills nulls in the response, never overwrites an
  // authoritative/manual value already on the row. Needs the FULL, unfiltered transaction
  // history per portfolio (not just the visible page/type/year/search filter) to build an
  // accurate share-count timeline — reusing the display `conditions` here would truncate
  // history and derive the wrong shares-at-date. Scoped to `type === "dividend"` for now
  // (a bond coupon's per-nominal rate is a different concept). See buildShareTimelines'
  // doc comment for why this can't reuse computeHoldings(asOf).
  //
  // `rowsByPortfolio` lets the same function serve both the single-portfolio endpoints
  // (one entry) and the networth aggregate (one entry per portfolio on the page) without
  // duplicating the derivation logic; CA lookups stay instrument-scoped, not
  // portfolio-scoped, matching corporateActionsFor's own usage elsewhere.
  async function deriveIncomeShares(
    rowsByPortfolio: Map<string, (typeof transactions.$inferSelect)[]>,
  ): Promise<
    Map<string, { perShare: string | null; shares: string | null; sharesEstimated: true }>
  > {
    const patch = new Map<
      string,
      { perShare: string | null; shares: string | null; sharesEstimated: true }
    >();

    const isCandidate = (r: (typeof transactions.$inferSelect)) =>
      r.type === "dividend" && r.instrumentId !== null && (r.perShare === null || r.shares === null);

    const portfolioIdsNeeded = [...rowsByPortfolio.entries()]
      .filter(([, rows]) => rows.some(isCandidate))
      .map(([portfolioId]) => portfolioId);
    if (portfolioIdsNeeded.length === 0) return patch;

    const historyRows = await app.db
      .select()
      .from(transactions)
      .where(inArray(transactions.portfolioId, portfolioIdsNeeded));
    const historyByPortfolio = new Map<string, (typeof transactions.$inferSelect)[]>();
    for (const r of historyRows) {
      const list = historyByPortfolio.get(r.portfolioId) ?? [];
      list.push(r);
      historyByPortfolio.set(r.portfolioId, list);
    }

    for (const portfolioId of portfolioIdsNeeded) {
      const coreTxns = toCoreTxns(historyByPortfolio.get(portfolioId) ?? []);
      const cas = await corporateActionsFor(coreTxns.map((t) => t.instrumentId));
      const timelines = buildShareTimelines(coreTxns, cas);

      const candidates = (rowsByPortfolio.get(portfolioId) ?? []).filter(isCandidate);
      for (const r of candidates) {
        const sharesDec =
          r.shares !== null ? new Decimal(r.shares) : sharesHeldAt(timelines, r.instrumentId!, r.executedAt);
        if (!sharesDec || sharesDec.lte(0)) continue; // no positive holding — leave both null
        let perShare = r.perShare;
        if (perShare === null) {
          const gross = new Decimal(r.price).plus(r.tax !== null ? new Decimal(r.tax) : 0);
          perShare = gross.div(sharesDec).toString();
        }
        // Marks the row as carrying at least one derived (not source-provided) value — the
        // detail sheet uses this to hint that the figure is approximate, since a derived
        // EUR-convention perShare can otherwise look identically authoritative next to a
        // real, native-currency value parsed from a settlement PDF (#508).
        patch.set(r.id, { shares: r.shares ?? sharesDec.toString(), perShare, sharesEstimated: true });
      }
    }

    return patch;
  }

  // Build an instrumentId → presentation-metadata lookup for the given ids.
  async function instrumentMeta(ids: (string | null)[]): Promise<Map<string, InstrumentMeta>> {
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

  // Value a portfolio (holdings priced + cash + net worth) in `displayCurrency`.
  // Shared by /summary, /performance and /networth via the valuation service.
  // Cached (see valuePortfolioCached's doc comment) — every route in this file reads
  // through here, so they all benefit from the short-TTL derivation cache uniformly.
  async function loadValuation(
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

  // `?costBasis=total_paid` capitalizes financing into a financed holding's cost
  // basis; the default (purchase_price) keeps it separate. Net worth is unaffected.
  function costBasisFromQuery(q: { costBasis?: string }): CostBasisMode | undefined {
    return q.costBasis === "total_paid" || q.costBasis === "purchase_price"
      ? q.costBasis
      : undefined;
  }

  // `?method=fifo` matches sells to the oldest lots (German-tax-correct); the default
  // (average) is consistent with the dashboard. Only changes tax-by-year attribution,
  // open-position basis and per-lot holding period — see the trade log's docstring.
  function methodFromQuery(q: { method?: string }): TradeMethod {
    return q.method === "fifo" ? "fifo" : "average";
  }

  // Build a trade log for one transaction set, in `target` currency. Resolves the
  // corporate actions and an FX snapshot the engine needs. Accepts optional pre-fetched
  // corporate actions and fx rates (from the valuation cache) to avoid redundant queries.
  async function buildTradeLog(
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
    const fx = makeFxRateFn(existingFxRates ?? await getFxRates(app.db, [...currencies], target), target);
    const cas = existingCorporateActions ?? await corporateActionsFor(coreTxns.map((t) => t.instrumentId));
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

  // Attach presentation metadata to each trade for the web app.
  function attachInstruments(log: TradeLog, meta: Map<string, InstrumentMeta>) {
    return {
      ...log,
      trades: log.trades.map((t) => ({
        ...t,
        instrument: meta.get(t.instrumentId) ?? null,
      })),
    };
  }

  // Load all allocation targets for (userId, portfolioId|null) and compute drift
  // against each dimension's actual allocation slices from an AllocationBreakdown.
  // Returns a Record<dimension, DriftRow[]> with only non-empty dimensions included.
  async function loadDrift(
    userId: string,
    portfolioId: string | null,
    allocation: {
      byAssetClass: { key: string; value: string; pct: number }[];
      byCurrency: { key: string; value: string; pct: number }[];
      byRegion: { key: string; value: string; pct: number }[];
      bySector: { key: string; value: string; pct: number }[];
    },
  ): Promise<Record<string, DriftRow[]>> {
    // Fetch all target rows for this scope in a single query.
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

    // Group by dimension.
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
      if (!slices) continue; // ignore 'instrument' dimension here (Sparplan, Phase B)
      const drift = rebalancingDrift(slices, targets);
      if (drift.length > 0) result[dimension] = drift;
    }
    return result;
  }

  // External capital flows (deposits in (−), withdrawals out (+)) for XIRR, each
  // FX-converted to `target` so flows in different currencies are comparable with
  // the (target-currency) terminal net-worth point the caller appends.
  async function externalFlows(txns: CoreTransaction[], target: string): Promise<CashFlowPoint[]> {
    const relevant = txns.filter((t) => t.type === "deposit" || t.type === "withdrawal");
    const rates = await getFxRates(app.db, [...new Set(relevant.map((t) => t.currency))], target);
    const fx = makeFxRateFn(rates, target);
    return relevant.map((t) => ({
      amount: Number(convert(t.price, t.currency, target, fx)) * (t.type === "deposit" ? -1 : 1),
      date: t.executedAt,
    }));
  }

  // Money-weighted flows for a portfolio's boundary (see CLAUDE.md "one boundary per
  // portfolio"). The caller appends a terminal `boundaryValue` point. Sign convention
  // (matching `externalFlows`): capital the investor commits is negative, money returned
  // is positive.
  // - inside: external cash crossing the cash+securities boundary (deposits/withdrawals).
  // - outside: cash crossing the securities boundary — buys (−), sells (+), security
  //   income dividend/coupon (+). `cashFlow` already carries the right sign per type.
  //   Broker-credited reinvestment (`saveback`) is excluded so it shows as return in the
  //   terminal value rather than as committed capital; cash `interest` stays outside.
  async function boundaryFlows(
    txns: CoreTransaction[],
    boundary: "inside" | "outside",
    target: string,
  ): Promise<CashFlowPoint[]> {
    if (boundary === "inside") return externalFlows(txns, target);
    const isInvestmentFlow = (t: CoreTransaction): boolean => {
      if (t.type === "sell" || t.type === "dividend" || t.type === "coupon") return true;
      if (t.type === "buy" || t.type === "savings_plan") return t.kind !== "saveback";
      // First-class transfer type (PR #309): transfer_in/out are investment flows for XIRR.
      if (t.type === "transfer_in" || t.type === "transfer_out") return true;
      // Legacy: bonus+kind:transfer_in (pre-PR#309 rows, kept until data migration).
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

  // Wrap a (possibly merged) ContributionStats with the forecast seed — current value,
  // simple gain, and money-weighted return (XIRR). `currentValue` and `flows` are the
  // boundary-consistent value and cash flows the caller computed (per portfolio, or
  // concatenated across portfolios for the aggregate) — same boundary on both sides.
  function enrichContributions(
    stats: ContributionStats,
    currentValue: string,
    flows: CashFlowPoint[],
    birthYear: number | null = null,
    portfolioType: "standard" | "child" = "standard",
    opts: { totalReturn?: boolean } = {},
  ) {
    const net = Number(stats.netContributed);
    const simpleGainPct = net > 0 ? (Number(currentValue) - net) / net : null;

    // Cumulative total return: unrealized P&L + realized gains + received security income
    // (dividends/coupons), over GROSS contributed capital. Derived from the same boundary
    // flows that feed XIRR (positive = sells/dividends/coupons; cash `interest` stays out),
    // so it's consistent with `xirr` by construction. Gross `totalContributed` is the base —
    // realized gains came from capital no longer held, so `netContributed` would inflate it.
    // (Heavy churn re-counts re-bought capital in the base; XIRR remains the "real" figure.)
    // `null` for a single cash-inside portfolio, whose `simpleGainPct` is already total return.
    const gross = Number(stats.totalContributed);
    const positiveFlows = flows.reduce((s, f) => {
      const amt = Number(f.amount);
      return amt > 0 ? s + amt : s;
    }, 0);
    const totalReturnPct =
      (opts.totalReturn ?? true) && gross > 0
        ? (Number(currentValue) + positiveFlows - gross) / gross
        : null;

    // Money-weighted return from the boundary flows against the current value —
    // also used to seed the forecast's return rate.
    const asOf = new Date();
    const allFlows: CashFlowPoint[] = [
      ...flows,
      { amount: Number(currentValue), date: asOf },
    ];
    const rate = flows.length ? xirr(allFlows) : NaN;
    const xirrVal = Number.isFinite(rate) ? rate : null;
    const seedAnnualReturn =
      xirrVal !== null && xirrVal > -0.5 && xirrVal < 0.5 ? xirrVal.toString() : "0.07";

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

  // Contribution analytics (total/average money invested + per-month series) plus a
  // forecast seed (current value, simple gain, money-weighted return) for ONE portfolio.
  // Derived entirely from transactions; FX-converts each amount to the display currency.
  async function buildContributions(
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
    const stats = contributionStats({ txns: coreTxns, displayCurrency: display, fx, boundary });
    const flows = await boundaryFlows(coreTxns, boundary, display);
    // Cash-inside `simpleGainPct` is already total return, so a separate figure is redundant.
    return enrichContributions(stats, summary.netWorth, flows, birthYear, portfolioType, {
      totalReturn: boundary === "outside",
    });
  }

  // Recurring-investment (Sparplan) detection for a set of valued transactions.
  // Detects per-instrument recurring plans, infers cadence and step-increases, and
  // attaches instrument metadata (symbol/name) for display. FX-converts to `display`.
  async function buildSparplanStats(
    coreTxns: CoreTransaction[],
    display: string,
  ): Promise<SparplanStats & { plans: (SparplanStats["plans"][number] & { symbol: string | null; name: string | null })[] }> {
    const ccys = [...new Set(coreTxns.map((t) => t.currency))];
    const rates = await getFxRates(app.db, ccys, display);
    const fx = makeFxRateFn(rates, display);
    const stats = detectSparplans({ txns: coreTxns, displayCurrency: display, fx });
    const meta = await instrumentMeta(stats.plans.map((p) => p.instrumentId));
    return {
      ...stats,
      plans: stats.plans.map((p) => ({
        ...p,
        symbol: meta.get(p.instrumentId)?.symbol ?? null,
        name: meta.get(p.instrumentId)?.name ?? null,
      })),
    };
  }

  // Income analytics for a set of valued transactions: per-year/-month totals, TTM,
  // this-vs-last-year delta, a next-year forecast (exact projected coupons + trailing
  // dividend run-rate), breakdowns by holding/asset class/currency, plus the per-holding
  // trailing yields and upcoming coupons. FX-converts every amount to `display`.
  async function buildIncomeStats(
    coreTxns: CoreTransaction[],
    summary: PortfolioSummary,
    display: string,
    portfolioIdOf?: (txId: string) => string | undefined,
  ) {
    const now = new Date();
    const incomeTxns = coreTxns.filter((t) => t.type === "dividend" || t.type === "coupon");
    // Cash interest is genuine investment income but reported as its own subtotal
    // (`interest` below) — never merged into `incomeTxns`/`enriched`, so it can't leak
    // into the dividend/coupon headline totals produced by aggregateIncome() downstream.
    const interestTxns = coreTxns.filter((t) => t.type === "interest");

    const ccys = [...new Set([...incomeTxns, ...interestTxns].map((t) => t.currency))];
    const rates = await getFxRates(app.db, ccys, display);
    const fx = makeFxRateFn(rates, display);

    const meta = await instrumentMeta([
      ...incomeTxns.map((t) => t.instrumentId),
      ...summary.holdings.map((h) => h.instrumentId),
    ]);

    // Enriched income events, newest first — raw native amounts for the event log.
    const enriched = incomeTxns
      .map((t) => {
        const im = t.instrumentId ? meta.get(t.instrumentId) : undefined;
        return {
          transactionId: t.id ?? null,
          portfolioId: (t.id && portfolioIdOf?.(t.id)) ?? null,
          instrumentId: t.instrumentId,
          symbol: im?.symbol ?? null,
          name: im?.name ?? null,
          displayName: im?.displayName ?? null,
          assetClass: im?.assetClass ?? null,
          type: t.type,
          date: t.executedAt.toISOString().slice(0, 10),
          price: t.price,
          currency: t.currency,
          executedAt: t.executedAt,
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date));

    // Trailing-12-month income per instrument → current yield + yield-on-cost.
    const since = new Date(now);
    since.setUTCFullYear(since.getUTCFullYear() - 1);
    const trailing = trailingIncomeByInstrument(coreTxns, since, display, fx);

    // Cash-interest subtotal (YTD/TTM/lifetime), FX-converted to `display` — a standalone
    // figure alongside (not inside) the dividend/coupon headline above. Same TTM anchor
    // (`since`) and date basis (`executedAt`) as the dividend TTM for presentation parity.
    const sumInterest = (rows: typeof interestTxns) =>
      rows
        .reduce(
          (sum, t) => sum.plus(new Decimal(convert(t.price, t.currency, display, fx))),
          new Decimal(0),
        )
        .toString();
    const interest = {
      ytd: sumInterest(
        interestTxns.filter((t) => t.executedAt.getUTCFullYear() === now.getUTCFullYear()),
      ),
      ttm: sumInterest(interestTxns.filter((t) => t.executedAt >= since)),
      lifetime: sumInterest(interestTxns),
      currency: display,
    };

    const yields = summary.holdings
      .filter(
        (h) =>
          h.marketValueDisplay !== null &&
          Number(h.marketValueDisplay) !== 0 &&
          Number(trailing[h.instrumentId] ?? 0) > 0,
      )
      .map((h) => {
        const trailingIncome = trailing[h.instrumentId] ?? "0";
        const im = meta.get(h.instrumentId);
        // Income, value and cost are all in the display currency (the latter two from
        // core's display-normalized fields), so the yields divide like-for-like (#93).
        const marketValue = h.marketValueDisplay as string;
        const costBasis = h.costBasisDisplay;
        return {
          instrumentId: h.instrumentId,
          symbol: im?.symbol ?? "—",
          name: im?.name ?? null,
          displayName: im?.displayName ?? null,
          assetClass: im?.assetClass ?? null,
          trailingIncome,
          marketValue,
          costBasis,
          yield: trailingYield(trailingIncome, marketValue),
          yieldOnCost: trailingYield(trailingIncome, costBasis),
          currency: display,
        };
      })
      .sort((a, b) => Number(b.yield ?? 0) - Number(a.yield ?? 0));

    // Upcoming coupons from held bonds (next 12 months) — also the coupon half of
    // next year's forecast. A second projection covers now → Dec 31 for the
    // rest-of-year forecast.
    const heldIds = summary.holdings.map((h) => h.instrumentId);
    const bondRows = heldIds.length
      ? await app.db
          .select()
          .from(instruments)
          .where(and(inArray(instruments.id, heldIds), eq(instruments.assetClass, "bond")))
      : [];
    const qtyById = new Map(summary.holdings.map((h) => [h.instrumentId, h.quantity]));
    const positions = bondRows
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
    const upcomingCoupons12mo = projectCoupons(positions, 12, now);
    const yearEnd = new Date(Date.UTC(now.getUTCFullYear(), 11, 31, 23, 59, 59, 999));
    const restOfYearCoupons = projectCoupons(positions, yearEnd, now);

    // Project dividends for the rest of the current year from last year's actuals.
    // Load corporate actions to keep qty-at-date ratios split-consistent.
    const corpActions = await corporateActionsFor(heldIds);
    const heldQtyMap = new Map(
      summary.holdings
        .filter((h) => Number(h.quantity) > 0)
        .map((h) => [h.instrumentId, h.quantity]),
    );
    // Cache computeHoldings per unique asOf timestamp to avoid redundant work.
    const holdingsCache = new Map<number, Map<string, string>>();
    const qtyAt = (instrumentId: string, at: Date): string => {
      const key = at.getTime();
      if (!holdingsCache.has(key)) {
        const hs = computeHoldings(coreTxns, corpActions, at);
        holdingsCache.set(key, new Map(hs.map((h) => [h.instrumentId, h.quantity])));
      }
      return holdingsCache.get(key)!.get(instrumentId) ?? "0";
    };
    const pastDivs = enriched.filter((e) => e.type === "dividend");

    // Compute per-instrument share-accumulation rate (shares/month) from the trailing
    // 12 months of buy + savings_plan transactions, excluding "saveback" kind (consistent
    // with contribution boundary rules). Used by both projectDividends and
    // projectNextYearDividends so a growing savings plan is reflected consistently in
    // the rest-of-year and next-year dividend forecasts.
    const accCutoff = new Date(now);
    accCutoff.setUTCFullYear(accCutoff.getUTCFullYear() - 1);
    const sharesAccumulated = new Map<string, number>();
    for (const t of coreTxns) {
      if (
        (t.type !== "buy" && t.type !== "savings_plan") ||
        t.kind === "saveback" ||
        !t.instrumentId ||
        t.executedAt < accCutoff
      )
        continue;
      sharesAccumulated.set(
        t.instrumentId,
        (sharesAccumulated.get(t.instrumentId) ?? 0) + Number(t.quantity),
      );
    }
    const accumulation = new Map<string, string>(
      [...sharesAccumulated.entries()].map(([id, total]) => [
        id,
        String(total / 12), // monthly rate
      ]),
    );

    const projectedDividends = projectDividends(pastDivs, heldQtyMap, qtyAt, now, {
      accumulation,
    });

    // Project dividends for the full next calendar year using the cadence/growth engine.
    // applyGrowth uses the per-share YoY multiplier (clamped [0.5, 2.0]) when ≥2 years
    // of history exist; accumulation factors in ongoing savings-plan share additions.
    const projectedNextYear = projectNextYearDividends(
      pastDivs,
      heldQtyMap,
      qtyAt,
      now,
      { accumulation, applyGrowth: true },
    );

    // Load announced/paid dividend events from the DB for held instruments.
    // Scale amountPerShare by current holdings quantity to get the total payout.
    const todayStr = now.toISOString().slice(0, 10);
    const nextYearEndStr = new Date(
      Date.UTC(now.getUTCFullYear() + 1, 11, 31),
    )
      .toISOString()
      .slice(0, 10);
    const announcedRows =
      heldIds.length > 0
        ? await app.db
            .select()
            .from(dividendEvents)
            .where(inArray(dividendEvents.instrumentId, heldIds))
        : [];

    // Build a set of instrument IDs that have any announced future dividends.
    // For those instruments, announced data replaces projected estimates.
    const futureAnnouncedByInstrument = new Map<
      string,
      {
        exDate: string;
        amount: string;
        currency: string;
        status: "announced" | "paid";
        perShare: string;
        quantity: string;
      }[]
    >();
    for (const row of announcedRows) {
      const qty = heldQtyMap.get(row.instrumentId);
      if (!qty) continue;
      const totalAmount = String(Number(row.amountPerShare) * Number(qty));
      const list = futureAnnouncedByInstrument.get(row.instrumentId) ?? [];
      list.push({
        exDate: row.exDate,
        amount: totalAmount,
        currency: row.currency,
        status: row.status,
        perShare: row.amountPerShare,
        quantity: qty,
      });
      futureAnnouncedByInstrument.set(row.instrumentId, list);
    }

    // ── Rest-of-year blend (today → Dec 31 thisYear) ──────────────────────────
    // Blend: for instruments with announced future dividends, drop projected entries.
    // Only consider instruments that actually have future announcements — instruments with
    // only past paid rows in dividend_events should still use the projected heuristic.
    // dividend_events is populated by the weekly `refresh-dividends` pg-boss job
    // (scheduler.ts); this blend activates automatically for any held equity/ETF
    // instrument whose provider returns dividend announcements.
    const yearEndStr = new Date(Date.UTC(now.getUTCFullYear(), 11, 31))
      .toISOString()
      .slice(0, 10);
    const instrumentsWithAnnouncedRestOfYear = new Set(
      [...futureAnnouncedByInstrument.entries()]
        .filter(([_, rows]) =>
          rows.some((r) => r.exDate > todayStr && r.exDate <= yearEndStr),
        )
        .map(([id]) => id),
    );
    const blendedProjected = projectedDividends.filter(
      (d) => d.instrumentId && !instrumentsWithAnnouncedRestOfYear.has(d.instrumentId),
    );
    const futureAnnouncedRestOfYear = [...futureAnnouncedByInstrument.values()]
      .flat()
      .filter((d) => d.exDate > todayStr && d.exDate <= yearEndStr);
    const allRestOfYearDividends = [
      ...blendedProjected.map((d) => ({ amount: d.amount, currency: d.currency })),
      ...futureAnnouncedRestOfYear.map((d) => ({ amount: d.amount, currency: d.currency })),
    ];

    // ── Next-year blend (Jan 1 → Dec 31 nextYear) ─────────────────────────────
    // Announced data supersedes projections for next year too (same precedence rules).
    const instrumentsWithAnnouncedNextYear = new Set(
      [...futureAnnouncedByInstrument.entries()]
        .filter(([_, rows]) =>
          rows.some((r) => r.exDate > yearEndStr && r.exDate <= nextYearEndStr),
        )
        .map(([id]) => id),
    );
    const blendedNextYear = projectedNextYear.filter(
      (d) => d.instrumentId && !instrumentsWithAnnouncedNextYear.has(d.instrumentId),
    );
    const futureAnnouncedNextYear = [...futureAnnouncedByInstrument.values()]
      .flat()
      .filter((d) => d.exDate > yearEndStr && d.exDate <= nextYearEndStr);
    const allNextYearDividends = [
      ...blendedNextYear.map((d) => ({ amount: d.amount, currency: d.currency })),
      ...futureAnnouncedNextYear.map((d) => ({ amount: d.amount, currency: d.currency })),
    ];

    const stats = aggregateIncome({
      events: enriched,
      displayCurrency: display,
      fx,
      now,
      forecastCoupons: upcomingCoupons12mo,
      restOfYearCoupons,
      projectedDividends: allRestOfYearDividends,
      projectedDividendsNextYear: allNextYearDividends,
      heldQty: heldQtyMap,
      qtyAt,
    });

    // The event log doesn't need the helper-only fields (assetClass/executedAt).
    // For dividend rows with a known instrument, compute split-adjusted per-share/quantity.
    const threeYearsAgo = new Date(now);
    threeYearsAgo.setUTCFullYear(threeYearsAgo.getUTCFullYear() - 3);
    const events = enriched
      .filter((e) => e.executedAt >= threeYearsAgo)
      .map((e) => {
        let perShare: string | undefined;
        let quantity: string | undefined;
        if (e.type === "dividend" && e.instrumentId) {
          const q = qtyAt(e.instrumentId, e.executedAt);
          const qNum = Number(q);
          if (qNum > 0) {
            perShare = String(Number(e.price) / qNum);
            quantity = q;
          }
        }
        return {
          transactionId: e.transactionId,
          portfolioId: e.portfolioId,
          instrumentId: e.instrumentId,
          symbol: e.symbol,
          name: e.name,
          displayName: e.displayName ?? null,
          type: e.type,
          date: e.date,
          amount: e.price,
          currency: e.currency,
          perShare,
          quantity,
        };
      });

    // Build announced entries for the upcoming stream (future ex-dates only, both windows).
    const upcomingAnnounced: {
      instrumentId: string;
      symbol: string;
      name: string | null;
      displayName: string | null;
      date: string;
      amount: string;
      currency: string;
      kind: "dividend";
      status: "announced" | "paid";
      perShare: string;
      quantity: string;
    }[] = [];
    for (const [instrumentId, entries] of futureAnnouncedByInstrument) {
      const im = meta.get(instrumentId);
      for (const entry of entries) {
        if (entry.exDate <= todayStr || entry.exDate > nextYearEndStr) continue;
        upcomingAnnounced.push({
          instrumentId,
          symbol: im?.symbol ?? "",
          name: im?.name ?? null,
          displayName: im?.displayName ?? null,
          date: entry.exDate,
          amount: entry.amount,
          currency: entry.currency,
          kind: "dividend",
          status: entry.status,
          perShare: entry.perShare,
          quantity: entry.quantity,
        });
      }
    }

    // Merge coupons (next 12 months), blended rest-of-year projected dividends, blended
    // next-year projected dividends, and announced dividends (both windows) into one
    // date-sorted upcoming stream. The status/growthApplied/assumesContributions fields
    // let the UI surface source confidence per row.
    const upcoming = [
      ...upcomingCoupons12mo.map((c) => ({
        instrumentId: c.instrumentId,
        symbol: c.symbol,
        name: c.name,
        date: c.date,
        amount: c.amount,
        currency: c.currency,
        kind: "coupon" as const,
        status: "scheduled" as const,
        growthApplied: undefined as number | undefined,
        assumesContributions: undefined as boolean | undefined,
        perShare: undefined as string | undefined,
        quantity: undefined as string | undefined,
      })),
      ...blendedProjected.map((d) => ({
        instrumentId: d.instrumentId,
        symbol: d.symbol ?? "",
        name: d.name,
        date: d.date,
        amount: d.amount,
        currency: d.currency,
        kind: "dividend" as const,
        status: "projected" as const,
        growthApplied: undefined as number | undefined,
        assumesContributions: d.assumesContributions,
        perShare: d.perShare,
        quantity: d.quantity,
      })),
      ...blendedNextYear.map((d) => ({
        instrumentId: d.instrumentId,
        symbol: d.symbol ?? "",
        name: d.name,
        date: d.date,
        amount: d.amount,
        currency: d.currency,
        kind: "dividend" as const,
        // "grown" status when a growth multiplier was applied, else "projected".
        status: (d.source === "grown" ? "grown" : "projected") as
          | "projected"
          | "grown",
        growthApplied: d.growthApplied,
        assumesContributions: d.assumesContributions,
        perShare: d.perShare,
        quantity: d.quantity,
      })),
      ...upcomingAnnounced.map((d) => ({
        ...d,
        growthApplied: undefined as number | undefined,
        assumesContributions: undefined as boolean | undefined,
      })),
    ].sort((a, b) => a.date.localeCompare(b.date));

    const threeYearsAgoStr = threeYearsAgo.toISOString().slice(0, 7);
    const monthly = stats.monthly.filter((m) => m.month >= threeYearsAgoStr);

    return { displayCurrency: display, ...stats, monthly, yields, upcoming, events, interest };
  }

  // List a portfolio's transactions, each enriched with instrument metadata.
  // When `?page=` is present, returns `{ rows, total }` (paginated); when absent, returns
  // a bare `Transaction[]` (all rows, backward-compatible for the aggregate path).
  app.get<{
    Params: PortfolioParams;
    Querystring: { convertTo?: string; page?: string; pageSize?: string; type?: string; year?: string; q?: string };
  }>(
    "/portfolios/:portfolioId/transactions",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const portfolio = await ownedPortfolio(id, request.params.portfolioId);
      if (!portfolio) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const portfolioName = portfolio.name;
      const paginate = request.query.page !== undefined;
      const page = paginate ? Math.max(1, parseInt(request.query.page!, 10) || 1) : 1;
      const pageSize = paginate
        ? Math.min(100, Math.max(1, parseInt(request.query.pageSize ?? "25", 10) || 25))
        : 0;

      const convertTo = request.query.convertTo;
      const typeFilter = request.query.type;
      const yearFilter = request.query.year;
      const searchQuery = request.query.q;

      const conditions = [eq(transactions.portfolioId, request.params.portfolioId)];
      if (typeFilter === "buy") conditions.push(inArray(transactions.type, ["buy", "savings_plan"]));
      if (typeFilter === "sell") conditions.push(eq(transactions.type, "sell"));
      if (typeFilter === "income") conditions.push(inArray(transactions.type, ACTIVITY_INCOME_TYPES));
      if (yearFilter) {
        const y = parseInt(yearFilter, 10);
        if (!isNaN(y)) {
          const { start, end } = yearRange(y);
          conditions.push(gte(transactions.executedAt, start), lt(transactions.executedAt, end));
        }
      }
      if (searchQuery) {
        conditions.push(sql`(
    ${transactions.description}::text ILIKE '%' || ${searchQuery} || '%'
    OR ${transactions.type}::text ILIKE '%' || ${searchQuery} || '%'
    OR ${transactions.kind}::text ILIKE '%' || ${searchQuery} || '%'
    OR ${transactions.source}::text ILIKE '%' || ${searchQuery} || '%'
    OR ${transactions.currency}::text ILIKE '%' || ${searchQuery} || '%'
    OR ${transactions.instrumentId} IN (SELECT id FROM instruments WHERE symbol::text ILIKE '%' || ${searchQuery} || '%' OR name::text ILIKE '%' || ${searchQuery} || '%')
  )`);
      }

      // Shared enrichment + FX + mapping (called after the SELECT for both paths).
      async function enrichRows(rows: typeof transactions.$inferSelect[], total: number, summary?: { totalInvested: string; totalProceeds: string; totalIncome: string }) {
        const tB = performance.now();
        const allImportIds = rows
          .map((r) => r.importId)
          .filter((x): x is string => x !== null);
        const allTxIds = rows.map((r) => r.id);
        const enrichStart = performance.now();
        let instrMs = 0;
        let sourcesMs = 0;
        let docsTxMs = 0;
        let docsImpMs = 0;
        const [meta, sourcesRows, docsByTx, docsByImport] = await Promise.all([
          (async () => {
            const s = performance.now();
            const r = await instrumentMeta(rows.map((r) => r.instrumentId));
            instrMs = performance.now() - s;
            return r;
          })(),
          (async () => {
            const s = performance.now();
            const r = await app.db
              .select({
                id: transactionSources.id,
                transactionId: transactionSources.transactionId,
                sourceType: transactionSources.sourceType,
                externalId: transactionSources.externalId,
                orderRef: transactionSources.orderRef,
                documentId: transactionSources.documentId,
                importId: transactionSources.importId,
                taxComponents: transactionSources.taxComponents,
                createdAt: transactionSources.createdAt,
                confidence: transactionSources.confidence,
              })
              .from(transactionSources)
              .where(inArray(transactionSources.transactionId, allTxIds));
            sourcesMs = performance.now() - s;
            return r;
          })(),
          (async () => {
            const s = performance.now();
            const r = await app.db
              .select({
                id: documents.id,
                transactionId: documents.transactionId,
                importId: documents.importId,
                status: documents.status,
                originalFilename: documents.originalFilename,
                mimeType: documents.mimeType,
                storedAt: documents.storedAt,
              })
              .from(documents)
              .where(
                and(
                  eq(documents.status, "retained"),
                  inArray(documents.transactionId, allTxIds),
                ),
              );
            docsTxMs = performance.now() - s;
            return r;
          })(),
          allImportIds.length > 0
            ? (async () => {
                const s = performance.now();
                const r = await app.db
                  .select({
                    id: documents.id,
                    transactionId: documents.transactionId,
                    importId: documents.importId,
                    status: documents.status,
                    originalFilename: documents.originalFilename,
                    mimeType: documents.mimeType,
                    storedAt: documents.storedAt,
                  })
                  .from(documents)
                  .where(
                    and(
                      eq(documents.status, "retained"),
                      inArray(documents.importId, allImportIds),
                    ),
                  );
                docsImpMs = performance.now() - s;
                return r;
              })()
            : [],
        ]);
        const docsRows = docsByTx.concat(docsByImport);

        // Phase 2: Pure JS enrichment — no DB queries.
        const { needsReview, fullTaxDetail } = txFlagsFromSourcesRows(sourcesRows);
        const importIdsWithDocs = new Set(
          docsRows
            .map((r) => r.importId)
            .filter((x): x is string => x !== null),
        );
        const txIdsWithDocs = new Set(
          docsRows
            .map((r) => r.transactionId)
            .filter((x): x is string => x !== null),
        );
        const importMinDateById = new Map<string, Date>();
        for (const r of rows) {
          if (r.importId && (!importMinDateById.has(r.importId) || r.executedAt < importMinDateById.get(r.importId)!)) {
            importMinDateById.set(r.importId, r.executedAt);
          }
        }
        const sourcesMap = sourcesFromPreFetched(
          sourcesRows,
          docsRows,
          rows,
          meta,
          portfolioName,
          importMinDateById,
        );
        const tD = performance.now();

        // Optional per-row FX conversion.
        let ratesByDate: Map<string, Record<string, string>> | undefined;
        if (convertTo) {
          const currencies = [...new Set(rows.map((r) => r.currency))];
          const dates = [...new Set(rows.map((r) => r.executedAt.toISOString().slice(0, 10)))];
          ratesByDate = await getFxRatesForDates(app.db, currencies, convertTo, dates);
        }
        const tE = performance.now();

        // #508 fallback: fill dividend perShare/shares still null after source parsing,
        // derived from the portfolio's full holdings history (see deriveIncomeShares).
        const incomeSharesPatch = await deriveIncomeShares(
          new Map([[request.params.portfolioId, rows]]),
        );

        // Single pass over rows: merge FX rate lookup and response shape construction.
        const responseRows = rows.map((r) => {
          let displayRate: string | undefined;
          if (ratesByDate && convertTo) {
            const date = r.executedAt.toISOString().slice(0, 10);
            const rates = ratesByDate.get(date) ?? {};
            displayRate = r.currency === convertTo ? "1" : (rates[r.currency] ?? "1");
          }
          return {
            ...r,
            instrument: r.instrumentId ? (meta.get(r.instrumentId) ?? null) : null,
            hasDocument:
              txIdsWithDocs.has(r.id) ||
              (r.importId ? importIdsWithDocs.has(r.importId) : false),
            hasFullTaxDetail: fullTaxDetail.has(r.id),
            needsReview: needsReview.has(r.id),
            sources: sourcesMap.get(r.id) ?? [],
            ...(incomeSharesPatch.get(r.id) ?? {}),
            ...(displayRate
              ? { displayCurrency: convertTo, displayRate }
              : {}),
          };
        });

        const durationMs = performance.now() - t0;
        logTiming(request, "GET /portfolios/:id/transactions", durationMs, {
          portfolioId: request.params.portfolioId,
          transactionCount: responseRows.length,
          total: paginate ? total : undefined,
          page: paginate ? page : undefined,
          hasFxConversion: !!convertTo,
          authMs: tA - t0,
          queryMs: tB - tA,
          enrichMs: tD - enrichStart,
          instrMs: Math.round(instrMs * 100) / 100,
          sourcesMs: Math.round(sourcesMs * 100) / 100,
          docsTxMs: Math.round(docsTxMs * 100) / 100,
          docsImpMs: Math.round(docsImpMs * 100) / 100,
          enrichPhase2Ms: Math.round((tD - enrichStart - Math.max(instrMs, sourcesMs, docsTxMs, docsImpMs)) * 100) / 100,
          fxMs: tE - tD,
          mapMs: performance.now() - tE,
        });

        return { rows: responseRows, total, summary };
      }

      const tA = performance.now();
      if (paginate) {
        const cacheKey = `transactions:${request.params.portfolioId}:${page}:${pageSize}:${convertTo || ''}:${typeFilter || ''}:${yearFilter || ''}:${searchQuery || ''}`;
        const cached = await withDerivationCache(transactionsCache, cacheKey, async () => {
          // Fold count + summary into the page query via window functions (COUNT(*)/SUM(...)
          // OVER ()) — one scan of the filtered rows instead of three separate ones, one
          // round trip instead of three. OVER() aggregates across every row matching WHERE
          // (not just the LIMIT'd page), so `total`/summary stay correct for the whole filter,
          // not just the page — but a window aggregate only appears on rows the query
          // actually returns, so an out-of-range page (offset past the last matching row)
          // yields zero rows and no aggregate to read. Fall back to the old two-query shape
          // for just that edge case.
          const merged = await app.db
            .select({
              ...getTableColumns(transactions),
              __total: sql<number>`count(*) over ()`,
              __totalInvested: sql<string>`coalesce(sum(case when ${transactions.type} in ('buy','savings_plan') then ${transactions.price}::numeric * ${transactions.quantity}::numeric + ${transactions.fees}::numeric else 0 end) over (), '0')`,
              __totalProceeds: sql<string>`coalesce(sum(case when ${transactions.type} = 'sell' then ${transactions.price}::numeric * ${transactions.quantity}::numeric - ${transactions.fees}::numeric else 0 end) over (), '0')`,
              __totalIncome: sql<string>`coalesce(sum(case when ${transactions.type} in ('dividend','coupon','interest','bonus_cash') then ${transactions.price}::numeric * ${transactions.quantity}::numeric else 0 end) over (), '0')`,
            })
            .from(transactions)
            .where(and(...conditions))
            .orderBy(desc(transactions.executedAt))
            .limit(pageSize)
            .offset((page - 1) * pageSize);

          let cnt: number;
          let summaryRows: { totalInvested: string; totalProceeds: string; totalIncome: string };
          let _rows: typeof transactions.$inferSelect[];
          if (merged.length > 0) {
            cnt = Number(merged[0].__total);
            summaryRows = {
              totalInvested: merged[0].__totalInvested,
              totalProceeds: merged[0].__totalProceeds,
              totalIncome: merged[0].__totalIncome,
            };
            _rows = merged.map(({ __total, __totalInvested, __totalProceeds, __totalIncome, ...r }) => r);
          } else {
            const [c, s] = await Promise.all([
              app.db
                .select({ count: count() })
                .from(transactions)
                .where(and(...conditions))
                .then((r) => Number(r[0].count)),
              app.db
                .select({
                  totalInvested: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.type} IN ('buy','savings_plan') THEN ${transactions.price}::numeric * ${transactions.quantity}::numeric + ${transactions.fees}::numeric ELSE 0 END), '0')`,
                  totalProceeds: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.type} = 'sell' THEN ${transactions.price}::numeric * ${transactions.quantity}::numeric - ${transactions.fees}::numeric ELSE 0 END), '0')`,
                  totalIncome: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.type} IN ('dividend','coupon','interest','bonus_cash') THEN ${transactions.price}::numeric * ${transactions.quantity}::numeric ELSE 0 END), '0')`,
                })
                .from(transactions)
                .where(and(...conditions))
                .then((r) => r[0]),
            ]);
            cnt = c;
            summaryRows = s;
            _rows = [];
          }
          return enrichRows(_rows, cnt, summaryRows);
        });
        const years = await app.db
          .select({ year: sql<number>`DISTINCT EXTRACT(YEAR FROM ${transactions.executedAt})` })
          .from(transactions)
          .where(eq(transactions.portfolioId, request.params.portfolioId))
          .orderBy(sql`1 DESC`);
        const yearList = years.map((r) => String(r.year));
        return { rows: cached.rows, total: cached.total, summary: cached.summary, years: yearList };
      }

      const rows = await app.db
        .select()
        .from(transactions)
        .where(and(...conditions));
      const result = await enrichRows(rows, rows.length);
      return result.rows;
    },
  );

  // Aggregate transactions across all of the user's portfolios, paginated.
  // Same enrichment pipeline as the per-portfolio endpoint but across all portfolios.
  app.get<{
    Querystring: { page?: string; pageSize?: string; type?: string; year?: string; q?: string };
  }>(
    "/networth/transactions",
    { preHandler: app.authenticate },
    async (request, _reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const paginate = request.query.page !== undefined;
      const page = paginate ? Math.max(1, parseInt(request.query.page!, 10) || 1) : 1;
      const pageSize = paginate ? Math.min(100, Math.max(1, parseInt(request.query.pageSize ?? "25", 10) || 25)) : 0;
      const typeFilter = request.query.type;
      const yearFilter = request.query.year;
      const searchQuery = request.query.q;

      const pfs = await app.db
        .select({ id: portfolios.id, name: portfolios.name, baseCurrency: portfolios.baseCurrency })
        .from(portfolios)
        .where(eq(portfolios.userId, id));
      if (pfs.length === 0) return paginate ? { rows: [], total: 0 } : [];

      const pfIds = pfs.map((p) => p.id);
      const nameById = new Map(pfs.map((p) => [p.id, p.name]));

      const conditions = [inArray(transactions.portfolioId, pfIds)];
      if (typeFilter === "buy") conditions.push(inArray(transactions.type, ["buy", "savings_plan"]));
      if (typeFilter === "sell") conditions.push(eq(transactions.type, "sell"));
      if (typeFilter === "income") conditions.push(inArray(transactions.type, ACTIVITY_INCOME_TYPES));
      if (yearFilter) {
        const y = parseInt(yearFilter, 10);
        if (!isNaN(y)) {
          const { start, end } = yearRange(y);
          conditions.push(gte(transactions.executedAt, start), lt(transactions.executedAt, end));
        }
      }
      if (searchQuery) {
        conditions.push(sql`(
          ${transactions.description}::text ILIKE '%' || ${searchQuery} || '%'
          OR ${transactions.type}::text ILIKE '%' || ${searchQuery} || '%'
          OR ${transactions.kind}::text ILIKE '%' || ${searchQuery} || '%'
          OR ${transactions.source}::text ILIKE '%' || ${searchQuery} || '%'
          OR ${transactions.currency}::text ILIKE '%' || ${searchQuery} || '%'
          OR ${transactions.instrumentId} IN (SELECT id FROM instruments WHERE symbol::text ILIKE '%' || ${searchQuery} || '%' OR name::text ILIKE '%' || ${searchQuery} || '%')
        )`);
      }

      async function enrichAggregateRows(
        rows: typeof transactions.$inferSelect[],
      ) {
        const tB = performance.now();
        const allImportIds = rows.map((r) => r.importId).filter((x): x is string => x !== null);
        const allTxIds = rows.map((r) => r.id);
        const enrichStart = performance.now();

        const meta = await instrumentMeta(rows.map((r) => r.instrumentId).filter((x): x is string => x !== null));
        const instrMs = performance.now() - enrichStart;

        const [sourcesRows, docsByTx, docsByImport] = await Promise.all([
          app.db
            .select({
              id: transactionSources.id,
              transactionId: transactionSources.transactionId,
              sourceType: transactionSources.sourceType,
              externalId: transactionSources.externalId,
              orderRef: transactionSources.orderRef,
              documentId: transactionSources.documentId,
              importId: transactionSources.importId,
              taxComponents: transactionSources.taxComponents,
              createdAt: transactionSources.createdAt,
              confidence: transactionSources.confidence,
            })
            .from(transactionSources)
            .where(inArray(transactionSources.transactionId, allTxIds)),
          app.db
            .select()
            .from(documents)
            .where(and(inArray(documents.transactionId, allTxIds), eq(documents.status, "retained"))),
          app.db
            .select()
            .from(documents)
            .where(and(inArray(documents.importId, allImportIds), eq(documents.status, "retained"))),
        ]);
        const sourcesMs = performance.now() - (enrichStart + instrMs);

        const docsRows = docsByTx.concat(docsByImport);
        const importIdsWithDocs = new Set(docsRows.map((r) => r.importId).filter((x): x is string => x !== null));
        const txIdsWithDocs = new Set(docsRows.map((r) => r.transactionId).filter((x): x is string => x !== null));

        // Compute importMinDateById from transaction rows
        const importMinDateById = new Map<string, Date>();
        for (const r of rows) {
          if (r.importId && (!importMinDateById.has(r.importId) || r.executedAt < importMinDateById.get(r.importId)!)) {
            importMinDateById.set(r.importId, r.executedAt);
          }
        }

        const sourcesMap = sourcesFromPreFetched(
          sourcesRows,
          docsRows,
          rows,
          meta,
          null, // portfolioName — null for aggregate view
          importMinDateById,
        );

        const phase2Ms = performance.now() - (tB + sourcesMs + instrMs);
        logTiming(request, "enrichAggregateRows", performance.now() - tB, {
          rowCount: rows.length,
          instrMs: Math.round(instrMs * 100) / 100,
          sourcesMs: Math.round(sourcesMs * 100) / 100,
          phase2Ms: Math.round(phase2Ms * 100) / 100,
        });

        const { needsReview, fullTaxDetail } = txFlagsFromSourcesRows(sourcesRows);

        // #508 fallback: fill dividend perShare/shares still null after source parsing.
        // Grouped by portfolioId — a shared instrument held in two portfolios has
        // independent share counts, so each portfolio gets its own timeline.
        const rowsByPortfolio = new Map<string, typeof transactions.$inferSelect[]>();
        for (const r of rows) {
          const list = rowsByPortfolio.get(r.portfolioId) ?? [];
          list.push(r);
          rowsByPortfolio.set(r.portfolioId, list);
        }
        const incomeSharesPatch = await deriveIncomeShares(rowsByPortfolio);

        return rows.map((r) => ({
          ...r,
          instrument: meta.get(r.instrumentId ?? "") ?? null,
          sources: sourcesMap.get(r.id) ?? [],
          hasSources: (sourcesMap.get(r.id)?.length ?? 0) > 0,
          needsReview: needsReview.has(r.id),
          fullTaxDetail: fullTaxDetail.has(r.id),
          documentRetained: txIdsWithDocs.has(r.id) || (r.importId != null && importIdsWithDocs.has(r.importId)),
          portfolioName: nameById.get(r.portfolioId) ?? "",
          ...(incomeSharesPatch.get(r.id) ?? {}),
        }));
      }

      if (paginate) {
        const cacheKey = `${id}:networth:${page}:${pageSize}:${typeFilter ?? ""}:${yearFilter ?? ""}:${searchQuery ?? ""}`;
        const cached = await withDerivationCache(networthTransactionsCache, cacheKey, async () => {
          // Fold the count into the page query via COUNT(*) OVER() — one scan/round trip
          // instead of two. Falls back to a separate count when the page itself is empty
          // (out-of-range offset), since an empty result set carries no window aggregate.
          const merged = await app.db
            .select({ ...getTableColumns(transactions), __total: sql<number>`count(*) over ()` })
            .from(transactions)
            .where(and(...conditions))
            .orderBy(desc(transactions.executedAt))
            .limit(pageSize)
            .offset((page - 1) * pageSize);

          let total: number;
          let rows: typeof transactions.$inferSelect[];
          if (merged.length > 0) {
            total = Number(merged[0].__total);
            rows = merged.map(({ __total, ...r }) => r);
          } else {
            total = await app.db
              .select({ count: count() })
              .from(transactions)
              .where(and(...conditions))
              .then((r) => Number(r[0].count));
            rows = [];
          }
          const enriched = await enrichAggregateRows(rows);
          return { rows: enriched, total };
        });
        // Type/year-filter-independent, like the single-portfolio version above — the
        // dropdown itself must not be filtered by the currently-selected type/year, or
        // switching to "buy" could hide years that only ever contain "sell" rows.
        const years = await app.db
          .select({ year: sql<number>`DISTINCT EXTRACT(YEAR FROM ${transactions.executedAt})` })
          .from(transactions)
          .where(inArray(transactions.portfolioId, pfIds))
          .orderBy(sql`1 DESC`);
        const yearList = years.map((r) => String(r.year));
        const durationMs = performance.now() - t0;
        logTiming(request, "GET /networth/transactions", durationMs, {
          page,
          pageSize,
          total: cached.total,
          portfolioCount: pfs.length,
        });
        return { rows: cached.rows, total: cached.total, years: yearList };
      }

      const rows = await app.db
        .select()
        .from(transactions)
        .where(and(...conditions))
        .orderBy(desc(transactions.executedAt));
      const enriched = await enrichAggregateRows(rows);
      const durationMs = performance.now() - t0;
      logTiming(request, "GET /networth/transactions", durationMs, {
        rowCount: rows.length,
        portfolioCount: pfs.length,
      });
      return enriched;
    },
  );

  // Add a transaction to a portfolio.
  app.post<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/transactions",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      if (!(await ownedPortfolio(id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const input = transactionInputSchema.parse({
        ...(request.body as Record<string, unknown>),
        portfolioId,
      });
      const [created] = await app.db
        .insert(transactions)
        .values({
          portfolioId,
          instrumentId: input.instrumentId ?? null,
          type: input.type,
          quantity: input.quantity,
          price: input.price,
          fees: input.fees,
          tax: input.tax ?? null,
          fxRate: input.fxRate ?? null,
          perShare: input.perShare ?? null,
          shares: input.shares ?? null,
          nativeCurrency: input.nativeCurrency ?? null,
          grossNative: input.grossNative ?? null,
          description: input.description ?? null,
          tags: input.tags ?? null,
          currency: input.currency,
          executedAt: input.executedAt,
          source: input.source,
          externalId: input.externalId,
          kind: input.kind ?? null,
        })
        .returning();
      await enqueueRecompute(portfolioId, new Date(input.executedAt).toISOString().slice(0, 10));
      reply.code(201);
      return created;
    },
  );

  // Delete a transaction from a portfolio (owner only).
  app.delete<{ Params: PortfolioParams & { txId: string } }>(
    "/portfolios/:portfolioId/transactions/:txId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId, txId } = request.params;
      if (!(await ownedPortfolio(id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const [deleted] = await app.db
        .delete(transactions)
        .where(and(eq(transactions.id, txId), eq(transactions.portfolioId, portfolioId)))
        .returning();
      if (!deleted) {
        return reply.code(404).send({ error: "transaction_not_found" });
      }
      // Clean up any linked documents (#231). Best-effort — never blocks the response.
      await deleteReceiptsForTransactions(
        app,
        [deleted.id],
        deleted.importId ? [deleted.importId] : [],
      );
      await enqueueRecompute(portfolioId, deleted.executedAt.toISOString().slice(0, 10));
      return reply.code(204).send();
    },
  );

  // Batch-delete transactions from a portfolio (owner only). Ignores ids that
  // don't belong to the portfolio; returns how many rows were actually removed.
  app.post<{ Params: PortfolioParams; Body: { ids?: unknown } }>(
    "/portfolios/:portfolioId/transactions/bulk-delete",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      if (!(await ownedPortfolio(id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const { ids } = bulkDeleteSchema.parse(request.body);
      const deleted = await app.db
        .delete(transactions)
        .where(and(eq(transactions.portfolioId, portfolioId), inArray(transactions.id, ids)))
        .returning({ id: transactions.id, importId: transactions.importId });
      // Clean up any linked documents (#231). Best-effort.
      if (deleted.length > 0) {
        await deleteReceiptsForTransactions(
          app,
          deleted.map((d) => d.id),
          deleted.map((d) => d.importId).filter((x): x is string => x !== null),
        );
      }
      return { deleted: deleted.length };
    },
  );

  // Update a transaction (owner only) — full replacement of the editable fields.
  app.patch<{ Params: PortfolioParams & { txId: string } }>(
    "/portfolios/:portfolioId/transactions/:txId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId, txId } = request.params;
      if (!(await ownedPortfolio(id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const input = transactionInputSchema.parse({
        ...(request.body as Record<string, unknown>),
        portfolioId,
      });
      const [updated] = await app.db
        .update(transactions)
        .set({
          instrumentId: input.instrumentId ?? null,
          type: input.type,
          quantity: input.quantity,
          price: input.price,
          fees: input.fees,
          tax: input.tax ?? null,
          fxRate: input.fxRate ?? null,
          perShare: input.perShare ?? null,
          shares: input.shares ?? null,
          nativeCurrency: input.nativeCurrency ?? null,
          grossNative: input.grossNative ?? null,
          description: input.description ?? null,
          tags: input.tags ?? null,
          currency: input.currency,
          executedAt: input.executedAt,
          source: input.source,
          externalId: input.externalId,
          kind: input.kind ?? null,
        })
        .where(and(eq(transactions.id, txId), eq(transactions.portfolioId, portfolioId)))
        .returning();
      if (!updated) {
        return reply.code(404).send({ error: "transaction_not_found" });
      }
      await enqueueRecompute(portfolioId, updated.executedAt.toISOString().slice(0, 10));
      return updated;
    },
  );

  // Set a transaction's visibility status (normal / archived / cash_neutral) without
  // re-sending the whole row. Lets the UI correct imports the broker feed can't represent
  // (phantom rows → archived; reward-funded buys → cash_neutral) and recomputes the rollup.
  const statusBodySchema = z.object({
    status: z.enum(["normal", "archived", "cash_neutral"]),
  });
  app.patch<{ Params: PortfolioParams & { txId: string } }>(
    "/portfolios/:portfolioId/transactions/:txId/status",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId, txId } = request.params;
      if (!(await ownedPortfolio(id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const { status } = statusBodySchema.parse(request.body);
      const [updated] = await app.db
        .update(transactions)
        .set({ status })
        .where(and(eq(transactions.id, txId), eq(transactions.portfolioId, portfolioId)))
        .returning();
      if (!updated) {
        return reply.code(404).send({ error: "transaction_not_found" });
      }
      await enqueueRecompute(portfolioId, updated.executedAt.toISOString().slice(0, 10));
      return updated;
    },
  );

  // Persistently dismiss / undo a transaction-scoped anomaly. Anomalies are derived live by
  // detectAnomalies(); a dismissed (transactionId, code) is filtered out of the holdings route
  // so a knowingly-accepted warning (e.g. a benign, self-corrected negative_cash) stops nagging.
  const dismissAnomalySchema = z.object({
    transactionId: z.guid(),
    code: z.string().min(1),
  });
  app.post<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/anomalies/dismiss",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      if (!(await ownedPortfolio(id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const { transactionId, code } = dismissAnomalySchema.parse(request.body);
      // The transaction must belong to this portfolio (avoid dismissing a foreign tx's anomaly).
      const [tx] = await app.db
        .select({ id: transactions.id })
        .from(transactions)
        .where(and(eq(transactions.id, transactionId), eq(transactions.portfolioId, portfolioId)))
        .limit(1);
      if (!tx) {
        return reply.code(404).send({ error: "transaction_not_found" });
      }
      // Idempotent: a repeat dismissal is a no-op (unique index guards the pairing).
      await app.db
        .insert(dismissedAnomalies)
        .values({ userId: id, portfolioId, transactionId, code })
        .onConflictDoNothing();
      return reply.code(204).send();
    },
  );
  app.delete<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/anomalies/dismiss",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      if (!(await ownedPortfolio(id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const { transactionId, code } = dismissAnomalySchema.parse(request.body);
      await app.db
        .delete(dismissedAnomalies)
        .where(
          and(
            eq(dismissedAnomalies.portfolioId, portfolioId),
            eq(dismissedAnomalies.transactionId, transactionId),
            eq(dismissedAnomalies.code, code),
          ),
        );
      return reply.code(204).send();
    },
  );

  // Resolve draft transactions (from a sync/import) in bulk: confirm (draft → normal, now
  // counts everywhere) or discard (draft → archived, kept + visible but excluded from every
  // derivation). One request, N ids — never fan out N PATCHes (rate-limit, #227). For
  // sync-sourced rows (pytr/ibkr) it also writes the durable resolved-events ledger so a
  // later sync can't re-create the row even if it's hard-deleted. Only rows currently in
  // `draft` status are touched; ids that aren't draft / don't belong are ignored.
  const resolveDraftsSchema = z.object({
    ids: z.array(z.string().uuid()).min(1),
    action: z.enum(["confirm", "discard"]),
  });
  app.post<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/transactions/resolve-drafts",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      if (!(await ownedPortfolio(id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const { ids, action } = resolveDraftsSchema.parse(request.body);
      const nextStatus = action === "confirm" ? "normal" : "archived";
      const resolution = action === "confirm" ? "confirmed" : "discarded";

      const updated = await app.db
        .update(transactions)
        .set({ status: nextStatus })
        .where(
          and(
            eq(transactions.portfolioId, portfolioId),
            eq(transactions.status, "draft"),
            inArray(transactions.id, ids),
          ),
        )
        .returning({
          id: transactions.id,
          source: transactions.source,
          externalId: transactions.externalId,
          executedAt: transactions.executedAt,
        });

      // Durable ledger for sync sources so the resolution survives a later hard-delete.
      const ledgerRows = updated
        .filter((r) => (r.source === "pytr" || r.source === "ibkr") && r.externalId)
        .map((r) => ({
          portfolioId,
          source: r.source as "pytr" | "ibkr",
          eventId: r.externalId as string,
          resolution,
        }));
      if (ledgerRows.length > 0) {
        await app.db.insert(trResolvedEvents).values(ledgerRows).onConflictDoNothing();
      }

      // Recompute each affected day (drafts didn't count before; now they do / stay out).
      const days = new Set(updated.map((r) => r.executedAt.toISOString().slice(0, 10)));
      for (const day of days) await enqueueRecompute(portfolioId, day);

      return { updated: updated.length };
    },
  );

  // Reassign transactions to another portfolio (move a wrong-portfolio import in one action).
  // One request, N ids → never fan out. Rows whose economic identity already exists in the
  // target are skipped (dedup index), as are financed-gold legs (can't split from the loan).
  // Both the source and target portfolios are recomputed for each affected day.
  const reassignSchema = z.object({
    ids: z.array(z.string().uuid()).min(1),
    targetPortfolioId: z.string().uuid(),
  });
  app.post<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/transactions/reassign",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      const { ids, targetPortfolioId } = reassignSchema.parse(request.body);
      if (portfolioId === targetPortfolioId) {
        return reply.code(400).send({ error: "same_portfolio" });
      }
      if (!(await ownedPortfolio(id, portfolioId)) || !(await ownedPortfolio(id, targetPortfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }

      const res = await reassignTransactions(app.db, {
        rowIds: ids,
        fromPortfolioId: portfolioId,
        toPortfolioId: targetPortfolioId,
      });
      for (const { portfolioId: pid, day } of res.recompute) await enqueueRecompute(pid, day);

      return {
        moved: res.moved,
        skippedConflicts: res.skippedConflicts,
        skippedLoans: res.skippedLoans,
      };
    },
  );

  // Read-only preview of a merge: validates the guardrails and returns the merged result the
  // confirm action would produce, without writing anything. Powers the merge dialog.
  app.get<{ Params: PortfolioParams; Querystring: { survivorId?: string; absorbedId?: string } }>(
    "/portfolios/:portfolioId/transactions/merge-preview",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      if (!(await ownedPortfolio(id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const query = z
        .object({ survivorId: z.uuid(), absorbedId: z.uuid() })
        .safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: "invalid_query" });

      const preview = await previewMerge(app.db, { portfolioId, ...query.data });
      return preview;
    },
  );

  // Merge two duplicate transactions (manual recovery when cross-source dedup misses a
  // pair). `survivorId` keeps its core economic fields; `absorbedId`'s sources/documents are
  // folded in and the row is deleted. See services/merge.ts for the full write sequence.
  const mergeSchema = z
    .object({ survivorId: z.uuid(), absorbedId: z.uuid() })
    .refine((v) => v.survivorId !== v.absorbedId, { message: "same_transaction" });
  app.post<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/transactions/merge",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      if (!(await ownedPortfolio(id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const parsed = mergeSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      try {
        const result = await mergeTransactions(app.db, { portfolioId, ...parsed.data });
        for (const { portfolioId: pid, day } of result.recompute) await enqueueRecompute(pid, day);
        return { survivorId: result.survivorId };
      } catch (err) {
        if (err instanceof MergeBlockedError) {
          const status = err.reason === "not_found" ? 404 : 400;
          return reply.code(status).send({ error: `cannot_merge_${err.reason}` });
        }
        throw err;
      }
    },
  );

  // Derived holdings + data-integrity anomalies for a portfolio.
  app.get<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/holdings",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      const portfolio = await ownedPortfolio(id, portfolioId);
      if (!portfolio) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const [rows, trConn, dismissed] = await Promise.all([
        app.db
          .select()
          .from(transactions)
          .where(eq(transactions.portfolioId, portfolioId)),
        app.db
          .select({ lastReconciliation: trConnections.lastReconciliation })
          .from(trConnections)
          .where(eq(trConnections.portfolioId, portfolioId))
          .limit(1)
          .then((r) => r[0] ?? null),
        app.db
          .select({
            transactionId: dismissedAnomalies.transactionId,
            code: dismissedAnomalies.code,
          })
          .from(dismissedAnomalies)
          .where(eq(dismissedAnomalies.portfolioId, portfolioId)),
      ]);
      const coreTxns: CoreTransaction[] = toCoreTxns(rows);
      const cas = await corporateActionsFor(rows.map((r) => r.instrumentId));
      const holdings = computeHoldings(coreTxns, cas);
      const rawReconciliation = trConn?.lastReconciliation as
        | ReconciliationGap
        | null
        | undefined;
      // Fold manual correction transactions into the sync-derived reconciliation before
      // anomaly detection: reconcileCash (services/pytr/reconcile.ts) is deliberately
      // feed-only and never sees stored rows, so a user's true-up for a known feed-vs-reality
      // gap (a plain `adjustment` row, or a same-typed correction like a negative manual
      // `dividend`) would otherwise fix holdings cash but leave reconciliation_gap firing
      // forever. netManualAdjustments is a no-op when there are no such rows.
      const reconciliation = rawReconciliation
        ? netManualAdjustments(rawReconciliation, coreTxns)
        : rawReconciliation;
      const anomalies = detectAnomalies(coreTxns, cas, {
        cashCounted: portfolio.cashCounted,
        allowNegativeCash: portfolio.allowNegativeCash,
        reconciliationGap: reconciliation ?? null,
      });
      // Drop anomalies the user has explicitly dismissed for a specific transaction.
      const dismissedSet = new Set(dismissed.map((d) => `${d.transactionId}:${d.code}`));
      const filtered = anomalies.filter(
        (a) => !(a.transactionId && dismissedSet.has(`${a.transactionId}:${a.code}`)),
      );
      const durationMs = performance.now() - t0;
      logTiming(request, "GET /portfolios/:id/holdings", durationMs, {
        portfolioId,
        holdingCount: holdings.length,
        anomalyCount: filtered.length,
      });
      return { holdings, anomalies: filtered };
    },
  );

  // Lightweight anomalies endpoint — skips the computeHoldings call that the full
  // /holdings endpoint runs, making it faster when callers only need anomaly flags.
  app.get<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/anomalies",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      const portfolio = await ownedPortfolio(id, portfolioId);
      if (!portfolio) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const { filtered } = await withDerivationCache(anomaliesCache, portfolioId, async () => {
        const [rows, trConn, dismissed] = await Promise.all([
          app.db
            .select()
            .from(transactions)
            .where(eq(transactions.portfolioId, portfolioId)),
          app.db
            .select({ lastReconciliation: trConnections.lastReconciliation })
            .from(trConnections)
            .where(eq(trConnections.portfolioId, portfolioId))
            .limit(1)
            .then((r) => r[0] ?? null),
          app.db
            .select({
              transactionId: dismissedAnomalies.transactionId,
              code: dismissedAnomalies.code,
            })
            .from(dismissedAnomalies)
            .where(eq(dismissedAnomalies.portfolioId, portfolioId)),
        ]);
        const coreTxns: CoreTransaction[] = toCoreTxns(rows);
        const cas = await corporateActionsFor(rows.map((r) => r.instrumentId));
        const rawReconciliation = trConn?.lastReconciliation as
          | ReconciliationGap
          | null
          | undefined;
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
      const durationMs = performance.now() - t0;
      logTiming(request, "GET /portfolios/:id/anomalies", durationMs, {
        portfolioId,
        anomalyCount: filtered.length,
      });
      return { anomalies: filtered };
    },
  );

  // Full valuation summary: holdings priced via market data + cash + net worth.
  app.get<{ Params: PortfolioParams; Querystring: { costBasis?: string } }>(
    "/portfolios/:portfolioId/summary",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      const portfolio = await ownedPortfolio(id, portfolioId);
      if (!portfolio) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const { summary, metaById } = await loadValuation(
        portfolioId,
        portfolio.baseCurrency,
        costBasisFromQuery(request.query),
        portfolio.cashCounted,
        request.log,
      );
      // Self-heal: enqueue a sector sweep if any held instrument hasn't been
      // enriched yet (or has a stale attempt). Debounced to once per 6h.
      if (
        needsSectorEnrichment([...metaById.values()]) ||
        needsNameEnrichment([...metaById.values()])
      ) {
        void enqueueInstrumentMetadata();
      }
      const allocation = allocationBreakdown(summary, metaById);
      const drift = await loadDrift(id, portfolioId, allocation);
      const spark = await loadSparklines(
        app.db,
        summary.holdings.map((h) => h.instrumentId),
      );
      const durationMs = performance.now() - t0;
      logTiming(request, "GET /portfolios/:id/summary", durationMs, {
        portfolioId,
        holdingCount: summary.holdings.length,
      });
      return {
        ...summary,
        holdings: summary.holdings.map((h) => ({
          ...h,
          instrument: metaById.get(h.instrumentId) ?? null,
          sparkline: spark.get(h.instrumentId),
        })),
        allocation,
        ...(Object.keys(drift).length > 0 ? { drift } : {}),
      };
    },
  );

  // Net-worth-over-time for one portfolio, from the daily snapshots (base currency).
  app.get<{ Params: PortfolioParams; Querystring: { range?: string } }>(
    "/portfolios/:portfolioId/history",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      if (!(await ownedPortfolio(id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const range = request.query.range ?? "1y";

      // 1D/7D: read the intraday (timestamped) table instead of the day-grained one.
      // No stored intraday history exists to backfill — this is prospective-only, so an
      // empty array is a normal, expected response until the capture job has run.
      if (range === "1d" || range === "7d") {
        const since = new Date(Date.now() - (range === "1d" ? 1 : 7) * 86_400_000);
        const rows = await app.db
          .select()
          .from(portfolioIntradaySnapshots)
          .where(
            and(
              eq(portfolioIntradaySnapshots.portfolioId, portfolioId),
              gte(portfolioIntradaySnapshots.capturedAt, since),
            ),
          )
          .orderBy(asc(portfolioIntradaySnapshots.capturedAt));
        const intradayDurationMs = performance.now() - t0;
        logTiming(request, "GET /portfolios/:id/history", intradayDurationMs, {
          portfolioId,
          range,
          pointCount: rows.length,
        });
        return rows.map((r) => ({
          at: r.capturedAt.toISOString(),
          netWorth: r.netWorth,
          marketValue: r.marketValue ?? "0",
        }));
      }

      const start = rangeStart(range);
      const conds = [eq(portfolioSnapshots.portfolioId, portfolioId)];
      if (start) conds.push(gte(portfolioSnapshots.date, start));
      const rows = await app.db
        .select()
        .from(portfolioSnapshots)
        .where(and(...conds))
        .orderBy(asc(portfolioSnapshots.date));

      // Compute TWR chain from stored (marketValue, effectiveFlow) pairs.
      const series = rows.map((r) => ({
        date: r.date,
        marketValue: r.marketValue ?? "0",
        effectiveFlow: r.effectiveFlow ?? "0",
      }));
      const indexed = chainIndex(series);
      const indexById = new Map(indexed.map((p) => [p.date, p]));

      const result = rows.map((r) => ({
        date: r.date,
        netWorth: r.netWorth,
        marketValue: r.marketValue ?? "0",
        index: indexById.get(r.date)?.index ?? "100",
        pct: indexById.get(r.date)?.pct ?? "0",
      }));
      const durationMs = performance.now() - t0;
      logTiming(request, "GET /portfolios/:id/history", durationMs, {
        portfolioId,
        range,
        pointCount: rows.length,
      });
      return result;
    },
  );

  // Money-weighted return (XIRR) from external cash flows + current net worth.
  app.get<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/performance",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      const portfolio = await ownedPortfolio(id, portfolioId);
      if (!portfolio) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const boundary = portfolio.cashCounted ? "inside" : "outside";
      const cached = await withDerivationCache(performanceCache, `${portfolioId}:${boundary}`, async () => {
        const { coreTxns, summary } = await loadValuation(
          portfolioId,
          portfolio.baseCurrency,
          undefined,
          portfolio.cashCounted,
        );

        const flows = await boundaryFlows(coreTxns, boundary, portfolio.baseCurrency);
        const asOf = new Date();
        flows.push({ amount: Number(summary.netWorth), date: asOf });

        const rate = xirr(flows);
        return {
          xirr: Number.isFinite(rate) ? rate : null,
          netWorth: summary.netWorth,
          asOf: asOf.toISOString(),
        };
      });
      const durationMs = performance.now() - t0;
      logTiming(request, "GET /portfolios/:id/performance", durationMs, {
        portfolioId,
      });
      return cached;
    },
  );

  // Contribution analytics for a single portfolio (in its base currency).
  app.get<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/contributions",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      const portfolio = await ownedPortfolio(id, portfolioId);
      if (!portfolio) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const { coreTxns, summary } = await loadValuation(
        portfolioId,
        portfolio.baseCurrency,
        undefined,
        portfolio.cashCounted,
      );
      const result = buildContributions(
        coreTxns,
        summary,
        portfolio.baseCurrency,
        portfolio.birthYear,
        portfolio.portfolioType === "child" ? "child" : "standard",
        portfolio.cashCounted ? "inside" : "outside",
      );
      const durationMs = performance.now() - t0;
      logTiming(request, "GET /portfolios/:id/contributions", durationMs, {
        portfolioId,
      });
      return result;
    },
  );

  // Trade log for a single portfolio: round-trip episodes with realized/unrealized
  // P&L, folded-in dividends, per-trade return and a tax-by-year breakdown.
  app.get<{ Params: PortfolioParams; Querystring: { method?: string; costBasis?: string } }>(
    "/portfolios/:portfolioId/trades",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      const portfolio = await ownedPortfolio(id, portfolioId);
      if (!portfolio) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const method = methodFromQuery(request.query);
      const costBasisMode = costBasisFromQuery(request.query);
      const cached = await withDerivationCache(tradesCache, `${portfolioId}:${method}:${costBasisMode}`, async () => {
        const { coreTxns, prices, metaById } = await loadValuation(
          portfolioId,
          portfolio.baseCurrency,
          costBasisMode,
          portfolio.cashCounted,
        );
        const log = await buildTradeLog(
          coreTxns,
          prices,
          portfolio.baseCurrency,
          method,
          costBasisMode,
          metaById,
        );
        return attachInstruments(log, metaById);
      });
      const durationMs = performance.now() - t0;
      logTiming(request, "GET /portfolios/:id/trades", durationMs, {
        portfolioId,
        method,
        costBasis: costBasisMode,
      });
      return cached;
    },
  );

  // Aggregate net worth across all of the user's portfolios, in their display
  // currency — combined holdings, cash, totals, and money-weighted return.
  app.get<{ Querystring: { costBasis?: string; holderId?: string; period?: string } }>(
    "/networth",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const { holderId } = request.query;
      const [u] = await app.db
        .select({ displayCurrency: users.displayCurrency })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      const display = u?.displayCurrency ?? "IDR";
      const costBasisMode = costBasisFromQuery(request.query);

      // Period selector: ytd | 1y | 5y | max (default)
      const period = ["ytd", "1y", "5y"].includes(request.query.period ?? "")
        ? (request.query.period as "ytd" | "1y" | "5y")
        : "max";
      const today = new Date();
      let periodStart: Date | null = null;
      if (period === "ytd") {
        periodStart = new Date(today.getFullYear(), 0, 1);
      } else if (period === "1y") {
        periodStart = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
      } else if (period === "5y") {
        periodStart = new Date(today.getFullYear() - 5, today.getMonth(), today.getDate());
      }

      if (holderId != null) {
        const [holder] = await app.db
          .select()
          .from(accountHolders)
          .where(and(eq(accountHolders.id, holderId), eq(accountHolders.userId, id)))
          .limit(1);
        if (!holder) return reply.status(404).send({ code: "holder_not_found" });
      }

      const pfs = await app.db
        .select()
        .from(portfolios)
        .where(
          holderId != null
            ? and(eq(portfolios.userId, id), eq(portfolios.accountHolderId, holderId))
            : eq(portfolios.userId, id),
        );

      // Each portfolio's money-weighted flows are computed under its own boundary
      // (cash-inside vs cash-outside), then concatenated — the aggregate spans
      // portfolios with different boundaries, so there is no single boundary to pass.
      // Bounded-concurrency (see PORTFOLIO_VALUATION_CONCURRENCY): each portfolio is
      // independent, so this used to be a serial `for` await — one portfolio's DB round
      // trips blocked the next's. mapPool preserves input order, so the merge below is
      // byte-for-byte identical to the old sequential push loop.
      const perPortfolio = await mapPool(pfs, PORTFOLIO_VALUATION_CONCURRENCY, async (p) => {
        const { coreTxns, summary } = await loadValuation(
          p.id,
          display,
          costBasisMode,
          p.cashCounted,
        );
        const flows = await boundaryFlows(coreTxns, p.cashCounted ? "inside" : "outside", display);
        return { summary, flows };
      });
      const summaries = perPortfolio.map((r) => r.summary);
      const instrumentIds = new Set<string>();
      const flows: CashFlowPoint[] = perPortfolio.flatMap((r) => r.flows);
      for (const { summary } of perPortfolio) {
        for (const h of summary.holdings) instrumentIds.add(h.instrumentId);
      }

      const aggregated = aggregatePortfolios(summaries, display);
      const meta = await instrumentMeta([...instrumentIds]);
      const spark = await loadSparklines(app.db, [...instrumentIds]);
      const holdings = aggregated.holdings.map((h) => ({
        ...h,
        instrument: meta.get(h.instrumentId) ?? null,
        sparkline: spark.get(h.instrumentId),
      }));

      // Self-heal: enqueue a sector sweep if any held instrument hasn't been
      // enriched yet (or has a stale attempt). Debounced to once per 6h.
      if (
        needsSectorEnrichment([...meta.values()]) ||
        needsNameEnrichment([...meta.values()])
      ) {
        void enqueueInstrumentMetadata();
      }

      const asOf = new Date();
      flows.push({ amount: Number(aggregated.netWorth), date: asOf });
      const rate = xirr(flows);

      const allocation = allocationBreakdown(aggregated, meta);
      const drift = await loadDrift(id, null, allocation);

      // Period-scoped XIRR and P&L: look up the earliest snapshot per portfolio at or
      // after periodStart, FX-convert each to display currency on its own snapshot date,
      // and sum them. One query per portfolio avoids the cross-portfolio ordering hazard.
      //
      // We track the actual snapshot anchor date (not the nominal periodStart) so that
      // the flow-filter in periodXirr is aligned: flows embedded in the snapshot value
      // must not be re-added as explicit post-flows.
      let startNav: number | null = null;
      let anchorDate: Date | null = null; // actual snapshot date (may lag periodStart by a day or two)
      if (periodStart !== null && pfs.length > 0) {
        const periodStartStr = periodStart.toISOString().slice(0, 10);
        // Per-portfolio snapshot + FX fetch is independent — bounded-concurrency instead
        // of a serial `for` await. The reduction below (sum, count, max-date) is
        // order-independent, so parallelizing the I/O doesn't change the result.
        const perPortfolio = await mapPool(pfs, PORTFOLIO_VALUATION_CONCURRENCY, async (pf) => {
          // Fetch the earliest snapshot at or after periodStart for this portfolio.
          const [snap] = await app.db
            .select()
            .from(portfolioSnapshots)
            .where(and(eq(portfolioSnapshots.portfolioId, pf.id), gte(portfolioSnapshots.date, periodStartStr)))
            .orderBy(asc(portfolioSnapshots.date))
            .limit(1);
          if (!snap) {
            // Portfolio has no snapshot at or after periodStart (brand-new or no history).
            return null;
          }
          const ratesByDate = await getFxRatesForDates(app.db, [snap.currency], display, [snap.date]);
          const fx = makeFxRateFn(ratesByDate.get(snap.date) ?? {}, display);
          return {
            nav: Number(convert(snap.netWorth, snap.currency, display, fx)),
            date: snap.date,
          };
        });

        let totalStartNav = 0;
        let missingPortfolios = 0;
        let latestSnapDate: string | null = null;
        for (const r of perPortfolio) {
          if (!r) {
            missingPortfolios++;
            continue;
          }
          totalStartNav += r.nav;
          // Use the latest snapshot date across all portfolios as the flow-filter anchor.
          // This ensures no portfolio's snapshot embeds flows that are then re-added.
          if (latestSnapDate === null || r.date > latestSnapDate) {
            latestSnapDate = r.date;
          }
        }
        // Only produce a startNav when all portfolios contributed — partial sums would
        // under-count the denominator and manufacture phantom period gains.
        if (missingPortfolios === 0 && latestSnapDate !== null) {
          startNav = totalStartNav;
          anchorDate = new Date(`${latestSnapDate}T00:00:00.000Z`);
        }
      }

      const currentNetWorth = Number(aggregated.netWorth);
      // flows has the terminal inflow as its last entry; strip it to get boundary-only flows.
      const boundaryOnlyFlows = flows.slice(0, -1);
      const pXirr =
        anchorDate !== null && startNav !== null
          ? periodXirr(boundaryOnlyFlows, currentNetWorth, startNav, anchorDate, asOf)
          : null;
      const periodPnL =
        anchorDate !== null && startNav !== null
          ? String(currentNetWorth - startNav)
          : null;
      const periodPnLPct =
        anchorDate !== null && startNav !== null && startNav > 0
          ? String((currentNetWorth - startNav) / startNav)
          : null;

      const durationMs = performance.now() - t0;
      logTiming(request, "GET /networth", durationMs, {
        portfolioCount: pfs.length,
        period,
        holderId: holderId ?? null,
        costBasisMode,
      });

      return {
        ...aggregated,
        holdings,
        allocation,
        ...(Object.keys(drift).length > 0 ? { drift } : {}),
        xirr: Number.isFinite(rate) ? rate : null,
        periodXirr: pXirr,
        periodPnL,
        periodPnLPct,
        period,
        portfolioCount: pfs.length,
        asOf: asOf.toISOString(),
      };
    },
  );

  // Income analytics across all of the user's portfolios (or a holder subset), in their
  // display currency: per-period totals, forecast, delta, breakdowns, yields, upcoming
  // coupons + events. Optional `holderId` narrows the result to portfolios linked to that
  // account holder (must be owned by the requesting user).
  app.get<{ Querystring: { holderId?: string; eventsYear?: string } }>(
    "/networth/income",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
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

      // Independent per portfolio — bounded-concurrency instead of a serial `for` await
      // (see PORTFOLIO_VALUATION_CONCURRENCY). mapPool preserves input order, so the
      // merge below is identical to the old sequential push loop.
      const perPortfolio = await mapPool(pfs, PORTFOLIO_VALUATION_CONCURRENCY, async (p) => {
        const { coreTxns, summary } = await loadValuation(p.id, display, undefined, p.cashCounted);
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
        const meta = await instrumentMeta(
          [...new Set(
            perPortfolio.flatMap((p) => p.coreTxns)
              .filter((t) => t.type === "dividend" || t.type === "coupon")
              .map((t) => t.instrumentId)
              .filter(Boolean),
          )] as string[],
        );
        const events = perPortfolio.flatMap((p) => p.coreTxns)
          .filter((t) =>
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
              date: t.executedAt.toISOString().slice(0, 10),
              amount: t.price,
              currency: t.currency,
              perShare: null as string | null,
              quantity: null as string | null,
            };
          })
          .sort((a, b) => b.date.localeCompare(a.date));
        const durationMs = performance.now() - t0;
        logTiming(request, "GET /networth/income (eventsYear)", durationMs, {
          portfolioCount: pfs.length,
          targetYear,
          eventCount: events.length,
        });
        return { displayCurrency: display, events };
      }

      const summaries = perPortfolio.map((r) => r.summary);
      const allTxns: CoreTransaction[] = perPortfolio.flatMap((r) => r.coreTxns);
      const aggregated = aggregatePortfolios(summaries, display);

      const durationMs = performance.now() - t0;
      logTiming(request, "GET /networth/income", durationMs, { portfolioCount: pfs.length });

      return buildIncomeStats(allTxns, aggregated, display, (txId) => txPortfolioId.get(txId));
    },
  );

  // Aggregate trade log across all of the user's portfolios, in their display
  // currency. Each portfolio's trades are computed under its own settings, then merged
  // (a position held in two portfolios is two trades).
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
        if (!holder) return reply.status(404).send({ code: "holder_not_found" });
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
        `${id}:${method}:${costBasisMode}:${holderId ?? ""}`,
        async () => {
          const [u] = await app.db
            .select({ displayCurrency: users.displayCurrency })
            .from(users)
            .where(eq(users.id, id))
            .limit(1);
          const display = u?.displayCurrency ?? "IDR";

          const perPortfolio = await mapPool(pfs, PORTFOLIO_VALUATION_CONCURRENCY, async (p) => {
            const { coreTxns, prices, metaById } = await loadValuation(
              p.id,
              display,
              costBasisMode,
              p.cashCounted,
            );
            const log = await buildTradeLog(coreTxns, prices, display, method, costBasisMode, metaById);
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

  // Income analytics for a single portfolio (in its base currency).
  app.get<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/income",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      const portfolio = await ownedPortfolio(id, portfolioId);
      if (!portfolio) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const { coreTxns, summary } = await loadValuation(
        portfolioId,
        portfolio.baseCurrency,
        undefined,
        portfolio.cashCounted,
      );
      const result = buildIncomeStats(coreTxns, summary, portfolio.baseCurrency, () => portfolioId);
      const durationMs = performance.now() - t0;
      logTiming(request, "GET /portfolios/:id/income", durationMs, {
        portfolioId,
      });
      return result;
    },
  );

  // Sparplan detection for a single portfolio (in its base currency).
  app.get<{ Params: PortfolioParams; Querystring: { includeSales?: string } }>(
    "/portfolios/:portfolioId/sparplan",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      const includeSales = request.query.includeSales === "true";
      const portfolio = await ownedPortfolio(id, portfolioId);
      if (!portfolio) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const { coreTxns, summary, prices, metaById } = await loadValuation(
        portfolioId,
        portfolio.baseCurrency,
        undefined,
        portfolio.cashCounted,
      );
      const stats = await withDerivationCache(
        sparplanCache,
        `${portfolioId}:${portfolio.cashCounted ? "inside" : "outside"}`,
        () => buildSparplanStats(coreTxns, portfolio.baseCurrency),
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
        const durationMs = performance.now() - t0;
        logTiming(request, "GET /portfolios/:id/sparplan", durationMs, {
          portfolioId,
          hasTargets: false,
        });
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
        const durationMs = performance.now() - t0;
        logTiming(request, "GET /portfolios/:id/sparplan", durationMs, {
          portfolioId,
          hasTargets: true,
          includeSales: false,
        });
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
        const durationMs = performance.now() - t0;
        logTiming(request, "GET /portfolios/:id/sparplan", durationMs, {
          portfolioId,
          hasTargets: true,
          includeSales: true,
          taxRegime: "ID",
        });
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
        const durationMs = performance.now() - t0;
        logTiming(request, "GET /portfolios/:id/sparplan", durationMs, {
          portfolioId,
          hasTargets: true,
          includeSales: true,
          taxRegime: prefsRow?.taxRegime ?? "DE",
          fsaConfigured: false,
        });
        return { ...stats, drift, contributionSplit: split, taxUnavailable: true, taxRegime };
      }

      // Compute harvest suggestions using FIFO trade log.
      const tradeLog = await buildTradeLog(coreTxns, prices, portfolio.baseCurrency, "fifo", undefined, metaById);
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
      const suggestions = harvestSuggestions({ tradeLog, tfRates, allowanceAnnual, taxRate, usage });

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

      const durationMs = performance.now() - t0;
      logTiming(request, "GET /portfolios/:id/sparplan", durationMs, {
        portfolioId,
        hasTargets: true,
        includeSales: true,
        taxRegime,
        fsaConfigured: true,
        hasSellActions: tradeActions.some((a) => a.side === "sell"),
      });
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
      const t0 = performance.now();
      const { id } = requireUser(request);
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
        .select({ id: portfolios.id, cashCounted: portfolios.cashCounted, baseCurrency: portfolios.baseCurrency })
        .from(portfolios)
        .where(
          holderId != null
            ? and(eq(portfolios.userId, id), eq(portfolios.accountHolderId, holderId))
            : eq(portfolios.userId, id),
        );

      const result = await withDerivationCache(
        networthSparplanCache,
        `${id}:${display}:${holderId ?? ""}`,
        async () => {
          // Detect per portfolio in the display currency, then merge (not concatenate).
          // Independent per portfolio — bounded-concurrency instead of a serial `for` await
          // (see PORTFOLIO_VALUATION_CONCURRENCY). mapPool preserves input order.
          const portfolioResults = await mapPool(pfs, PORTFOLIO_VALUATION_CONCURRENCY, async (p) => {
            const { coreTxns } = await loadValuation(p.id, display, undefined, p.cashCounted);
            const ccys = [...new Set(coreTxns.map((t) => t.currency))];
            const rates = await getFxRates(app.db, ccys, display);
            const fx = makeFxRateFn(rates, display);
            return detectSparplans({ txns: coreTxns, displayCurrency: display, fx });
          });
          const perPortfolio: SparplanStats[] = portfolioResults;
          const allInstrumentIds = new Set<string>();
          for (const stats of perPortfolio) {
            for (const plan of stats.plans) allInstrumentIds.add(plan.instrumentId);
          }

          const merged = mergeSparplanStats(perPortfolio, display);
          const meta = await instrumentMeta([...allInstrumentIds]);
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
      const durationMs = performance.now() - t0;
      logTiming(request, "GET /networth/sparplan", durationMs, { portfolioCount: pfs.length });
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
      const t0 = performance.now();
      const { id } = requireUser(request);
      const { holderId } = request.query;
      const [u] = await app.db
        .select({ displayCurrency: users.displayCurrency })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      const display = u?.displayCurrency ?? "IDR";

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
        `${id}:${display}:${holderId ?? ""}`,
        async () => {
          // Independent per portfolio — bounded-concurrency instead of a serial `for` await
          // (see PORTFOLIO_VALUATION_CONCURRENCY). mapPool preserves input order, so the
          // merge below is identical to the old sequential push loop.
          const perPortfolioLoad = await mapPool(pfs, PORTFOLIO_VALUATION_CONCURRENCY, async (p) => {
            const { coreTxns, summary } = await loadValuation(p.id, display, undefined, p.cashCounted);
            return { summary, txns: coreTxns, boundary: p.cashCounted ? ("inside" as const) : ("outside" as const) };
          });
          const summaries: PortfolioSummary[] = perPortfolioLoad.map((r) => r.summary);
          const loaded: { txns: CoreTransaction[]; boundary: "inside" | "outside" }[] = perPortfolioLoad.map(
            (r) => ({ txns: r.txns, boundary: r.boundary }),
          );
          const allTxns: CoreTransaction[] = perPortfolioLoad.flatMap((r) => r.txns);
          const fx = makeFxRateFn(
            await getFxRates(app.db, [...new Set(allTxns.map((t) => t.currency))], display),
            display,
          );
          // Compute each portfolio under ITS boundary, then merge — so each portfolio keeps its
          // own boundary instead of being collapsed into one cross-portfolio bucket.
          const perPortfolio = loaded.map(({ txns, boundary }) =>
            contributionStats({ txns, displayCurrency: display, fx, boundary }),
          );
          // Money-weighted flows: each portfolio under its boundary, concatenated. Independent
          // per portfolio — bounded-concurrency instead of a serial `for` await.
          const flowsByPortfolio = await mapPool(loaded, PORTFOLIO_VALUATION_CONCURRENCY, ({ txns, boundary }) =>
            boundaryFlows(txns, boundary, display),
          );
          const flows: CashFlowPoint[] = flowsByPortfolio.flat();
          const aggregated = aggregatePortfolios(summaries, display);
          return enrichContributions(
            mergeContributionStats(perPortfolio, display),
            aggregated.netWorth,
            flows,
            holderBirthYear,
            holderPortfolioType,
          );
        },
      );
      const durationMs = performance.now() - t0;
      logTiming(request, "GET /networth/contributions", durationMs, { portfolioCount: pfs.length });
      return result;
    },
  );

  // Aggregate net-worth-over-time across all of the user's portfolios, summing each
  // day's snapshots converted to the display currency.
  app.get<{ Querystring: { range?: string; include?: string; exclude?: string; holderId?: string } }>(
    "/networth/history",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const { holderId } = request.query;
      const range = request.query.range ?? "1y";
      const includeParam = request.query.include ?? "";
      const excludeParam = request.query.exclude ?? "";

      if (holderId != null) {
        const [holder] = await app.db
          .select()
          .from(accountHolders)
          .where(and(eq(accountHolders.id, holderId), eq(accountHolders.userId, id)))
          .limit(1);
        if (!holder) return reply.status(404).send({ code: "holder_not_found" });
      }

      const pfs = await app.db
        .select({ id: portfolios.id, includeInAggregate: portfolios.includeInAggregate })
        .from(portfolios)
        .where(
          holderId != null
            ? and(eq(portfolios.userId, id), eq(portfolios.accountHolderId, holderId))
            : eq(portfolios.userId, id),
        );
      if (pfs.length === 0) return [];

      const pfIds = (() => {
        const inc = includeParam.split(",").filter(Boolean);
        const exc = excludeParam.split(",").filter(Boolean);
        if (inc.length > 0) {
          return pfs.filter((p) => inc.includes(p.id)).map((p) => p.id);
        }
        return pfs.filter((p) => p.includeInAggregate && !exc.includes(p.id)).map((p) => p.id);
      })();
      if (pfIds.length === 0) return [];

      const [u] = await app.db
        .select({ displayCurrency: users.displayCurrency })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      const display = u?.displayCurrency ?? "IDR";

      const cacheKey = `${id}:${range}:${holderId ?? ""}:${includeParam}:${excludeParam}`;
      const cached = await withDerivationCache(historyCache, cacheKey, async () => {

          // 1D/7D: aggregate the intraday (timestamped) table instead of the day-grained one.
          if (range === "1d" || range === "7d") {
            const since = new Date(Date.now() - (range === "1d" ? 1 : 7) * 86_400_000);
            const rows = await app.db
              .select()
              .from(portfolioIntradaySnapshots)
              .where(
                and(
                  inArray(portfolioIntradaySnapshots.portfolioId, pfIds),
                  gte(portfolioIntradaySnapshots.capturedAt, since),
                ),
              )
              .orderBy(asc(portfolioIntradaySnapshots.capturedAt));
            if (rows.length === 0) return [];

            const currencies = [...new Set(rows.map((r) => r.currency))];
            const fx = makeFxRateFn(await getFxRates(app.db, currencies, display), display);

            const byAt = new Map<string, { netWorth: number; marketValue: number }>();
            for (const r of rows) {
              const at = r.capturedAt.toISOString();
              const entry = byAt.get(at) ?? { netWorth: 0, marketValue: 0 };
              entry.netWorth += Number(convert(r.netWorth, r.currency, display, fx));
              entry.marketValue += Number(convert(r.marketValue ?? "0", r.currency, display, fx));
              byAt.set(at, entry);
            }
            return [...byAt.entries()]
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([at, v]) => ({
                at,
                netWorth: String(v.netWorth),
                marketValue: String(v.marketValue),
              }));
          }

          const start = rangeStart(range);
          const conds = [inArray(portfolioSnapshots.portfolioId, pfIds)];
          if (start) conds.push(gte(portfolioSnapshots.date, start));
          const rows = await app.db
            .select()
            .from(portfolioSnapshots)
            .where(and(...conds))
            .orderBy(asc(portfolioSnapshots.date));

          const currencies = [...new Set(rows.map((r) => r.currency))];
          const dates = [...new Set(rows.map((r) => r.date))];
          const ratesByDate = await getFxRatesForDates(app.db, currencies, display, dates);

          const perPortfolio = new Map<string, { date: string; marketValue: string; effectiveFlow: string; netWorth: string; currency: string }[]>();
          for (const r of rows) {
            const list = perPortfolio.get(r.portfolioId) ?? [];
            list.push(r);
            perPortfolio.set(r.portfolioId, list);
          }

          const allFlows: { date: string; marketValue: string; effectiveFlow: string }[][] = [];
          for (const [, pfRows] of perPortfolio) {
            const converted = pfRows.map((r) => {
              const fx = makeFxRateFn(ratesByDate.get(r.date) ?? {}, display);
              return {
                date: r.date,
                marketValue: convert(r.marketValue ?? "0", r.currency, display, fx),
                effectiveFlow: convert(r.effectiveFlow ?? "0", r.currency, display, fx),
              };
            });
            allFlows.push(converted);
          }

          const aggregated = aggregateValueFlows(allFlows);
          const indexed = chainIndex(aggregated);
          const indexById = new Map(indexed.map((p) => [p.date, p]));

          const nwByDate = new Map<string, number>();
          for (const r of rows) {
            const fx = makeFxRateFn(ratesByDate.get(r.date) ?? {}, display);
            const nw = Number(convert(r.netWorth, r.currency, display, fx));
            nwByDate.set(r.date, (nwByDate.get(r.date) ?? 0) + nw);
          }

          const result = aggregated.map((p) => ({
            date: p.date,
            netWorth: String(nwByDate.get(p.date) ?? 0),
            marketValue: p.marketValue,
            index: indexById.get(p.date)?.index ?? "100",
            pct: indexById.get(p.date)?.pct ?? "0",
          }));

          // Benchmark comparison: fetch prices and compute parallel TWR index.
          const bmConfig = await getUserBenchmarkConfig(app.db, id, display);
          if (result.length > 0) {
            const bmDates = result.map((p) => p.date);
            const existingBm = await getBenchmarkPrices(app.db, id, bmConfig.symbol, bmDates);
            const missingDates = bmDates.filter((d) => !existingBm.has(d));
            if (missingDates.length > 0) {
              const earliest = missingDates[0];
              try {
                const md = await getMarketData();
                await fetchBenchmarkPrices(app.db, md, id, bmConfig.symbol, earliest);
              } catch { /* non-fatal — benchmark is best-effort */ }
            }
            const refreshedBm = await getBenchmarkPrices(app.db, id, bmConfig.symbol, bmDates);
            if (refreshedBm.size > 1) {
              const bmPrices = bmDates
                .filter((d) => refreshedBm.has(d))
                .map((d) => ({ date: d, close: refreshedBm.get(d)! }));
              const bmIndex = computeBenchmarkIndex(bmPrices);
              const bmById = new Map(bmIndex.map((p) => [p.date, p]));
              for (const p of result) {
                const bp = bmById.get(p.date);
                if (bp) {
                  (p as { benchmarkIndex?: string; benchmarkPct?: string }).benchmarkIndex = bp.index;
                  (p as { benchmarkIndex?: string; benchmarkPct?: string }).benchmarkPct = bp.pct;
                }
              }
            }
          }

          return result;
        },
      );
      const durationMs = performance.now() - t0;
      logTiming(request, "GET /networth/history", durationMs, {
        portfolioCount: cached.length,
        range,
        resultCount: cached.length,
      });
      return cached;
    },
  );

  // Return a signed URL for the retained source document of a transaction (#231).
  // Resolves first by transactionId (TR future), then by the transaction's importId
  // (DKB, screenshot, CSV). IDOR guard: only the document owner can obtain a URL.
  app.get<{ Params: PortfolioParams & { txId: string } }>(
    "/portfolios/:portfolioId/transactions/:txId/document-url",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId, txId } = request.params;
      if (!(await ownedPortfolio(id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }

      // Fetch the transaction to get its importId.
      const [tx] = await app.db
        .select({ id: transactions.id, importId: transactions.importId })
        .from(transactions)
        .where(and(eq(transactions.id, txId), eq(transactions.portfolioId, portfolioId)))
        .limit(1);
      if (!tx) return reply.code(404).send({ error: "transaction_not_found" });

      const doc = await getDocumentForTransaction(app, tx.id, tx.importId);
      if (!doc) return reply.code(404).send({ error: "document_not_found" });

      // IDOR guard: verify document ownership explicitly.
      if (doc.userId !== id) return reply.code(403).send({ error: "forbidden" });

      // Build structured, date-first download filename using transaction scope.
      let filename: string | null = doc.originalFilename;
      try {
        const parts = await gatherDocumentNaming(app, {
          doc,
          portfolioId,
          txId: tx.id, // force transaction scope even for import-linked (DKB/CSV) docs
        });
        filename = buildDocumentName(parts);
      } catch {
        // Non-fatal: fall back to originalFilename.
      }

      const url = await app.storage.getSignedUrl(doc.storageKey, undefined, {
        downloadName: filename ?? undefined,
      });
      return { url, filename, mimeType: doc.mimeType };
    },
  );

  // Return a signed URL for the document linked to a specific transaction_sources row.
  // Allows per-leg PDF downloads for split orders (each leg has its own documentId).
  // IDOR guard: verify the source row's tx is in a portfolio owned by the user.
  app.get<{ Params: PortfolioParams & { txId: string; sourceId: string } }>(
    "/portfolios/:portfolioId/transactions/:txId/sources/:sourceId/document-url",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId, txId, sourceId } = request.params;
      if (!(await ownedPortfolio(id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }

      // Verify the transaction belongs to the portfolio (IDOR chain).
      const [tx] = await app.db
        .select({ id: transactions.id })
        .from(transactions)
        .where(and(eq(transactions.id, txId), eq(transactions.portfolioId, portfolioId)))
        .limit(1);
      if (!tx) return reply.code(404).send({ error: "transaction_not_found" });

      let doc: {
        id: string;
        storageKey: string;
        originalFilename: string | null;
        mimeType: string;
        source: string | null;
        storedAt: Date;
        importId: string | null;
        transactionId: string | null;
        userId: string;
      } | null;

      // `doc:<documentId>` — a synthetic source id from sourcesForTransactions, standing in
      // for a retained document with no (or no longer matching) transaction_sources row of its
      // own. Resolve directly by document id, scoped to this transaction (IDOR chain).
      if (sourceId.startsWith("doc:")) {
        const documentId = sourceId.slice("doc:".length);
        const [row] = await app.db
          .select({
            id: documents.id,
            storageKey: documents.storageKey,
            originalFilename: documents.originalFilename,
            mimeType: documents.mimeType,
            source: documents.source,
            storedAt: documents.storedAt,
            importId: documents.importId,
            transactionId: documents.transactionId,
            userId: documents.userId,
          })
          .from(documents)
          .where(and(eq(documents.id, documentId), eq(documents.transactionId, txId)))
          .limit(1);
        doc = row ?? null;
      } else {
        // Fetch the transaction_sources row and verify it belongs to this transaction.
        const [sourceRow] = await app.db
          .select({
            id: transactionSources.id,
            documentId: transactionSources.documentId,
            importId: transactionSources.importId,
          })
          .from(transactionSources)
          .where(
            and(eq(transactionSources.id, sourceId), eq(transactionSources.transactionId, txId)),
          )
          .limit(1);
        if (!sourceRow) return reply.code(404).send({ error: "source_not_found" });

        // Resolve the document: the row's own documentId (retained PDF imports), else fall
        // back to getDocumentForTransaction (transaction-scoped doc first — correct for TR,
        // whose collector import holds many docs — then the import-linked doc, the common CSV
        // case where documentId is null because the file is linked at documents.importId).
        if (sourceRow.documentId) {
          const [row] = await app.db
            .select({
              id: documents.id,
              storageKey: documents.storageKey,
              originalFilename: documents.originalFilename,
              mimeType: documents.mimeType,
              source: documents.source,
              storedAt: documents.storedAt,
              importId: documents.importId,
              transactionId: documents.transactionId,
              userId: documents.userId,
            })
            .from(documents)
            .where(eq(documents.id, sourceRow.documentId))
            .limit(1);
          doc = row ?? null;
        } else {
          doc = await getDocumentForTransaction(app, txId, sourceRow.importId);
        }
      }
      if (!doc) return reply.code(404).send({ error: "document_not_found" });
      // IDOR: document must belong to the authenticated user.
      if (doc.userId !== id) return reply.code(403).send({ error: "forbidden" });

      // Build structured, date-first download filename using transaction scope.
      let filename: string | null = doc.originalFilename;
      try {
        const parts = await gatherDocumentNaming(app, {
          doc,
          portfolioId,
          txId, // force transaction scope for per-leg downloads
        });
        filename = buildDocumentName(parts);
      } catch {
        // Non-fatal: fall back to originalFilename.
      }

      const url = await app.storage.getSignedUrl(doc.storageKey, undefined, {
        downloadName: filename ?? undefined,
      });
      return { url, filename, mimeType: doc.mimeType };
    },
  );

  // Bulk-export all retained documents for a portfolio as a zip archive (#structured-naming).
  // Each entry gets a structured, date-first name. Documents shared by many transactions
  // (DKB/CSV/screenshot statement imports) appear once with a statement-level name.
  // IDOR guard: portfolio must be owned by the authenticated user.
  app.get<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/documents/export",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      if (!(await ownedPortfolio(id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }

      // Fetch all retained docs for this portfolio. De-dup by document id (a statement
      // doc shared across N transactions must appear only once in the archive).
      const docs = await app.db
        .select({
          id: documents.id,
          storageKey: documents.storageKey,
          mimeType: documents.mimeType,
          originalFilename: documents.originalFilename,
          source: documents.source,
          storedAt: documents.storedAt,
          importId: documents.importId,
          transactionId: documents.transactionId,
          userId: documents.userId,
        })
        .from(documents)
        .where(
          and(eq(documents.portfolioId, portfolioId), eq(documents.status, "retained")),
        );

      if (docs.length === 0) {
        return reply.code(404).send({ error: "no_documents" });
      }

      // Build structured names and collect bytes. Names must be unique within the archive;
      // append a numeric suffix (-2, -3, …) on collision.
      const usedNames = new Set<string>();

      function dedupeFilename(name: string): string {
        if (!usedNames.has(name)) {
          usedNames.add(name);
          return name;
        }
        // Split at the last dot for extension-safe suffix insertion.
        const dotIdx = name.lastIndexOf(".");
        const base = dotIdx >= 0 ? name.slice(0, dotIdx) : name;
        const ext = dotIdx >= 0 ? name.slice(dotIdx) : "";
        let n = 2;
        let candidate = `${base}-${n}${ext}`;
        while (usedNames.has(candidate)) {
          n++;
          candidate = `${base}-${n}${ext}`;
        }
        usedNames.add(candidate);
        return candidate;
      }

      // Dynamically import fflate to avoid bundling it into every route if unused.
      const { zipSync } = await import("fflate");

      const entries: Record<string, Uint8Array> = {};

      for (const doc of docs) {
        let entryName: string;
        try {
          const parts = await gatherDocumentNaming(app, { doc, portfolioId });
          entryName = buildDocumentName(parts);
        } catch {
          entryName = doc.originalFilename ?? `document_${doc.id.slice(0, 8)}`;
        }
        entryName = dedupeFilename(entryName);

        const buf = await app.storage.get(doc.storageKey);
        if (!buf) {
          app.log.warn({ docId: doc.id, key: doc.storageKey }, "export: object not found, skipping");
          continue;
        }
        entries[entryName] = new Uint8Array(buf);
      }

      const [portfolio] = await app.db
        .select({ name: portfolios.name })
        .from(portfolios)
        .where(eq(portfolios.id, portfolioId))
        .limit(1);

      const archiveName = portfolio
        ? `${portfolio.name.replace(/[^\w-]/g, "-")}_documents.zip`
        : "documents.zip";

      const zipped = zipSync(entries);

      void reply.header("Content-Type", "application/zip");
      void reply.header("Content-Disposition", `attachment; filename="${archiveName}"`);
      void reply.header("Content-Length", String(zipped.length));
      return reply.code(200).send(Buffer.from(zipped));
    },
  );

  // ---------------------------------------------------------------------------
  // German tax optimization: Sparerpauschbetrag headroom + harvest suggestions
  // ---------------------------------------------------------------------------


  /**
   * Fetch a holder's seeded loss carry-forward for one tax year, shaped for
   * `allowanceUsageYTD`'s `lossCarryForward` input. Empty object when nothing was seeded
   * (the default — moot until a real loss is ever certified for this holder).
   */
  async function lossCarryForwardFor(
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
    coreTxns: CoreTransaction[],
    summary: PortfolioSummary,
    display: string,
    year: number,
    now: Date = new Date(),
  ): Promise<string> {
    if (year !== now.getUTCFullYear()) return "0";

    const heldIds = summary.holdings
      .filter((h) => Number(h.quantity) > 0)
      .map((h) => h.instrumentId);
    if (heldIds.length === 0) return "0";

    const heldQtyMap = new Map<string, string>(
      summary.holdings
        .filter((h) => Number(h.quantity) > 0)
        .map((h) => [h.instrumentId, h.quantity]),
    );

    // qtyAt: historical quantity at ex-date is used by projectDividends to compute
    // per-share amounts. For a forward-looking forecast, current qty is an adequate
    // proxy — replaces expensive computeHoldings replays per unique dividend date.
    const qtyAt = (_instrumentId: string, _at: Date): string =>
      heldQtyMap.get(_instrumentId) ?? "0";

    // Map coreTxns → IncomeEntry for projectDividends.
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

    // Per-instrument gross-up ratio from trailing-12-month dividend history.
    // ratio = (netSum + taxSum) / netSum.  Default 1.0 when no withholding tax recorded.
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

    // Rest-of-year projected dividends (net amounts, based on last year's history).
    const projectedDivs = projectDividends(pastDivEvents, heldQtyMap, qtyAt, now);

    // Announced dividend_events blend: for instruments with announced future payments,
    // drop the projected estimates and use the announced amounts instead (same logic as
    // the income route's blend at ~lines 611-637).
    const todayStr = now.toISOString().slice(0, 10);
    const yearEndStr = new Date(Date.UTC(now.getUTCFullYear(), 11, 31))
      .toISOString()
      .slice(0, 10);

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

    // Bond coupons rest-of-year (coupon amounts are gross by construction: faceValue × rate).
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

    // FX rates for all forecast currencies.
    const allCcys = new Set<string>([
      ...blendedProjected.map((d) => d.currency),
      ...announcedRestOfYear.map((d) => d.currency),
      ...restOfYearCoupons.map((c) => c.currency),
    ]);
    if (allCcys.size === 0) return "0";

    const rates = await getFxRates(app.db, [...allCcys], display);
    const fx = makeFxRateFn(rates, display);

    // Accumulate: grossed-up projected + announced (gross) + coupons (gross).
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

      const portfolio = await ownedPortfolio(id, portfolioId);
      if (!portfolio) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }

      // The FSA slice lives on the portfolio itself.
      if (!portfolio.taxAllowanceAnnual) {
        return reply.code(422).send({ error: "tax_allowance_not_configured" });
      }

      const now = new Date();
      const year = request.query.year ? parseInt(request.query.year, 10) : now.getUTCFullYear();

      // Fetch holder (if any) for personal tax rate + cap + distribution context.
      const holderId = portfolio.accountHolderId;
      let holderProfile: {
        taxAllowanceAnnual: string | null;
        capitalGainsTaxRate: string | null;
      } | null = null;
      let totalAllocatedForHolder = Number(portfolio.taxAllowanceAnnual);
      // Loss carry-forward is a per-PERSON figure (German tax is assessed across all of a
      // holder's depots), so it's only correct to apply it here when this portfolio IS the
      // holder's only depot — otherwise a multi-depot holder's whole carry-forward would be
      // misattributed to whichever single depot happens to be viewed. Multi-depot holders
      // get the authoritative combined answer from GET /networth/tax instead; this route
      // omits carry-forward with a disclaimer rather than guessing an allocation.
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
          lossCarryForwardFor(holderId, year),
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
        portfolioId,
        portfolio.baseCurrency,
        undefined,
        portfolio.cashCounted,
      );
      const { coreTxns, prices, metaById, summary, corporateActions: cas, fxRates } = valuation;
      const cacheKey = derivationCacheKey(
        portfolioId, portfolio.baseCurrency, undefined, portfolio.cashCounted,
      );
      const tradeLog = await getCachedFifoTradeLog(
        cacheKey, coreTxns, prices, portfolio.baseCurrency, metaById, cas, fxRates,
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
        coreTxns, summary, portfolio.baseCurrency, year, now,
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
      const suggestions = harvestSuggestions({ tradeLog, tfRates, allowanceAnnual, taxRate, year, usage });

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
        // The same Teilfreistellung rates `usage`/`suggestions` were computed with,
        // keyed by instrumentId — so the frontend can Tf-adjust a per-disposal-row gain
        // WITHOUT re-deriving the asset-class-default logic (which would silently
        // disagree with this response whenever a manual per-instrument override is set;
        // tfRatesFor() above is the single source of truth for this rate).
        tfRatesByInstrument: tfRates,
        // Whether this response applied the holder's seeded loss carry-forward — false
        // for a multi-depot holder (see the comment above); the frontend should show a
        // disclaimer pointing to the holder-aggregated /networth/tax view in that case.
        carryForwardApplied,
        // Holder distribution context — used by the edit-portfolio modal helper.
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
      const year = request.query.year ? parseInt(request.query.year, 10) : new Date().getUTCFullYear();

      const [u] = await app.db
        .select({ displayCurrency: users.displayCurrency })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      const display = u?.displayCurrency ?? "IDR";

      // If a holderId is specified, validate it belongs to the user.
      if (filterHolderId != null) {
        const [holder] = await app.db
          .select()
          .from(accountHolders)
          .where(and(eq(accountHolders.id, filterHolderId), eq(accountHolders.userId, id)))
          .limit(1);
        if (!holder) return reply.status(404).send({ code: "holder_not_found" });
      }

      // Fetch all holders (cap is on the holder; actual FSA allocations are per-portfolio).
      const holderRows = await app.db
        .select()
        .from(accountHolders)
        .where(
          filterHolderId != null
            ? and(eq(accountHolders.userId, id), eq(accountHolders.id, filterHolderId))
            : eq(accountHolders.userId, id),
        );

      const perHolderResults = await mapPool(holderRows, 2, async (holder) => {
        // Portfolios belonging to this holder (include taxAllowanceAnnual for FSA sum).
        const pfs = await app.db
          .select({ id: portfolios.id, cashCounted: portfolios.cashCounted, taxAllowanceAnnual: portfolios.taxAllowanceAnnual })
          .from(portfolios)
          .where(and(eq(portfolios.userId, id), eq(portfolios.accountHolderId, holder.id)));

        if (pfs.length === 0) return null;

        // Sum per-depot FSA allocations. Skip this holder if no depot has an allocation.
        const totalAllocated = pfs.reduce((sum, p) => sum + Number(p.taxAllowanceAnnual ?? 0), 0);
        if (totalAllocated === 0) return null;

        // Merge trade logs across all portfolios; accumulate rest-of-year income forecast.
        // Independent per portfolio — bounded-concurrency instead of a serial `for` await
        // (see PORTFOLIO_VALUATION_CONCURRENCY). mapPool preserves input order, so
        // merging `logs`/`meta` below in order reproduces the old sequential loop's
        // behavior exactly (including last-write-wins for a shared instrument's meta),
        // and summing the forecast is order-independent.
        const now = new Date();
        const perPortfolio = await mapPool(pfs, PORTFOLIO_VALUATION_CONCURRENCY, async (p) => {
          const { coreTxns, prices, metaById, summary } = await loadValuation(p.id, display, undefined, p.cashCounted);
          const log = await buildTradeLog(coreTxns, prices, display, "fifo", undefined, metaById);
          const pfForecast = await restOfYearForecastGross(coreTxns, summary, display, year, now);
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
        const forecastIncomeRestOfYear = totalForecastGross > 0 ? totalForecastGross.toFixed(2) : "0";
        // Holder-aggregated across ALL of this person's depots — the authoritative scope
        // for a per-person loss carry-forward (see the single-depot route's comment for
        // why it can't safely apply this itself when a holder has more than one depot).
        const lossCarryForward = await lossCarryForwardFor(holder.id, year);

        // Distribution context: how much of the per-person cap has been allocated.
        const holderAllowanceCap = Number(holder.taxAllowanceAnnual ?? 1000);
        const remainingToDistribute = Math.max(0, holderAllowanceCap - totalAllocated);
        const overAllocated = totalAllocated > holderAllowanceCap;

        // allowanceAnnual for the aggregate computation = the person's legal Sparerpauschbetrag
        // cap (holder.taxAllowanceAnnual, default €1,000). The FSA sum is for the distribution
        // display only — under-allocation is reconciled via Anlage KAP at year-end, so harvest
        // suggestion headroom is correctly the full cap, not the allocated portion.
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
        const suggestions = harvestSuggestions({ tradeLog: mergedLog, tfRates, allowanceAnnual, taxRate, year, usage });

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
          // See /portfolios/:id/tax's identical field for why this is returned rather
          // than re-derived client-side.
          tfRatesByInstrument: tfRates,
          // Always true here — this route aggregates every depot for the holder, the
          // correct scope for a per-person carry-forward (see /portfolios/:id/tax's
          // conditional version of this same flag).
          carryForwardApplied: true,
          // Distribution summary across this holder's depots.
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

  // Lightweight FX rate lookup for the transaction detail sheet.
  app.get<{
    Querystring: { from: string; to: string; date: string };
  }>(
    "/fx-rate",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { from, to, date } = request.query;
      if (!from || !to || !date) {
        return reply.code(400).send({ error: "from, to, and date are required" });
      }
      const rates = await getFxRatesForDates(app.db, [from], to, [date]);
      const rate = rates.get(date)?.[from] ?? null;
      return { rate };
    },
  );

  // Lightweight income-only query for the tax year detail breakdown.
  // Returns raw transaction rows (no instrument/sources enrichment) matching
  // ACTIVITY_INCOME_TYPES for the given year, newest first.
  app.get<{
    Params: PortfolioParams;
    Querystring: { year?: string };
  }>(
    "/portfolios/:portfolioId/income-year",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const portfolio = await ownedPortfolio(id, request.params.portfolioId);
      if (!portfolio) return reply.code(404).send({ error: "portfolio_not_found" });

      const year = parseInt(request.query.year ?? String(new Date().getUTCFullYear()), 10);
      const { start, end } = yearRange(year);
      const rows = await app.db
        .select()
        .from(transactions)
        .where(and(
          eq(transactions.portfolioId, request.params.portfolioId),
          inArray(transactions.type, ACTIVITY_INCOME_TYPES),
          gte(transactions.executedAt, start),
          lt(transactions.executedAt, end),
        ))
        .orderBy(desc(transactions.executedAt));

      return rows;
    },
  );

  // ── Insights (risk metrics, drawdown, volatility, streaks, benchmark, concentration trend) ──────
  app.get<{ Querystring: { range?: string; holderId?: string; portfolioId?: string } }>(
    "/insights",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const { holderId, portfolioId } = request.query;
      const range = request.query.range ?? "all";

      const pfs = await app.db
        .select({ id: portfolios.id, includeInAggregate: portfolios.includeInAggregate, cashCounted: portfolios.cashCounted })
        .from(portfolios)
        .where(
          portfolioId != null
            ? and(eq(portfolios.userId, id), eq(portfolios.id, portfolioId))
            : holderId != null
              ? and(eq(portfolios.userId, id), eq(portfolios.accountHolderId, holderId))
              : eq(portfolios.userId, id),
        );
      if (pfs.length === 0) {
        return reply.send({
          drawdown: { maxDrawdownPct: "0", peakDate: null, troughDate: null, currentDrawdownPct: "0" },
          volatility: { annualizedVolatility: null, sharpeRatio: null, sortinoRatio: null },
          streaks: { bestStreak: null, worstStreak: null, bestMonth: null, worstMonth: null, bestYear: null, worstYear: null, positiveMonths: 0, negativeMonths: 0, totalMonths: 0 },
          benchmark: null,
          concentrationTrend: [],
          bestWorstMonthly: { best: null, worst: null },
          bestWorstYearly: { best: null, worst: null },
        });
      }

      const [u] = await app.db
        .select({ displayCurrency: users.displayCurrency })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      const display = u?.displayCurrency ?? "IDR";

      const cacheKey = `insights:${id}:${range}:${holderId ?? ""}:${portfolioId ?? ""}`;
      const result = await withDerivationCache(insightsCache, cacheKey, async () => {
        // ── Portfolio history (TWR index) ──────────────────────────────
        const start = rangeStart(range);
        const conds = [inArray(portfolioSnapshots.portfolioId, pfs.map((p) => p.id))];
        if (start) conds.push(gte(portfolioSnapshots.date, start));
        const snapshots = await app.db
          .select()
          .from(portfolioSnapshots)
          .where(and(...conds))
          .orderBy(asc(portfolioSnapshots.date));

        if (snapshots.length === 0) {
          return {
            drawdown: { maxDrawdownPct: "0", peakDate: null, troughDate: null, currentDrawdownPct: "0" },
            volatility: { annualizedVolatility: null, sharpeRatio: null, sortinoRatio: null },
            streaks: { bestStreak: null, worstStreak: null, bestMonth: null, worstMonth: null, bestYear: null, worstYear: null, positiveMonths: 0, negativeMonths: 0, totalMonths: 0 },
            benchmark: null,
            concentrationTrend: [],
            bestWorstMonthly: { best: null, worst: null },
            bestWorstYearly: { best: null, worst: null },
          } as const;
        }

        // Fetched up front (not just after aggregation) so its native currency can be
        // folded into the same FX rate fetch below — the benchmark's raw prices need
        // converting to `display` before indexing, same as the portfolio's own snapshots.
        const bmConfig = await getUserBenchmarkConfig(app.db, id, display);

        const currencies = [...new Set([...snapshots.map((r) => r.currency), bmConfig.currency])];
        const dates = [...new Set(snapshots.map((r) => r.date))];
        const ratesByDate = await getFxRatesForDates(app.db, currencies, display, dates);

        const perPortfolio = new Map<string, { date: string; marketValue: string; effectiveFlow: string; netWorth: string; currency: string }[]>();
        for (const r of snapshots) {
          const list = perPortfolio.get(r.portfolioId) ?? [];
          list.push(r);
          perPortfolio.set(r.portfolioId, list);
        }

        const allFlows: { date: string; marketValue: string; effectiveFlow: string }[][] = [];
        for (const [, pfRows] of perPortfolio) {
          const converted = pfRows.map((r) => {
            const fx = makeFxRateFn(ratesByDate.get(r.date) ?? {}, display);
            return {
              date: r.date,
              marketValue: convert(r.marketValue ?? "0", r.currency, display, fx),
              effectiveFlow: convert(r.effectiveFlow ?? "0", r.currency, display, fx),
            };
          });
          allFlows.push(converted);
        }

        const aggregated = aggregateValueFlows(allFlows);
        const indexed = chainIndex(aggregated);

        // ── Drawdown ───────────────────────────────────────────────────
        // Fed the cashflow-normalized TWR index (same series volatility/streaks use
        // below), not raw net worth: a deposit/withdrawal moves net worth without
        // being a real gain/loss, and would otherwise register as a phantom drawdown.
        const drawdown = maxDrawdown(indexed.map((p) => ({ date: p.date, netWorth: p.index })));

        // ── Volatility & Sharpe ────────────────────────────────────────
        const idxPoints = indexed.map((p) => ({ date: p.date, index: p.index }));
        const returns = dailyReturns(idxPoints);

        // Read risk-free rate from preference first, fall back to currency-based auto-detect
        const [rfrPref] = await app.db
          .select({ rate: userPreferences.riskFreeRate })
          .from(userPreferences)
          .where(eq(userPreferences.userId, id))
          .limit(1);
        const autoRfr: Record<string, number> = { EUR: 0.03, USD: 0.05, IDR: 0.06 };
        const riskFreeRate = Number(rfrPref?.rate ?? autoRfr[display] ?? 0.04);
        const volatility = {
          annualizedVolatility: returns.length >= 2 ? String(annualizedVolatility(returns)) : null,
          sharpeRatio: returns.length >= 2 ? String(sharpeRatio(returns, riskFreeRate)) : null,
          sortinoRatio: returns.length >= 2 ? String(sortinoRatio(returns, riskFreeRate)) : null,
        };

        // ── Streaks ────────────────────────────────────────────────────
        const streaks = streakAnalysis(idxPoints);

        // ── Benchmark comparison ───────────────────────────────────────
        let benchmark: { symbol: string; activeReturn: string; trackingError: string; correlation: string } | null = null;
        if (indexed.length > 0) {
          const bmDates = indexed.map((p) => p.date);
          const existingBm = await getBenchmarkPrices(app.db, id, bmConfig.symbol, bmDates);
          const missingDates = bmDates.filter((d) => !existingBm.has(d));
          if (missingDates.length > 0) {
            try {
              const md = await getMarketData();
              await fetchBenchmarkPrices(app.db, md, id, bmConfig.symbol, missingDates[0]);
            } catch { /* non-fatal */ }
          }
          const refreshedBm = await getBenchmarkPrices(app.db, id, bmConfig.symbol, bmDates);
          if (refreshedBm.size > 1) {
            // Convert the benchmark's raw close (native `bmConfig.currency`, e.g. USD for
            // ^GSPC) to the user's display currency before indexing — otherwise a EUR/IDR
            // portfolio's TWR index would be compared against a USD price series, injecting
            // the full USD↔display FX drift into both the active-return level and (via
            // daily diffs) the tracking error.
            let bmFxMissingDates = 0;
            const bmPrices = bmDates
              .filter((d) => refreshedBm.has(d))
              .map((d) => {
                const dayRates = ratesByDate.get(d) ?? {};
                // makeFxRateFn falls back to "1" (unconverted) for a pair it has no rate
                // for; count that so it can be flagged below instead of silently leaving
                // that day's benchmark close in its native currency.
                if (bmConfig.currency !== display && !dayRates[bmConfig.currency]) bmFxMissingDates++;
                const fx = makeFxRateFn(dayRates, display);
                return { date: d, close: convert(refreshedBm.get(d)!, bmConfig.currency, display, fx) };
              });
            if (bmFxMissingDates > 0) {
              app.log.warn(
                { userId: id, symbol: bmConfig.symbol, currency: bmConfig.currency, display, missingDates: bmFxMissingDates },
                "insights: benchmark FX rate missing for some dates — those days left unconverted",
              );
            }
            const bmIndex = computeBenchmarkIndex(bmPrices);
            const active = computeActiveReturn(
              indexed.map((p) => ({ date: p.date, pct: p.pct })),
              bmIndex.map((p) => ({ date: p.date, pct: p.pct })),
            );
            if (active) {
              benchmark = { symbol: bmConfig.symbol, ...active };
            }
          }
        }

        // ── Concentration trend (monthly, simplified) ──────────────────
        const concentrationTrend: { date: string; hhi: number; top1Pct: number; classCount: number }[] = [];
        const months = [...new Set(dates.map((d) => d.slice(0, 7)))].slice(-60);
        const pfIds = pfs.map((p) => p.id);
        type PeriodMoverResult = { instrumentId: string; symbol: string; name: string | null; assetClass: string; pct: number };
        type BestWorstPair = { best: PeriodMoverResult | null; worst: PeriodMoverResult | null };
        let bestWorstMonthly: BestWorstPair = { best: null, worst: null };
        let bestWorstYearly: BestWorstPair = { best: null, worst: null };

        if (months.length > 0) {
          const allTxRows = await app.db
            .select()
            .from(transactions)
            .where(inArray(transactions.portfolioId, pfIds));
          const instIds = [...new Set(allTxRows.filter((t) => t.instrumentId).map((t) => t.instrumentId!))];
          const allInstRows = await app.db
            .select()
            .from(instruments)
            .where(inArray(instruments.id, instIds));
          const instMap = new Map(allInstRows.map((i) => [i.id, i]));
          const corpActionRows = await app.db
            .select()
            .from(corporateActions)
            .where(inArray(corporateActions.instrumentId, instIds));
          const corpActions: CorporateAction[] = corpActionRows.map((ca) => ({
            instrumentId: ca.instrumentId,
            type: ca.type,
            ratio: ca.ratio,
            exDate: new Date(ca.exDate),
          }));

          // Fetch all prices for held instruments (≤60 months × few dozen instruments)
          const allPrices = await app.db
            .select()
            .from(prices)
            .where(inArray(prices.instrumentId, instIds))
            .orderBy(asc(prices.date));
          const pricesByInst: Map<string, { date: string; close: string }[]> = new Map();
          for (const p of allPrices) {
            const list = pricesByInst.get(p.instrumentId) ?? [];
            list.push({ date: p.date, close: p.close });
            pricesByInst.set(p.instrumentId, list);
          }
          const latestPriceBefore = (instId: string, asOfDate: string): string | null => {
            const list = pricesByInst.get(instId);
            if (!list || list.length === 0) return null;
            for (let i = list.length - 1; i >= 0; i--) {
              if (list[i].date <= asOfDate) return list[i].close;
            }
            return null;
          };

          const coreTxns = toCoreTxns(allTxRows);
          for (const month of months) {
            const monthDates = dates.filter((d) => d.startsWith(month));
            if (monthDates.length === 0) continue;
            const asOfDate = monthDates[monthDates.length - 1];
            const asOf = new Date(`${asOfDate}T23:59:59.999Z`);

            const holdings = computeHoldings(coreTxns, corpActions, asOf);

            // Compute market values using closest-known prices
            let totalMv = 0;
            const mvByInst: { mv: number; assetClass: string }[] = [];
            for (const h of holdings) {
              const qty = Number(h.quantity);
              if (qty <= 0 || !h.instrumentId) continue;
              const price = latestPriceBefore(h.instrumentId, asOfDate);
              if (!price) continue;
              const mv = qty * Number(price);
              const inst = instMap.get(h.instrumentId);
              mvByInst.push({ mv, assetClass: inst?.assetClass ?? "equity" });
              totalMv += mv;
            }

            if (totalMv > 0 && mvByInst.length > 0) {
              const fractions = mvByInst.map((x) => x.mv / totalMv);
              const hhi = fractions.reduce((sum, f) => sum + f * f, 0);
              const top1Fraction = Math.max(...fractions);
              const classes = new Set(mvByInst.map((x) => x.assetClass));

              concentrationTrend.push({
                date: month,
                hhi: Math.round(hhi * 10000) / 10000,
                top1Pct: Math.round(top1Fraction * 10000) / 100,
                classCount: classes.size,
              });
            }
          }

          // ── Period best/worst performers (MTD, YTD) ──────────────────────
          const latestDate = dates[dates.length - 1];
          const monthStart = latestDate.slice(0, 7) + "-01";
          const yearStart = latestDate.slice(0, 4) + "-01-01";
          const periodEnd = new Date(`${latestDate}T23:59:59.999Z`);

          // Require the instrument to be held at both period start and period
          // end — a recent buy or a partial exit shouldn't show the full period's
          // price swing as "your return", since part of that move happened before
          // the user owned the position (or happened on shares already sold).
          const heldAtStart = new Set(
            computeHoldings(coreTxns, corpActions, new Date(`${monthStart}T00:00:00.000Z`))
              .filter((h) => Number(h.quantity) > 0 && h.instrumentId)
              .map((h) => h.instrumentId!),
          );
          const heldAtYearStart = new Set(
            computeHoldings(coreTxns, corpActions, new Date(`${yearStart}T00:00:00.000Z`))
              .filter((h) => Number(h.quantity) > 0 && h.instrumentId)
              .map((h) => h.instrumentId!),
          );
          const heldAtEnd = new Map(
            computeHoldings(coreTxns, corpActions, periodEnd)
              .filter((h) => Number(h.quantity) > 0 && h.instrumentId)
              .map((h) => [h.instrumentId!, h]),
          );

          const computePeriodMovers = (startDate: string, heldAtStartSet: Set<string>): BestWorstPair => {
            const movers: PeriodMoverResult[] = [];
            for (const instId of heldAtEnd.keys()) {
              if (!heldAtStartSet.has(instId)) continue;
              const rawStart = latestPriceBefore(instId, startDate);
              const rawEnd = latestPriceBefore(instId, latestDate);
              if (!rawStart || !rawEnd || Number(rawStart) <= 0) continue;

              // Split-adjust both prices so a stock split or bonus inside the
              // window doesn't manufacture a phantom gain/loss.  The adjustment
              // factor is applied per-instrument per-date: each raw close is
              // divided by the cumulative factor for future splits.
              const saStart = splitAdjustmentFactor(corpActions, instId, startDate);
              const saEnd = splitAdjustmentFactor(corpActions, instId, latestDate);
              if (saStart.isZero() || saEnd.isZero()) continue;
              const adjustedStart = new Decimal(rawStart).div(saStart);
              const adjustedEnd = new Decimal(rawEnd).div(saEnd);
              const pct = adjustedEnd.div(adjustedStart).toNumber() - 1;

              const inst = instMap.get(instId);
              if (!inst) continue;
              movers.push({
                instrumentId: instId,
                symbol: inst.symbol ?? "—",
                name: inst.name,
                assetClass: inst.assetClass ?? "equity",
                pct,
              });
            }
            if (movers.length < 2) return { best: null, worst: null };
            movers.sort((a, b) => b.pct - a.pct);
            return { best: movers[0], worst: movers[movers.length - 1] };
          };

          bestWorstMonthly = computePeriodMovers(monthStart, heldAtStart);
          bestWorstYearly = computePeriodMovers(yearStart, heldAtYearStart);
        }

        return { drawdown, volatility, streaks, benchmark, concentrationTrend, bestWorstMonthly, bestWorstYearly };
      });

      const durationMs = performance.now() - t0;
      logTiming(request, "GET /insights", durationMs, {});
      return result;
    },
  );
}
