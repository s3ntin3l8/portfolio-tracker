import type { FastifyInstance, FastifyReply } from "fastify";
import { and, eq } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
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

/** Insert a row and return it with a 201 status. */
export async function createAndReturn(
  db: FastifyInstance["db"],
  reply: FastifyReply,
  table: PgTable,
  values: Record<string, unknown>,
) {
  const [created] = await db.insert(table).values(values).returning();
  reply.code(201);
  return created;
}

/** Delete a row by arbitrary conditions — 404 if missing, 204 on success. */
export async function deleteOwnedOr404(
  reply: FastifyReply,
  db: FastifyInstance["db"],
  table: PgTable,
  conditions: SQL | undefined,
  errorMessage = "not_found",
) {
  const [deleted] = await db.delete(table).where(conditions).returning();
  if (!deleted) return reply.code(404).send({ error: errorMessage });
  return reply.code(204).send();
}
