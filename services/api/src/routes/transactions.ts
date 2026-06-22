import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, gte, inArray, isNull } from "drizzle-orm";
import {
  accountHolders,
  allocationTargets,
  corporateActions,
  dividendEvents,
  documents,
  instruments,
  portfolios,
  portfolioSnapshots,
  transactions,
  transactionSources,
  users,
} from "@portfolio/db";
import {
  deleteReceiptsForTransactions,
  getDocumentForTransaction,
  importIdsWithDocuments,
  transactionIdsWithDocuments,
} from "../storage/receipts.js";
import { gatherDocumentNaming, buildDocumentName } from "../storage/naming.js";
import {
  txIdsWithFullTaxDetail,
  sourcesForTransactions,
} from "../services/enrichment.js";
import { transactionInputSchema } from "@portfolio/schema";
import {
  computeHoldings,
  aggregatePortfolios,
  allocationBreakdown,
  rebalancingDrift,
  xirr,
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
  type CoreTransaction,
  type CostBasisMode,
  type CorporateAction,
  type CashFlowPoint,
  type ContributionStats,
  type PortfolioSummary,
  type TradeLog,
  type TradeMethod,
  contributionSplit,
  type SparplanStats,
  type DriftRow,
} from "@portfolio/core";
import { getMarketData } from "../services/market-data.js";
import { valuePortfolio, type InstrumentMeta } from "../services/valuation.js";
import { getFxRates, getFxRatesForDates, makeFxRateFn } from "../services/fx.js";
import { rangeStart } from "../services/snapshots.js";
import { requireUser } from "../plugins/auth.js";
import { enqueueRecompute, enqueueInstrumentMetadata } from "../services/scheduler.js";
import { needsSectorEnrichment } from "../services/instrument-metadata.js";
import { flattenJoinRow } from "../lib/portfolio.js";

interface PortfolioParams {
  portfolioId: string;
}

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
          assetClass: i.assetClass,
          unit: i.unit,
          market: i.market,
          sector: i.sector ?? null,
          sectorWeights: (i.sectorWeights as Record<string, number> | null) ?? null,
          sectorCheckedAt: i.sectorCheckedAt ? new Date(i.sectorCheckedAt) : null,
        },
      ]),
    );
  }

  // Value a portfolio (holdings priced + cash + net worth) in `displayCurrency`.
  // Shared by /summary, /performance and /networth via the valuation service.
  async function loadValuation(
    portfolioId: string,
    displayCurrency: string,
    costBasisMode?: CostBasisMode,
    cashCounted = true,
  ) {
    return valuePortfolio(
      app.db,
      await getMarketData(),
      app.config.MARKET_DATA_TTL_MS,
      portfolioId,
      displayCurrency,
      costBasisMode,
      cashCounted,
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
  // corporate actions and an FX snapshot the engine needs.
  async function buildTradeLog(
    coreTxns: CoreTransaction[],
    prices: Record<string, { price: string; currency: string }>,
    target: string,
    method: TradeMethod,
    costBasisMode: CostBasisMode | undefined,
    instrumentsMeta?: Map<string, InstrumentMeta>,
  ): Promise<TradeLog> {
    const currencies = new Set<string>(coreTxns.map((t) => t.currency));
    for (const p of Object.values(prices)) currencies.add(p.currency);
    const fx = makeFxRateFn(await getFxRates(app.db, [...currencies], target), target);
    const cas = await corporateActionsFor(coreTxns.map((t) => t.instrumentId));
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
  ) {
    const now = new Date();
    const incomeTxns = coreTxns.filter((t) => t.type === "dividend" || t.type === "coupon");

    const ccys = [...new Set(incomeTxns.map((t) => t.currency))];
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
          instrumentId: t.instrumentId,
          symbol: im?.symbol ?? null,
          name: im?.name ?? null,
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
    const projectedDividends = projectDividends(pastDivs, heldQtyMap, qtyAt, now);

    // Compute per-instrument share-accumulation rate (shares/month) from the trailing
    // 12 months of buy + savings_plan transactions, excluding "saveback" kind (consistent
    // with contribution boundary rules). Used by projectNextYearDividends so that a
    // growing savings plan is reflected in the next-year dividend forecast.
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
    const events = enriched.map((e) => {
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
        instrumentId: e.instrumentId,
        symbol: e.symbol,
        name: e.name,
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
        assumesContributions: undefined as boolean | undefined,
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

    return { displayCurrency: display, ...stats, yields, upcoming, events };
  }

  // List a portfolio's transactions, each enriched with instrument metadata.
  app.get<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/transactions",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      if (!(await ownedPortfolio(id, request.params.portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const rows = await app.db
        .select()
        .from(transactions)
        .where(eq(transactions.portfolioId, request.params.portfolioId));
      const meta = await instrumentMeta(rows.map((r) => r.instrumentId));
      // Batch-check which transactions have a retained document.
      // TR transactions carry per-tx docs (linked by transactionId); other sources use
      // one doc per import (linked by importId). Check both, OR them together.
      const allImportIds = rows
        .map((r) => r.importId)
        .filter((x): x is string => x !== null);
      const allTxIds = rows.map((r) => r.id);
      const [importIdsWithDocs, txIdsWithDocs, fullTaxDetail, sourcesMap] = await Promise.all([
        importIdsWithDocuments(app, allImportIds),
        transactionIdsWithDocuments(app, allTxIds),
        txIdsWithFullTaxDetail(app, allTxIds),
        sourcesForTransactions(app, allTxIds),
      ]);
      return rows.map((r) => ({
        ...r,
        instrument: r.instrumentId ? (meta.get(r.instrumentId) ?? null) : null,
        hasDocument:
          txIdsWithDocs.has(r.id) ||
          (r.importId ? importIdsWithDocs.has(r.importId) : false),
        hasFullTaxDetail: fullTaxDetail.has(r.id),
        sources: sourcesMap.get(r.id) ?? [],
      }));
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

  // Derived holdings for a portfolio (computed via @portfolio/core).
  app.get<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/holdings",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      if (!(await ownedPortfolio(id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const rows = await app.db
        .select()
        .from(transactions)
        .where(eq(transactions.portfolioId, portfolioId));
      const coreTxns: CoreTransaction[] = rows.map((r) => ({
        instrumentId: r.instrumentId,
        type: r.type,
        quantity: r.quantity,
        price: r.price,
        fees: r.fees,
        currency: r.currency,
        executedAt: r.executedAt,
      }));
      const cas = await corporateActionsFor(rows.map((r) => r.instrumentId));
      return computeHoldings(coreTxns, cas);
    },
  );

  // Full valuation summary: holdings priced via market data + cash + net worth.
  app.get<{ Params: PortfolioParams; Querystring: { costBasis?: string } }>(
    "/portfolios/:portfolioId/summary",
    { preHandler: app.authenticate },
    async (request, reply) => {
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
      );
      // Self-heal: enqueue a sector sweep if any held instrument hasn't been
      // enriched yet (or has a stale attempt). Debounced to once per 6h.
      if (needsSectorEnrichment([...metaById.values()])) {
        void enqueueInstrumentMetadata();
      }
      const allocation = allocationBreakdown(summary, metaById);
      const drift = await loadDrift(id, portfolioId, allocation);
      return {
        ...summary,
        holdings: summary.holdings.map((h) => ({
          ...h,
          instrument: metaById.get(h.instrumentId) ?? null,
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
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      if (!(await ownedPortfolio(id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const start = rangeStart(request.query.range ?? "1y");
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

      return rows.map((r) => ({
        date: r.date,
        netWorth: r.netWorth,
        marketValue: r.marketValue ?? "0",
        index: indexById.get(r.date)?.index ?? "100",
        pct: indexById.get(r.date)?.pct ?? "0",
      }));
    },
  );

  // Money-weighted return (XIRR) from external cash flows + current net worth.
  app.get<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/performance",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      const portfolio = await ownedPortfolio(id, portfolioId);
      if (!portfolio) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const boundary = portfolio.cashCounted ? "inside" : "outside";
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
    },
  );

  // Contribution analytics for a single portfolio (in its base currency).
  app.get<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/contributions",
    { preHandler: app.authenticate },
    async (request, reply) => {
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
      return buildContributions(
        coreTxns,
        summary,
        portfolio.baseCurrency,
        portfolio.birthYear,
        portfolio.portfolioType === "child" ? "child" : "standard",
        portfolio.cashCounted ? "inside" : "outside",
      );
    },
  );

  // Trade log for a single portfolio: round-trip episodes with realized/unrealized
  // P&L, folded-in dividends, per-trade return and a tax-by-year breakdown.
  app.get<{ Params: PortfolioParams; Querystring: { method?: string; costBasis?: string } }>(
    "/portfolios/:portfolioId/trades",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      const portfolio = await ownedPortfolio(id, portfolioId);
      if (!portfolio) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const method = methodFromQuery(request.query);
      const costBasisMode = costBasisFromQuery(request.query);
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
    },
  );

  // Aggregate net worth across all of the user's portfolios, in their display
  // currency — combined holdings, cash, totals, and money-weighted return.
  app.get<{ Querystring: { costBasis?: string; holderId?: string } }>(
    "/networth",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { holderId } = request.query;
      const [u] = await app.db
        .select({ displayCurrency: users.displayCurrency })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      const display = u?.displayCurrency ?? "IDR";
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
        .select()
        .from(portfolios)
        .where(
          holderId != null
            ? and(eq(portfolios.userId, id), eq(portfolios.accountHolderId, holderId))
            : eq(portfolios.userId, id),
        );

      const summaries = [];
      const instrumentIds = new Set<string>();
      // Each portfolio's money-weighted flows are computed under its own boundary
      // (cash-inside vs cash-outside), then concatenated — the aggregate spans
      // portfolios with different boundaries, so there is no single boundary to pass.
      const flows: CashFlowPoint[] = [];
      for (const p of pfs) {
        const { coreTxns, summary } = await loadValuation(
          p.id,
          display,
          costBasisMode,
          p.cashCounted,
        );
        summaries.push(summary);
        flows.push(...(await boundaryFlows(coreTxns, p.cashCounted ? "inside" : "outside", display)));
        for (const h of summary.holdings) instrumentIds.add(h.instrumentId);
      }

      const aggregated = aggregatePortfolios(summaries, display);
      const meta = await instrumentMeta([...instrumentIds]);
      const holdings = aggregated.holdings.map((h) => ({
        ...h,
        instrument: meta.get(h.instrumentId) ?? null,
      }));

      // Self-heal: enqueue a sector sweep if any held instrument hasn't been
      // enriched yet (or has a stale attempt). Debounced to once per 6h.
      if (needsSectorEnrichment([...meta.values()])) {
        void enqueueInstrumentMetadata();
      }

      const asOf = new Date();
      flows.push({ amount: Number(aggregated.netWorth), date: asOf });
      const rate = xirr(flows);

      const allocation = allocationBreakdown(aggregated, meta);
      const drift = await loadDrift(id, null, allocation);

      return {
        ...aggregated,
        holdings,
        allocation,
        ...(Object.keys(drift).length > 0 ? { drift } : {}),
        xirr: Number.isFinite(rate) ? rate : null,
        portfolioCount: pfs.length,
        asOf: asOf.toISOString(),
      };
    },
  );

  // Income analytics across all of the user's portfolios (or a holder subset), in their
  // display currency: per-period totals, forecast, delta, breakdowns, yields, upcoming
  // coupons + events. Optional `holderId` narrows the result to portfolios linked to that
  // account holder (must be owned by the requesting user).
  app.get<{ Querystring: { holderId?: string } }>(
    "/networth/income",
    { preHandler: app.authenticate },
    async (request, reply) => {
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
        .select({ id: portfolios.id, cashCounted: portfolios.cashCounted })
        .from(portfolios)
        .where(
          holderId != null
            ? and(eq(portfolios.userId, id), eq(portfolios.accountHolderId, holderId))
            : eq(portfolios.userId, id),
        );

      const summaries = [];
      const allTxns: CoreTransaction[] = [];
      for (const p of pfs) {
        const { coreTxns, summary } = await loadValuation(p.id, display, undefined, p.cashCounted);
        summaries.push(summary);
        allTxns.push(...coreTxns);
      }
      const aggregated = aggregatePortfolios(summaries, display);

      return buildIncomeStats(allTxns, aggregated, display);
    },
  );

  // Aggregate trade log across all of the user's portfolios, in their display
  // currency. Each portfolio's trades are computed under its own settings, then merged
  // (a position held in two portfolios is two trades).
  app.get<{ Querystring: { method?: string; costBasis?: string; holderId?: string } }>(
    "/networth/trades",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { holderId } = request.query;
      const [u] = await app.db
        .select({ displayCurrency: users.displayCurrency })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      const display = u?.displayCurrency ?? "IDR";
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

      const logs: TradeLog[] = [];
      const meta = new Map<string, InstrumentMeta>();
      for (const p of pfs) {
        const { coreTxns, prices, metaById } = await loadValuation(
          p.id,
          display,
          costBasisMode,
          p.cashCounted,
        );
        logs.push(await buildTradeLog(coreTxns, prices, display, method, costBasisMode, metaById));
        for (const [k, v] of metaById) meta.set(k, v);
      }
      return attachInstruments(mergeTradeLogs(logs, display, method), meta);
    },
  );

  // Income analytics for a single portfolio (in its base currency).
  app.get<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/income",
    { preHandler: app.authenticate },
    async (request, reply) => {
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
      return buildIncomeStats(coreTxns, summary, portfolio.baseCurrency);
    },
  );

  // Sparplan detection for a single portfolio (in its base currency).
  app.get<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/sparplan",
    { preHandler: app.authenticate },
    async (request, reply) => {
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
      const stats = await buildSparplanStats(coreTxns, portfolio.baseCurrency);

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

      return { ...stats, drift, contributionSplit: split };
    },
  );

  // Aggregate Sparplan detection across all of the user's portfolios (or a holder
  // subset). Detection runs per portfolio and is merged (not concatenated) to avoid
  // two portfolios with the same instrument collapsing into one plan.
  app.get<{ Querystring: { holderId?: string } }>(
    "/networth/sparplan",
    { preHandler: app.authenticate },
    async (request, reply) => {
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

      // Detect per portfolio in the display currency, then merge (not concatenate).
      const perPortfolio: SparplanStats[] = [];
      const allInstrumentIds = new Set<string>();
      for (const p of pfs) {
        const { coreTxns } = await loadValuation(p.id, display, undefined, p.cashCounted);
        const ccys = [...new Set(coreTxns.map((t) => t.currency))];
        const rates = await getFxRates(app.db, ccys, display);
        const fx = makeFxRateFn(rates, display);
        const stats = detectSparplans({ txns: coreTxns, displayCurrency: display, fx });
        perPortfolio.push(stats);
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

  // Aggregate contribution analytics across all of the user's portfolios (or a holder
  // subset), in their display currency. Optional `holderId` narrows the result to
  // portfolios linked to that account holder and seeds `birthYear`/`portfolioType` from
  // the holder so the child-savings forecast panel works correctly.
  app.get<{ Querystring: { holderId?: string } }>(
    "/networth/contributions",
    { preHandler: app.authenticate },
    async (request, reply) => {
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

      const summaries: PortfolioSummary[] = [];
      const loaded: { txns: CoreTransaction[]; boundary: "inside" | "outside" }[] = [];
      const allTxns: CoreTransaction[] = [];
      for (const p of pfs) {
        const { coreTxns, summary } = await loadValuation(p.id, display, undefined, p.cashCounted);
        summaries.push(summary);
        loaded.push({ txns: coreTxns, boundary: p.cashCounted ? "inside" : "outside" });
        allTxns.push(...coreTxns);
      }
      const fx = makeFxRateFn(
        await getFxRates(app.db, [...new Set(allTxns.map((t) => t.currency))], display),
        display,
      );
      // Compute each portfolio under ITS boundary, then merge — so each portfolio keeps its
      // own boundary instead of being collapsed into one cross-portfolio bucket.
      const perPortfolio = loaded.map(({ txns, boundary }) =>
        contributionStats({ txns, displayCurrency: display, fx, boundary }),
      );
      // Money-weighted flows: each portfolio under its boundary, concatenated.
      const flows: CashFlowPoint[] = [];
      for (const { txns, boundary } of loaded) {
        flows.push(...(await boundaryFlows(txns, boundary, display)));
      }
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

  // Aggregate net-worth-over-time across all of the user's portfolios, summing each
  // day's snapshots converted to the display currency.
  app.get<{ Querystring: { range?: string; include?: string; exclude?: string; holderId?: string } }>(
    "/networth/history",
    { preHandler: app.authenticate },
    async (request, reply) => {
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

      // Resolve which portfolios to include.
      // ?include=id1,id2 overrides default; ?exclude=id1,id2 removes from default.
      const includeParam = (request.query.include ?? "").split(",").filter(Boolean);
      const excludeParam = (request.query.exclude ?? "").split(",").filter(Boolean);

      let pfIds: string[];
      if (includeParam.length > 0) {
        pfIds = pfs.filter((p) => includeParam.includes(p.id)).map((p) => p.id);
      } else {
        pfIds = pfs
          .filter((p) => p.includeInAggregate && !excludeParam.includes(p.id))
          .map((p) => p.id);
      }
      if (pfIds.length === 0) return [];

      const start = rangeStart(request.query.range ?? "1y");
      const conds = [inArray(portfolioSnapshots.portfolioId, pfIds)];
      if (start) conds.push(gte(portfolioSnapshots.date, start));
      const rows = await app.db
        .select()
        .from(portfolioSnapshots)
        .where(and(...conds))
        .orderBy(asc(portfolioSnapshots.date));

      // FX-convert each row's (marketValue, effectiveFlow, netWorth) to display currency.
      const currencies = [...new Set(rows.map((r) => r.currency))];
      const dates = [...new Set(rows.map((r) => r.date))];
      const ratesByDate = await getFxRatesForDates(app.db, currencies, display, dates);

      // Group by portfolio then aggregate before chaining (cannot average per-portfolio indices).
      const perPortfolio = new Map<string, { date: string; marketValue: string; effectiveFlow: string; netWorth: string; currency: string }[]>();
      for (const r of rows) {
        const list = perPortfolio.get(r.portfolioId) ?? [];
        list.push(r);
        perPortfolio.set(r.portfolioId, list);
      }

      // FX-convert per-portfolio flows to display currency, then aggregate.
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

      // Also compute aggregated netWorth per date for the Value toggle.
      const nwByDate = new Map<string, number>();
      for (const r of rows) {
        const fx = makeFxRateFn(ratesByDate.get(r.date) ?? {}, display);
        const nw = Number(convert(r.netWorth, r.currency, display, fx));
        nwByDate.set(r.date, (nwByDate.get(r.date) ?? 0) + nw);
      }

      return aggregated.map((p) => ({
        date: p.date,
        netWorth: String(nwByDate.get(p.date) ?? 0),
        marketValue: p.marketValue,
        index: indexById.get(p.date)?.index ?? "100",
        pct: indexById.get(p.date)?.pct ?? "0",
      }));
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

      // Fetch the transaction_sources row and verify it belongs to this transaction.
      const [sourceRow] = await app.db
        .select({ id: transactionSources.id, documentId: transactionSources.documentId })
        .from(transactionSources)
        .where(and(eq(transactionSources.id, sourceId), eq(transactionSources.transactionId, txId)))
        .limit(1);
      if (!sourceRow) return reply.code(404).send({ error: "source_not_found" });
      if (!sourceRow.documentId) return reply.code(404).send({ error: "document_not_found" });

      // Fetch the linked document.
      const [doc] = await app.db
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
   * Build a per-instrumentId Teilfreistellung rate map for a set of instrument ids.
   *
   * Priority:
   *   1. `partial_exemption_rate` column (explicit per-instrument override).
   *   2. Asset-class default under German InvStG §20 Abs. 9:
   *        etf          → 30 % (equity ETF — the overwhelming common case)
   *        mutual_fund  → 15 % (mixed fund; equity funds also qualify at 30 %, but
   *                             we conservatively default to 15 % for unclassified
   *                             mutual funds; users can override via the column)
   *        all others   → 0 % (stocks, bonds, gold, cash — no exemption)
   *
   * Only instruments with a non-zero rate appear in the returned map; absent =
   * core treats as 0 (correct for stocks/bonds/gold).
   */
  async function tfRatesFor(instrumentIds: (string | null)[]): Promise<Record<string, string>> {
    const ids = [...new Set(instrumentIds.filter((x): x is string => x !== null))];
    if (ids.length === 0) return {};
    const rows = await app.db
      .select({
        id: instruments.id,
        partialExemptionRate: instruments.partialExemptionRate,
        assetClass: instruments.assetClass,
      })
      .from(instruments)
      .where(inArray(instruments.id, ids));
    const map: Record<string, string> = {};
    for (const r of rows) {
      if (r.partialExemptionRate !== null) {
        // Explicit per-instrument override always wins.
        map[r.id] = r.partialExemptionRate;
      } else if (r.assetClass === "etf") {
        map[r.id] = "0.30"; // §20 Abs. 9 InvStG — equity ETF
      } else if (r.assetClass === "mutual_fund") {
        map[r.id] = "0.15"; // §20 Abs. 9 InvStG — mixed/unclassified fund
      }
      // stocks, bonds, gold, cash → omit (core defaults to 0 %)
    }
    return map;
  }

  /**
   * GET /portfolios/:portfolioId/tax
   * German Sparerpauschbetrag headroom and harvest suggestions for a single portfolio.
   * The portfolio's holder must have `taxAllowanceAnnual` configured.
   */
  app.get<{ Params: PortfolioParams; Querystring: { year?: string; holderId?: string } }>(
    "/portfolios/:portfolioId/tax",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;

      const portfolio = await ownedPortfolio(id, portfolioId);
      if (!portfolio) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }

      // Fetch holder (if any) for tax profile.
      const holderId = portfolio.accountHolderId;
      let holderTaxProfile: {
        taxAllowanceAnnual: string | null;
        capitalGainsTaxRate: string | null;
      } | null = null;

      if (holderId) {
        const [holder] = await app.db
          .select({
            taxAllowanceAnnual: accountHolders.taxAllowanceAnnual,
            capitalGainsTaxRate: accountHolders.capitalGainsTaxRate,
          })
          .from(accountHolders)
          .where(and(eq(accountHolders.id, holderId), eq(accountHolders.userId, id)))
          .limit(1);
        if (holder) holderTaxProfile = holder;
      }

      if (!holderTaxProfile?.taxAllowanceAnnual) {
        return reply.code(422).send({ error: "tax_allowance_not_configured" });
      }

      const year = request.query.year ? parseInt(request.query.year, 10) : new Date().getUTCFullYear();
      const { coreTxns, prices, metaById } = await loadValuation(
        portfolioId,
        portfolio.baseCurrency,
        undefined,
        portfolio.cashCounted,
      );
      const tradeLog = await buildTradeLog(coreTxns, prices, portfolio.baseCurrency, "fifo", undefined, metaById);
      const tfRates = await tfRatesFor(tradeLog.trades.map((t) => t.instrumentId));
      const allowanceAnnual = holderTaxProfile.taxAllowanceAnnual;
      const taxRate = holderTaxProfile.capitalGainsTaxRate ?? "0.25";

      const usage = allowanceUsageYTD({ tradeLog, tfRates, allowanceAnnual, taxRate, year });
      const suggestions = harvestSuggestions({ tradeLog, tfRates, allowanceAnnual, taxRate, year, usage });

      return {
        year,
        currency: portfolio.baseCurrency,
        allowanceUsage: usage,
        harvestSuggestions: suggestions.map((s) => ({
          ...s,
          instrument: metaById.get(s.instrumentId) ?? null,
        })),
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

      // Fetch all holders with tax allowances configured.
      const holderRows = await app.db
        .select()
        .from(accountHolders)
        .where(
          filterHolderId != null
            ? and(eq(accountHolders.userId, id), eq(accountHolders.id, filterHolderId))
            : eq(accountHolders.userId, id),
        );

      const result = [];

      for (const holder of holderRows) {
        if (!holder.taxAllowanceAnnual) continue; // skip unconfigured holders

        // Portfolios belonging to this holder.
        const pfs = await app.db
          .select({ id: portfolios.id, cashCounted: portfolios.cashCounted })
          .from(portfolios)
          .where(and(eq(portfolios.userId, id), eq(portfolios.accountHolderId, holder.id)));

        if (pfs.length === 0) continue;

        // Merge trade logs across all portfolios.
        const logs: TradeLog[] = [];
        const meta = new Map<string, InstrumentMeta>();
        for (const p of pfs) {
          const { coreTxns, prices, metaById } = await loadValuation(p.id, display, undefined, p.cashCounted);
          logs.push(await buildTradeLog(coreTxns, prices, display, "fifo", undefined, metaById));
          for (const [k, v] of metaById) meta.set(k, v);
        }
        const mergedLog = mergeTradeLogs(logs, display, "fifo");

        const tfRates = await tfRatesFor(mergedLog.trades.map((t) => t.instrumentId));
        const allowanceAnnual = holder.taxAllowanceAnnual;
        const taxRate = holder.capitalGainsTaxRate ?? "0.25";

        const usage = allowanceUsageYTD({ tradeLog: mergedLog, tfRates, allowanceAnnual, taxRate, year });
        const suggestions = harvestSuggestions({ tradeLog: mergedLog, tfRates, allowanceAnnual, taxRate, year, usage });

        result.push({
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
        });
      }

      return result;
    },
  );
}
