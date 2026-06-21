import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import {
  accountHolders,
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
  xirr,
  projectCoupons,
  projectDividends,
  trailingIncomeByInstrument,
  trailingYield,
  aggregateIncome,
  convert,
  cashFlow,
  contributionStats,
  mergeContributionStats,
  chainIndex,
  aggregateValueFlows,
  computeTrades,
  mergeTradeLogs,
  type CoreTransaction,
  type CostBasisMode,
  type CorporateAction,
  type CashFlowPoint,
  type ContributionStats,
  type PortfolioSummary,
  type TradeLog,
  type TradeMethod,
} from "@portfolio/core";
import { getMarketData } from "../services/market-data.js";
import { valuePortfolio, type InstrumentMeta } from "../services/valuation.js";
import { getFxRates, getFxRatesForDates, makeFxRateFn } from "../services/fx.js";
import { rangeStart } from "../services/snapshots.js";
import { requireUser } from "../plugins/auth.js";
import { enqueueRecompute } from "../services/scheduler.js";
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
        { symbol: i.symbol, name: i.name, assetClass: i.assetClass, unit: i.unit },
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

    // Load announced/paid dividend events from the DB for held instruments.
    // Scale amountPerShare by current holdings quantity to get the total payout.
    const todayStr = now.toISOString().slice(0, 10);
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
      { exDate: string; amount: string; currency: string; status: "announced" | "paid" }[]
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
      });
      futureAnnouncedByInstrument.set(row.instrumentId, list);
    }

    // Blend: for instruments with announced future dividends, drop projected entries.
    // Only consider instruments that actually have future announcements — instruments with
    // only past paid rows in dividend_events should still use the projected heuristic.
    // dividend_events is populated by the weekly `refresh-dividends` pg-boss job
    // (scheduler.ts); this blend activates automatically for any held equity/ETF
    // instrument whose provider returns dividend announcements.
    const instrumentsWithAnnounced = new Set(
      [...futureAnnouncedByInstrument.entries()]
        .filter(([_, rows]) => rows.some((r) => r.exDate > todayStr))
        .map(([id]) => id),
    );
    const blendedProjected = projectedDividends.filter(
      (d) => d.instrumentId && !instrumentsWithAnnounced.has(d.instrumentId),
    );
    // Combine for the forecastRestOfYear sum: both projected + future announced amounts.
    const futureAnnounced = [...futureAnnouncedByInstrument.values()]
      .flat()
      .filter((d) => d.exDate > todayStr);
    const allRestOfYearDividends = [
      ...blendedProjected.map((d) => ({ amount: d.amount, currency: d.currency })),
      ...futureAnnounced.map((d) => ({ amount: d.amount, currency: d.currency })),
    ];

    const stats = aggregateIncome({
      events: enriched,
      displayCurrency: display,
      fx,
      now,
      forecastCoupons: upcomingCoupons12mo,
      restOfYearCoupons,
      projectedDividends: allRestOfYearDividends,
      heldQty: heldQtyMap,
      qtyAt,
    });

    // The event log doesn't need the helper-only fields (assetClass/executedAt).
    const events = enriched.map((e) => ({
      instrumentId: e.instrumentId,
      symbol: e.symbol,
      name: e.name,
      type: e.type,
      date: e.date,
      amount: e.price,
      currency: e.currency,
    }));

    // Build announced entries for the upcoming stream (future ex-dates only).
    const upcomingAnnounced: {
      instrumentId: string;
      symbol: string;
      name: string | null;
      date: string;
      amount: string;
      currency: string;
      kind: "dividend";
      status: "announced" | "paid";
    }[] = [];
    for (const [instrumentId, entries] of futureAnnouncedByInstrument) {
      const im = meta.get(instrumentId);
      for (const entry of entries) {
        if (entry.exDate <= todayStr) continue;
        upcomingAnnounced.push({
          instrumentId,
          symbol: im?.symbol ?? "",
          name: im?.name ?? null,
          date: entry.exDate,
          amount: entry.amount,
          currency: entry.currency,
          kind: "dividend",
          status: entry.status,
        });
      }
    }

    // Merge 12-month coupons, blended projected, and announced dividends into one
    // date-sorted upcoming stream.
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
      })),
      ...upcomingAnnounced,
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
      return {
        ...summary,
        holdings: summary.holdings.map((h) => ({
          ...h,
          instrument: metaById.get(h.instrumentId) ?? null,
        })),
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
  app.get<{ Querystring: { costBasis?: string } }>(
    "/networth",
    { preHandler: app.authenticate },
    async (request) => {
      const { id } = requireUser(request);
      const [u] = await app.db
        .select({ displayCurrency: users.displayCurrency })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      const display = u?.displayCurrency ?? "IDR";
      const costBasisMode = costBasisFromQuery(request.query);

      const pfs = await app.db.select().from(portfolios).where(eq(portfolios.userId, id));

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

      const asOf = new Date();
      flows.push({ amount: Number(aggregated.netWorth), date: asOf });
      const rate = xirr(flows);

      return {
        ...aggregated,
        holdings,
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
  app.get<{ Querystring: { method?: string; costBasis?: string } }>(
    "/networth/trades",
    { preHandler: app.authenticate },
    async (request) => {
      const { id } = requireUser(request);
      const [u] = await app.db
        .select({ displayCurrency: users.displayCurrency })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      const display = u?.displayCurrency ?? "IDR";
      const method = methodFromQuery(request.query);
      const costBasisMode = costBasisFromQuery(request.query);

      const pfs = await app.db
        .select({ id: portfolios.id, cashCounted: portfolios.cashCounted })
        .from(portfolios)
        .where(eq(portfolios.userId, id));

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
  app.get<{ Querystring: { range?: string; include?: string; exclude?: string } }>(
    "/networth/history",
    { preHandler: app.authenticate },
    async (request) => {
      const { id } = requireUser(request);
      const [u] = await app.db
        .select({ displayCurrency: users.displayCurrency })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      const display = u?.displayCurrency ?? "IDR";

      const pfs = await app.db
        .select({ id: portfolios.id, includeInAggregate: portfolios.includeInAggregate })
        .from(portfolios)
        .where(eq(portfolios.userId, id));
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
}
