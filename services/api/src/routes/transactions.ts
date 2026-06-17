import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import {
  corporateActions,
  dividendEvents,
  instruments,
  portfolios,
  portfolioSnapshots,
  transactions,
  users,
} from "@portfolio/db";
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
  contributionStats,
  type CoreTransaction,
  type CostBasisMode,
  type CorporateAction,
  type CashFlowPoint,
  type PortfolioSummary,
} from "@portfolio/core";
import { getMarketData } from "../services/market-data.js";
import { valuePortfolio, type InstrumentMeta } from "../services/valuation.js";
import { getFxRates, getFxRatesForDates, makeFxRateFn } from "../services/fx.js";
import { rangeStart, aggregateByDate } from "../services/snapshots.js";
import { requireUser } from "../plugins/auth.js";

interface PortfolioParams {
  portfolioId: string;
}

const bulkDeleteSchema = z.object({
  ids: z.array(z.guid()).min(1),
});

export async function transactionsRoute(app: FastifyInstance) {
  // Confirm the portfolio exists and belongs to the user.
  async function ownedPortfolio(userId: string, portfolioId: string) {
    const [p] = await app.db
      .select()
      .from(portfolios)
      .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
      .limit(1);
    return p ?? null;
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
  ) {
    return valuePortfolio(
      app.db,
      await getMarketData(),
      app.config.MARKET_DATA_TTL_MS,
      portfolioId,
      displayCurrency,
      costBasisMode,
    );
  }

  // `?costBasis=total_paid` capitalizes financing into a financed holding's cost
  // basis; the default (purchase_price) keeps it separate. Net worth is unaffected.
  function costBasisFromQuery(q: { costBasis?: string }): CostBasisMode | undefined {
    return q.costBasis === "total_paid" || q.costBasis === "purchase_price"
      ? q.costBasis
      : undefined;
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

  // Contribution analytics (total/average money saved + per-month series) plus a
  // forecast seed (current value, simple gain, money-weighted return). Derived
  // entirely from transactions; FX-converts each amount to the display currency.
  async function buildContributions(
    coreTxns: CoreTransaction[],
    summary: PortfolioSummary,
    display: string,
    birthYear: number | null = null,
    portfolioType: "standard" | "child" = "standard",
  ) {
    const ccys = [
      ...new Set(
        coreTxns
          .filter(
            (t) => t.type === "deposit" || t.type === "savings_plan" || t.type === "withdrawal",
          )
          .map((t) => t.currency),
      ),
    ];
    const rates = await getFxRates(app.db, ccys, display);
    const fx = makeFxRateFn(rates, display);
    const stats = contributionStats({ txns: coreTxns, displayCurrency: display, fx });

    const currentValue = summary.netWorth;
    const net = Number(stats.netContributed);
    const simpleGainPct = net > 0 ? (Number(currentValue) - net) / net : null;

    // Money-weighted return from the deduped monthly contributions (placed mid-
    // month) against the current value — used to seed the forecast's return rate.
    const asOf = new Date();
    const flows: CashFlowPoint[] = stats.series.map((s) => ({
      amount: -Number(s.contributed),
      date: new Date(`${s.month}-15T00:00:00.000Z`),
    }));
    flows.push({ amount: Number(currentValue), date: asOf });
    const rate = stats.series.length ? xirr(flows) : NaN;
    const xirrVal = Number.isFinite(rate) ? rate : null;
    const seedAnnualReturn =
      xirrVal !== null && xirrVal > -0.5 && xirrVal < 0.5 ? xirrVal.toString() : "0.07";

    return {
      ...stats,
      currentValue,
      simpleGainPct,
      xirr: xirrVal,
      seedAnnualReturn,
      birthYear,
      portfolioType,
      asOf: asOf.toISOString(),
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
      return rows.map((r) => ({
        ...r,
        instrument: r.instrumentId ? (meta.get(r.instrumentId) ?? null) : null,
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
        .returning({ id: transactions.id });
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
      return rows.map((r) => ({ date: r.date, netWorth: r.netWorth }));
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
      const { coreTxns, summary } = await loadValuation(portfolioId, portfolio.baseCurrency);

      const flows = await externalFlows(coreTxns, portfolio.baseCurrency);
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
      const { coreTxns, summary } = await loadValuation(portfolioId, portfolio.baseCurrency);
      return buildContributions(
        coreTxns,
        summary,
        portfolio.baseCurrency,
        portfolio.birthYear,
        portfolio.portfolioType === "child" ? "child" : "standard",
      );
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
      const flowTxns: CoreTransaction[] = [];
      const instrumentIds = new Set<string>();
      for (const p of pfs) {
        const { coreTxns, summary } = await loadValuation(p.id, display, costBasisMode);
        summaries.push(summary);
        flowTxns.push(...coreTxns);
        for (const h of summary.holdings) instrumentIds.add(h.instrumentId);
      }

      const aggregated = aggregatePortfolios(summaries, display);
      const meta = await instrumentMeta([...instrumentIds]);
      const holdings = aggregated.holdings.map((h) => ({
        ...h,
        instrument: meta.get(h.instrumentId) ?? null,
      }));

      // Flows across all portfolios, each FX-converted to the display currency.
      const flows = await externalFlows(flowTxns, display);
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

  // Income analytics across all of the user's portfolios, in their display currency:
  // per-period totals, forecast, delta, breakdowns, yields, upcoming coupons + events.
  app.get("/networth/income", { preHandler: app.authenticate }, async (request) => {
    const { id } = requireUser(request);
    const [u] = await app.db
      .select({ displayCurrency: users.displayCurrency })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    const display = u?.displayCurrency ?? "IDR";

    const pfs = await app.db
      .select({ id: portfolios.id })
      .from(portfolios)
      .where(eq(portfolios.userId, id));

    const summaries = [];
    const allTxns: CoreTransaction[] = [];
    for (const p of pfs) {
      const { coreTxns, summary } = await loadValuation(p.id, display);
      summaries.push(summary);
      allTxns.push(...coreTxns);
    }
    const aggregated = aggregatePortfolios(summaries, display);

    return buildIncomeStats(allTxns, aggregated, display);
  });

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
      const { coreTxns, summary } = await loadValuation(portfolioId, portfolio.baseCurrency);
      return buildIncomeStats(coreTxns, summary, portfolio.baseCurrency);
    },
  );

  // Aggregate contribution analytics across all of the user's portfolios, in
  // their display currency.
  app.get("/networth/contributions", { preHandler: app.authenticate }, async (request) => {
    const { id } = requireUser(request);
    const [u] = await app.db
      .select({ displayCurrency: users.displayCurrency })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    const display = u?.displayCurrency ?? "IDR";

    const pfs = await app.db
      .select({ id: portfolios.id })
      .from(portfolios)
      .where(eq(portfolios.userId, id));

    const summaries: PortfolioSummary[] = [];
    const allTxns: CoreTransaction[] = [];
    for (const p of pfs) {
      const { coreTxns, summary } = await loadValuation(p.id, display);
      summaries.push(summary);
      allTxns.push(...coreTxns);
    }
    const aggregated = aggregatePortfolios(summaries, display);
    return buildContributions(allTxns, aggregated, display);
  });

  // Aggregate net-worth-over-time across all of the user's portfolios, summing each
  // day's snapshots converted to the display currency.
  app.get<{ Querystring: { range?: string } }>(
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
        .select({ id: portfolios.id })
        .from(portfolios)
        .where(eq(portfolios.userId, id));
      const pfIds = pfs.map((p) => p.id);
      if (pfIds.length === 0) return [];

      const start = rangeStart(request.query.range ?? "1y");
      const conds = [inArray(portfolioSnapshots.portfolioId, pfIds)];
      if (start) conds.push(gte(portfolioSnapshots.date, start));
      const rows = await app.db
        .select()
        .from(portfolioSnapshots)
        .where(and(...conds));

      const currencies = [...new Set(rows.map((r) => r.currency))];
      const dates = [...new Set(rows.map((r) => r.date))];
      const ratesByDate = await getFxRatesForDates(app.db, currencies, display, dates);
      return aggregateByDate(
        rows.map((r) => ({
          date: r.date,
          netWorth: r.netWorth,
          currency: r.currency,
        })),
        (date) => makeFxRateFn(ratesByDate.get(date) ?? {}, display),
        display,
      );
    },
  );
}
