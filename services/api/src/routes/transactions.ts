import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import {
  corporateActions,
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
  trailingIncomeByInstrument,
  trailingYield,
  contributionStats,
  type CoreTransaction,
  type CorporateAction,
  type CashFlowPoint,
  type PortfolioSummary,
} from "@portfolio/core";
import { getMarketData } from "../services/market-data.js";
import { valuePortfolio, type InstrumentMeta } from "../services/valuation.js";
import { getFxRates, makeFxRateFn } from "../services/fx.js";
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
  async function corporateActionsFor(
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

  // Build an instrumentId → presentation-metadata lookup for the given ids.
  async function instrumentMeta(
    ids: (string | null)[],
  ): Promise<Map<string, InstrumentMeta>> {
    const unique = [...new Set(ids.filter((x): x is string => x !== null))];
    if (!unique.length) return new Map();
    const rows = await app.db
      .select()
      .from(instruments)
      .where(inArray(instruments.id, unique));
    return new Map(
      rows.map((i) => [
        i.id,
        { symbol: i.symbol, name: i.name, assetClass: i.assetClass, unit: i.unit },
      ]),
    );
  }

  // Value a portfolio (holdings priced + cash + net worth) in `displayCurrency`.
  // Shared by /summary, /performance and /networth via the valuation service.
  async function loadValuation(portfolioId: string, displayCurrency: string) {
    return valuePortfolio(
      app.db,
      getMarketData(),
      app.config.MARKET_DATA_TTL_MS,
      portfolioId,
      displayCurrency,
    );
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
            (t) =>
              t.type === "deposit" ||
              t.type === "savings_plan" ||
              t.type === "withdrawal",
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
      xirrVal !== null && xirrVal > -0.5 && xirrVal < 0.5
        ? xirrVal.toString()
        : "0.07";

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
        .where(
          and(
            eq(transactions.id, txId),
            eq(transactions.portfolioId, portfolioId),
          ),
        )
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
        .where(
          and(
            eq(transactions.portfolioId, portfolioId),
            inArray(transactions.id, ids),
          ),
        )
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
          currency: input.currency,
          executedAt: input.executedAt,
          source: input.source,
          externalId: input.externalId,
        })
        .where(
          and(
            eq(transactions.id, txId),
            eq(transactions.portfolioId, portfolioId),
          ),
        )
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
  app.get<{ Params: PortfolioParams }>(
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
      const { coreTxns, summary } = await loadValuation(
        portfolioId,
        portfolio.baseCurrency,
      );

      // External capital flows: deposits in (−), withdrawals out (+).
      const flows: CashFlowPoint[] = [];
      for (const tx of coreTxns) {
        if (tx.type === "deposit") {
          flows.push({ amount: -Number(tx.price), date: tx.executedAt });
        } else if (tx.type === "withdrawal") {
          flows.push({ amount: Number(tx.price), date: tx.executedAt });
        }
      }
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
      );
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
  app.get("/networth", { preHandler: app.authenticate }, async (request) => {
    const { id } = requireUser(request);
    const [u] = await app.db
      .select({ displayCurrency: users.displayCurrency })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    const display = u?.displayCurrency ?? "IDR";

    const pfs = await app.db
      .select()
      .from(portfolios)
      .where(eq(portfolios.userId, id));

    const summaries = [];
    const flows: CashFlowPoint[] = [];
    const instrumentIds = new Set<string>();
    for (const p of pfs) {
      const { coreTxns, summary } = await loadValuation(p.id, display);
      summaries.push(summary);
      for (const tx of coreTxns) {
        if (tx.type === "deposit") {
          flows.push({ amount: -Number(tx.price), date: tx.executedAt });
        } else if (tx.type === "withdrawal") {
          flows.push({ amount: Number(tx.price), date: tx.executedAt });
        }
      }
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
  });

  // Income outlook across the user's portfolios: upcoming bond coupons (projected
  // from schedule) + trailing-12-month yield per income-paying holding.
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

    // Trailing-12-month income per instrument, FX-converted to the display currency.
    const incomeCurrencies = [
      ...new Set(
        allTxns
          .filter((t) => t.type === "dividend" || t.type === "coupon")
          .map((t) => t.currency),
      ),
    ];
    const rates = await getFxRates(app.db, incomeCurrencies, display);
    const fx = makeFxRateFn(rates, display);
    const since = new Date();
    since.setUTCFullYear(since.getUTCFullYear() - 1);
    const trailing = trailingIncomeByInstrument(allTxns, since, display, fx);

    // Yields: held instruments with a market value that paid income in the last year.
    const meta = await instrumentMeta(aggregated.holdings.map((h) => h.instrumentId));
    const yields = aggregated.holdings
      .filter(
        (h) =>
          h.marketValue !== null &&
          Number(h.marketValue) !== 0 &&
          Number(trailing[h.instrumentId] ?? 0) > 0,
      )
      .map((h) => {
        const trailingIncome = trailing[h.instrumentId] ?? "0";
        const im = meta.get(h.instrumentId);
        return {
          instrumentId: h.instrumentId,
          symbol: im?.symbol ?? "—",
          name: im?.name ?? null,
          trailingIncome,
          marketValue: h.marketValue as string,
          yield: trailingYield(trailingIncome, h.marketValue as string),
          currency: display,
        };
      })
      .sort((a, b) => Number(b.yield ?? 0) - Number(a.yield ?? 0));

    // Upcoming coupons from held bonds (next 12 months).
    const heldIds = aggregated.holdings.map((h) => h.instrumentId);
    const bondRows = heldIds.length
      ? await app.db
          .select()
          .from(instruments)
          .where(and(inArray(instruments.id, heldIds), eq(instruments.assetClass, "bond")))
      : [];
    const qtyById = new Map(aggregated.holdings.map((h) => [h.instrumentId, h.quantity]));
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
    const upcoming = projectCoupons(positions, 12);

    return { displayCurrency: display, upcoming, yields };
  });

  // Aggregate contribution analytics across all of the user's portfolios, in
  // their display currency.
  app.get(
    "/networth/contributions",
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

      const summaries: PortfolioSummary[] = [];
      const allTxns: CoreTransaction[] = [];
      for (const p of pfs) {
        const { coreTxns, summary } = await loadValuation(p.id, display);
        summaries.push(summary);
        allTxns.push(...coreTxns);
      }
      const aggregated = aggregatePortfolios(summaries, display);
      return buildContributions(allTxns, aggregated, display);
    },
  );

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
      const rates = await getFxRates(app.db, currencies, display);
      const fx = makeFxRateFn(rates, display);
      return aggregateByDate(
        rows.map((r) => ({
          date: r.date,
          netWorth: r.netWorth,
          currency: r.currency,
        })),
        fx,
        display,
      );
    },
  );
}
