import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { documents } from "@portfolio/db";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "@portfolio/db";
import {
  buildStructuredKey,
  gatherDocumentNaming,
  gatherDocumentMetadata,
  computeNamingParts,
  namingContextFor,
  type NamingRequest,
} from "../naming.js";
import { buildReceiptKey } from "./keys.js";
import type { StoreReceiptOptions, FinalizeReceiptsOptions, StoreReceiptResult } from "./types.js";

type AppLike = Pick<FastifyInstance, "storage" | "db" | "log">;
type AppLikeDb = Pick<FastifyInstance, "db">;

function db(app: AppLikeDb): PostgresJsDatabase<typeof schema> {
  return app.db as PostgresJsDatabase<typeof schema>;
}

export async function storeReceipt(
  app: AppLike,
  opts: StoreReceiptOptions,
): Promise<StoreReceiptResult> {
  const {
    userId,
    importId,
    buf,
    mimeType,
    originalFilename,
    source,
    sourceEventId,
    status = "staged",
  } = opts;
  const key = buildReceiptKey(userId, importId, originalFilename, mimeType);

  try {
    await app.storage.put(key, buf, {
      mimeType,
      originalFilename: originalFilename ?? undefined,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    app.log.error({ err, importId, key }, "storeReceipt: storage put failed");
    return { ok: false, error: `storage put failed: ${error}` };
  }

  try {
    const [row] = await db(app)
      .insert(documents)
      .values({
        userId,
        importId,
        storageKey: key,
        mimeType,
        originalFilename: originalFilename ?? null,
        sizeBytes: buf.byteLength,
        status,
        source: source ?? null,
        sourceEventId: sourceEventId ?? null,
      })
      .returning({ id: documents.id });
    app.log.debug({ importId, key, bytes: buf.byteLength, status }, "receipt staged");
    return { ok: true, documentId: row.id };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    app.log.error({ err, importId, key }, "storeReceipt: db insert failed after successful put");
    return { ok: false, error: `db insert failed: ${error}` };
  }
}

export async function finalizeReceipts(app: AppLike, opts: FinalizeReceiptsOptions): Promise<void> {
  const { importId, portfolioId, retain } = opts;

  const rows = await db(app)
    .select({
      id: documents.id,
      storageKey: documents.storageKey,
      mimeType: documents.mimeType,
      originalFilename: documents.originalFilename,
      source: documents.source,
      storedAt: documents.storedAt,
      transactionId: documents.transactionId,
      userId: documents.userId,
    })
    .from(documents)
    .where(and(eq(documents.importId, importId), eq(documents.status, "staged")));

  if (rows.length === 0) return;

  if (retain) {
    await db(app)
      .update(documents)
      .set({ status: "retained", portfolioId })
      .where(and(eq(documents.importId, importId), eq(documents.status, "staged")));

    const namingRequests: NamingRequest[] = rows.map((row) => ({ doc: { ...row, importId } }));
    const namingMeta = await gatherDocumentMetadata(app, namingRequests, portfolioId);
    for (const row of rows) {
      try {
        const req: NamingRequest = { doc: { ...row, importId } };
        const parts = computeNamingParts(req.doc, namingContextFor(req, namingMeta));
        const newKey = buildStructuredKey(row.userId, parts);
        if (newKey === row.storageKey) continue;

        await app.storage.move(row.storageKey, newKey, {
          mimeType: row.mimeType,
          originalFilename: row.originalFilename ?? undefined,
        });
        await db(app).update(documents).set({ storageKey: newKey }).where(eq(documents.id, row.id));

        app.log.debug(
          { docId: row.id, oldKey: row.storageKey, newKey },
          "receipt re-keyed to structured path",
        );
      } catch (err) {
        app.log.warn(
          { err, docId: row.id, key: row.storageKey },
          "receipt re-key failed (non-fatal) — keeping old key",
        );
      }
    }

    app.log.debug({ importId, portfolioId, count: rows.length }, "receipts retained");
  } else {
    await deleteStorageObjects(app, rows, `finalize importId=${importId}`);
    await db(app)
      .delete(documents)
      .where(and(eq(documents.importId, importId), eq(documents.status, "staged")));
    app.log.debug({ importId, count: rows.length }, "receipts discarded (retention off)");
  }
}

export async function retainDocumentForTransaction(
  app: AppLike,
  opts: {
    importId: string;
    transactionId: string;
    portfolioId: string;
  },
): Promise<string | null> {
  const { importId, transactionId, portfolioId } = opts;

  const [row] = await db(app)
    .select({
      id: documents.id,
      storageKey: documents.storageKey,
      mimeType: documents.mimeType,
      originalFilename: documents.originalFilename,
      source: documents.source,
      storedAt: documents.storedAt,
      userId: documents.userId,
    })
    .from(documents)
    .where(and(eq(documents.importId, importId), eq(documents.status, "staged")))
    .limit(1);

  if (!row) return null;

  await db(app)
    .update(documents)
    .set({ status: "retained", transactionId, portfolioId })
    .where(eq(documents.id, row.id));

  try {
    const parts = await gatherDocumentNaming(app, {
      doc: { ...row, importId, transactionId },
      portfolioId,
      txId: transactionId,
    });
    const newKey = buildStructuredKey(row.userId, parts);
    if (newKey !== row.storageKey) {
      await app.storage.move(row.storageKey, newKey, {
        mimeType: row.mimeType,
        originalFilename: row.originalFilename ?? undefined,
      });
      await db(app).update(documents).set({ storageKey: newKey }).where(eq(documents.id, row.id));
    }
  } catch (err) {
    app.log.warn(
      { err, docId: row.id, importId },
      "retainDocumentForTransaction: re-key failed (non-fatal)",
    );
  }

  return row.id;
}

export async function getStagedDocumentId(
  app: AppLikeDb,
  importId: string,
): Promise<string | null> {
  const [row] = await db(app)
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.importId, importId), eq(documents.status, "staged")))
    .limit(1);
  return row?.id ?? null;
}

export async function deleteStorageObjects(
  app: Pick<FastifyInstance, "storage" | "log">,
  rows: { id: string; storageKey: string }[],
  context: string,
): Promise<void> {
  await Promise.all(
    rows.map(async (row) => {
      try {
        await app.storage.delete(row.storageKey);
      } catch (err) {
        app.log.warn({ err, key: row.storageKey, context }, "storage.delete failed (non-fatal)");
      }
    }),
  );
}
