import type { FastifyInstance } from "fastify";
import { and, count, desc, eq, getTableColumns, gte, inArray, lt, sql } from "drizzle-orm";
import { portfolios, transactions } from "@portfolio/db";
import { requireUser } from "../../plugins/auth.js";
import { logTiming } from "../../lib/timing.js";
import { withDerivationCache } from "../../lib/derivation-cache.js";
import { ownedPortfolio } from "../helpers.js";
import {
  yearRange,
  ACTIVITY_INCOME_TYPES,
  transactionsCache,
  networthTransactionsCache,
} from "./shared.js";
import { enrichRows, enrichAggregateRows } from "./list-enrichment.js";

export function registerListRoutes(app: FastifyInstance) {
  app.get<{
    Params: { portfolioId: string };
    Querystring: {
      convertTo?: string;
      page?: string;
      pageSize?: string;
      type?: string;
      year?: string;
      q?: string;
    };
  }>(
    "/portfolios/:portfolioId/transactions",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const portfolio = await ownedPortfolio(app, id, request.params.portfolioId);
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
      if (typeFilter === "buy")
        conditions.push(inArray(transactions.type, ["buy", "savings_plan"]));
      if (typeFilter === "sell") conditions.push(eq(transactions.type, "sell"));
      if (typeFilter === "income")
        conditions.push(inArray(transactions.type, ACTIVITY_INCOME_TYPES));
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

      if (paginate) {
        const cacheKey = `transactions:${request.params.portfolioId}:${page}:${pageSize}:${convertTo || ""}:${typeFilter || ""}:${yearFilter || ""}:${searchQuery || ""}`;
        const cached = await withDerivationCache(transactionsCache, cacheKey, async () => {
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
          let _rows: (typeof transactions.$inferSelect)[];
          if (merged.length > 0) {
            cnt = Number(merged[0].__total);
            summaryRows = {
              totalInvested: merged[0].__totalInvested,
              totalProceeds: merged[0].__totalProceeds,
              totalIncome: merged[0].__totalIncome,
            };
            _rows = merged.map(
              ({ __total, __totalInvested, __totalProceeds, __totalIncome, ...r }) => r,
            );
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
          return enrichRows(
            app,
            _rows,
            cnt,
            summaryRows,
            portfolioName,
            request.params.portfolioId,
            convertTo,
            paginate,
            page,
            request.log,
            t0,
          );
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
      const result = await enrichRows(
        app,
        rows,
        rows.length,
        undefined,
        portfolioName,
        request.params.portfolioId,
        convertTo,
        paginate,
        page,
        request.log,
        t0,
      );
      return result.rows;
    },
  );

  app.get<{
    Querystring: { page?: string; pageSize?: string; type?: string; year?: string; q?: string };
  }>("/networth/transactions", { preHandler: app.authenticate }, async (request, _reply) => {
    const t0 = performance.now();
    const { id } = requireUser(request);
    const paginate = request.query.page !== undefined;
    const page = paginate ? Math.max(1, parseInt(request.query.page!, 10) || 1) : 1;
    const pageSize = paginate
      ? Math.min(100, Math.max(1, parseInt(request.query.pageSize ?? "25", 10) || 25))
      : 0;
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

    if (paginate) {
      const cacheKey = `${id}:networth:${page}:${pageSize}:${typeFilter ?? ""}:${yearFilter ?? ""}:${searchQuery ?? ""}`;
      const cached = await withDerivationCache(networthTransactionsCache, cacheKey, async () => {
        const merged = await app.db
          .select({ ...getTableColumns(transactions), __total: sql<number>`count(*) over ()` })
          .from(transactions)
          .where(and(...conditions))
          .orderBy(desc(transactions.executedAt))
          .limit(pageSize)
          .offset((page - 1) * pageSize);

        let total: number;
        let rows: (typeof transactions.$inferSelect)[];
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
        const enriched = await enrichAggregateRows(app, rows, nameById, request.log);
        return { rows: enriched, total };
      });
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
    const enriched = await enrichAggregateRows(app, rows, nameById, request.log);
    const durationMs = performance.now() - t0;
    logTiming(request, "GET /networth/transactions", durationMs, {
      rowCount: rows.length,
      portfolioCount: pfs.length,
    });
    return enriched;
  });
}
