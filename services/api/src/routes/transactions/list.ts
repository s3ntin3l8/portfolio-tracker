import type { FastifyInstance } from "fastify";
import { and, count, desc, eq, getTableColumns, gte, inArray, lt, sql } from "drizzle-orm";
import { portfolios, transactions } from "@portfolio/db";
import { ACQUISITION_TYPES, INCOME_TYPES } from "@portfolio/core";
import { withDerivationCache } from "../../lib/derivation-cache.js";
import { parsePagination, cacheKey } from "../helpers.js";
import {
  yearRange,
  summaryWindowAggregates,
  summaryAggregates,
  transactionsCache,
  networthTransactionsCache,
} from "./shared.js";
import { enrichRows, enrichAggregateRows } from "./list-enrichment.js";

// Fetch-by-id support for the "Show flagged only" / "Needs review" filter (#562): the
// client already knows every flagged transaction's id (from the anomalies endpoint) but
// those rows may sit past the current page. `ids` lets it fetch exactly those rows,
// regardless of pagination, instead of filtering only what's already loaded client-side.
function parseIdsParam(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : null;
}

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
      ids?: string;
      instrumentId?: string;
    };
  }>(
    "/portfolios/:portfolioId/transactions",
    { preHandler: [app.authenticate, app.requirePortfolio] },
    async (request) => {
      const t0 = performance.now();
      const portfolioName = request.portfolio.name;
      const { page, pageSize } = parsePagination({
        page: request.query.page,
        pageSize: request.query.pageSize,
      });
      const paginate = pageSize > 0;

      const convertTo = request.query.convertTo;
      const typeFilter = request.query.type;
      const yearFilter = request.query.year;
      const searchQuery = request.query.q;
      const idsFilter = parseIdsParam(request.query.ids);
      const instrumentIdFilter = request.query.instrumentId;

      const conditions = [eq(transactions.portfolioId, request.params.portfolioId)];
      if (idsFilter) conditions.push(inArray(transactions.id, idsFilter));
      if (instrumentIdFilter) conditions.push(eq(transactions.instrumentId, instrumentIdFilter));
      if (typeFilter === "buy") conditions.push(inArray(transactions.type, ACQUISITION_TYPES));
      if (typeFilter === "sell") conditions.push(eq(transactions.type, "sell"));
      if (typeFilter === "income") conditions.push(inArray(transactions.type, INCOME_TYPES));
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
        const ck = cacheKey(
          "transactions",
          request.params.portfolioId,
          page,
          pageSize,
          convertTo || "",
          typeFilter || "",
          yearFilter || "",
          searchQuery || "",
          instrumentIdFilter || "",
        );
        const cached = await withDerivationCache(transactionsCache, ck, async () => {
          const merged = await app.db
            .select({
              ...getTableColumns(transactions),
              __total: sql<number>`count(*) over ()`,
              ...summaryWindowAggregates(transactions),
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
                .select({ ...summaryAggregates(transactions) })
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
        const yearConditions = [eq(transactions.portfolioId, request.params.portfolioId)];
        if (instrumentIdFilter)
          yearConditions.push(eq(transactions.instrumentId, instrumentIdFilter));
        const years = await app.db
          .select({ year: sql<number>`DISTINCT EXTRACT(YEAR FROM ${transactions.executedAt})` })
          .from(transactions)
          .where(and(...yearConditions))
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
    Querystring: {
      page?: string;
      pageSize?: string;
      type?: string;
      year?: string;
      q?: string;
      ids?: string;
      instrumentId?: string;
    };
  }>("/networth/transactions", { preHandler: app.authenticate }, async (request, _reply) => {
    request.timingName = "GET /networth/transactions";
    const id = request.userId;
    const { page, pageSize } = parsePagination({
      page: request.query.page,
      pageSize: request.query.pageSize,
    });
    const paginate = pageSize > 0;
    const typeFilter = request.query.type;
    const yearFilter = request.query.year;
    const searchQuery = request.query.q;
    const idsFilter = parseIdsParam(request.query.ids);
    const instrumentIdFilter = request.query.instrumentId;

    const pfs = await app.db
      .select({ id: portfolios.id, name: portfolios.name, baseCurrency: portfolios.baseCurrency })
      .from(portfolios)
      .where(eq(portfolios.userId, id));
    if (pfs.length === 0) return paginate ? { rows: [], total: 0 } : [];

    const pfIds = pfs.map((p) => p.id);
    const nameById = new Map(pfs.map((p) => [p.id, p.name]));

    const conditions = [inArray(transactions.portfolioId, pfIds)];
    if (idsFilter) conditions.push(inArray(transactions.id, idsFilter));
    if (instrumentIdFilter) conditions.push(eq(transactions.instrumentId, instrumentIdFilter));
    if (typeFilter === "buy") conditions.push(inArray(transactions.type, ACQUISITION_TYPES));
    if (typeFilter === "sell") conditions.push(eq(transactions.type, "sell"));
    if (typeFilter === "income") conditions.push(inArray(transactions.type, INCOME_TYPES));
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
      const ck = cacheKey(
        id,
        "networth",
        page,
        pageSize,
        typeFilter ?? "",
        yearFilter ?? "",
        searchQuery ?? "",
        instrumentIdFilter ?? "",
      );
      const cached = await withDerivationCache(networthTransactionsCache, ck, async () => {
        const merged = await app.db
          .select({
            ...getTableColumns(transactions),
            __total: sql<number>`count(*) over ()`,
            ...summaryWindowAggregates(transactions),
          })
          .from(transactions)
          .where(and(...conditions))
          .orderBy(desc(transactions.executedAt))
          .limit(pageSize)
          .offset((page - 1) * pageSize);

        let total: number;
        let summaryRows: { totalInvested: string; totalProceeds: string; totalIncome: string };
        let rows: (typeof transactions.$inferSelect)[];
        if (merged.length > 0) {
          total = Number(merged[0].__total);
          summaryRows = {
            totalInvested: merged[0].__totalInvested,
            totalProceeds: merged[0].__totalProceeds,
            totalIncome: merged[0].__totalIncome,
          };
          rows = merged.map(
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
              .select({ ...summaryAggregates(transactions) })
              .from(transactions)
              .where(and(...conditions))
              .then((r) => r[0]),
          ]);
          total = c;
          summaryRows = s;
          rows = [];
        }
        const enriched = await enrichAggregateRows(app, rows, nameById, request.log);
        return { rows: enriched, total, summary: summaryRows };
      });
      const yearConditions = [inArray(transactions.portfolioId, pfIds)];
      if (instrumentIdFilter)
        yearConditions.push(eq(transactions.instrumentId, instrumentIdFilter));
      const years = await app.db
        .select({ year: sql<number>`DISTINCT EXTRACT(YEAR FROM ${transactions.executedAt})` })
        .from(transactions)
        .where(and(...yearConditions))
        .orderBy(sql`1 DESC`);
      const yearList = years.map((r) => String(r.year));
      request.timingMeta = {
        page,
        pageSize,
        total: cached.total,
        portfolioCount: pfs.length,
      };
      return {
        rows: cached.rows,
        total: cached.total,
        summary: cached.summary,
        years: yearList,
      };
    }

    const rows = await app.db
      .select()
      .from(transactions)
      .where(and(...conditions))
      .orderBy(desc(transactions.executedAt));
    const enriched = await enrichAggregateRows(app, rows, nameById, request.log);
    request.timingMeta = {
      rowCount: rows.length,
      portfolioCount: pfs.length,
    };
    return enriched;
  });
}
