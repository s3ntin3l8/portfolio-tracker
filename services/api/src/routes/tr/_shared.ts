import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { accountHolders, portfolios, trConnections } from "@portfolio/db";

type TrConnection = typeof trConnections.$inferSelect;

export function serialize(conn: TrConnection | null) {
  return {
    status: conn?.status ?? "disconnected",
    portfolioId: conn?.portfolioId ?? null,
    lastSyncAt: conn?.lastSyncAt ?? null,
    lastError: conn?.lastError ?? null,
    lastReconciliation: conn?.lastReconciliation ?? null,
    syncing: conn?.syncing ?? false,
  };
}

export async function getConnection(
  app: FastifyInstance,
  userId: string,
): Promise<TrConnection | null> {
  const [conn] = await app.db
    .select()
    .from(trConnections)
    .where(eq(trConnections.userId, userId))
    .limit(1);
  return conn ?? null;
}

export async function lookupPortfolio(app: FastifyInstance, userId: string, portfolioId: string) {
  const [p] = await app.db
    .select({ id: portfolios.id, holderType: accountHolders.type })
    .from(portfolios)
    .leftJoin(accountHolders, eq(portfolios.accountHolderId, accountHolders.id))
    .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
    .limit(1);
  if (!p) return null;
  return { id: p.id, isChild: p.holderType === "child" };
}
