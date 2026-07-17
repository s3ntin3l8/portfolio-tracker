import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import { documents, transactions } from "@portfolio/db";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "@portfolio/db";
import { deleteStorageObjects } from "./lifecycle.js";

type AppLike = Pick<FastifyInstance, "storage" | "db" | "log">;
type AppLikeDb = Pick<FastifyInstance, "db">;

function db(app: AppLikeDb): PostgresJsDatabase<typeof schema> {
  return app.db as PostgresJsDatabase<typeof schema>;
}

async function maybeDeleteOrphanImportReceipts(app: AppLike, importId: string): Promise<void> {
  const remaining = await db(app)
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.importId, importId))
    .limit(1);

  if (remaining.length === 0) {
    await deleteReceiptsForImport(app, importId);
    app.log.debug({ importId }, "orphan import receipts cleaned up");
  }
}

export async function deleteReceiptsForImport(app: AppLike, importId: string): Promise<void> {
  const rows = await db(app)
    .select({ id: documents.id, storageKey: documents.storageKey })
    .from(documents)
    .where(eq(documents.importId, importId));

  if (rows.length === 0) return;
  await deleteStorageObjects(app, rows, `importId=${importId}`);
  await db(app).delete(documents).where(eq(documents.importId, importId));
}

export async function deleteReceiptsForPortfolio(app: AppLike, portfolioId: string): Promise<void> {
  const rows = await db(app)
    .select({ id: documents.id, storageKey: documents.storageKey })
    .from(documents)
    .where(eq(documents.portfolioId, portfolioId));

  if (rows.length === 0) return;
  await deleteStorageObjects(app, rows, `portfolioId=${portfolioId}`);
}

export async function deleteReceiptsForTransactions(
  app: AppLike,
  txIds: string[],
  importIds: string[],
): Promise<void> {
  if (txIds.length === 0) return;

  const txRows = await db(app)
    .select({ id: documents.id, storageKey: documents.storageKey })
    .from(documents)
    .where(inArray(documents.transactionId, txIds));
  if (txRows.length > 0) {
    await deleteStorageObjects(app, txRows, `txIds`);
    await db(app).delete(documents).where(inArray(documents.transactionId, txIds));
  }

  const uniqueImportIds = [...new Set(importIds.filter(Boolean))];
  for (const importId of uniqueImportIds) {
    await maybeDeleteOrphanImportReceipts(app, importId);
  }
}

export async function gcStagedReceipts(app: AppLike, maxAgeDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000);

  const staleRows = await db(app)
    .select({ id: documents.id, storageKey: documents.storageKey, storedAt: documents.storedAt })
    .from(documents)
    .where(eq(documents.status, "staged"));

  const expired = staleRows.filter((r) => r.storedAt < cutoff);
  if (expired.length === 0) return 0;

  await deleteStorageObjects(app, expired, "gc-staged");
  await db(app)
    .delete(documents)
    .where(
      inArray(
        documents.id,
        expired.map((r) => r.id),
      ),
    );
  app.log.info({ count: expired.length }, "gc: deleted expired staged receipts");
  return expired.length;
}

export async function deleteStorageObjectsByKey(
  app: Pick<FastifyInstance, "storage" | "log">,
  rows: { id: string; storageKey: string }[],
  context: string,
): Promise<void> {
  return deleteStorageObjects(app, rows, context);
}
