import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { accountHolders, portfolios } from "@portfolio/db";
import { flattenJoinRow } from "../lib/portfolio.js";

/** Unified ownership check — portfolio exists + belongs to user. */
export async function ownedPortfolio(app: FastifyInstance, userId: string, portfolioId: string) {
  const [row] = await app.db
    .select()
    .from(portfolios)
    .leftJoin(accountHolders, eq(portfolios.accountHolderId, accountHolders.id))
    .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
    .limit(1);
  return row ? flattenJoinRow(row) : null;
}

export interface PaginationParams {
  page: number;
  pageSize: number;
}

export function parsePagination(query: { page?: string; pageSize?: string }): PaginationParams {
  const rawPage = query.page;
  const rawPageSize = query.pageSize;
  if (rawPage === undefined) {
    return { page: 1, pageSize: 0 };
  }
  const page = Math.max(1, parseInt(rawPage, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(rawPageSize ?? "25", 10) || 25));
  return { page, pageSize };
}

export function paginate(p: PaginationParams): { limit?: number; offset?: number } {
  if (p.pageSize <= 0) return {};
  return { limit: p.pageSize, offset: (p.page - 1) * p.pageSize };
}

export function cacheKey(...parts: (string | number | null | undefined)[]): string {
  return parts.filter((p) => p != null && p !== "").join(":");
}
