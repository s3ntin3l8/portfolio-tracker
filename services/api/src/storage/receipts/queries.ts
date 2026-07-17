import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { documents } from "@portfolio/db";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "@portfolio/db";
import type { DocumentMeta, DocumentSummary } from "./types.js";

type AppLikeDb = Pick<FastifyInstance, "db">;

function db(app: AppLikeDb): PostgresJsDatabase<typeof schema> {
  return app.db as PostgresJsDatabase<typeof schema>;
}

export async function getDocumentForImport(
  app: AppLikeDb,
  importId: string,
): Promise<DocumentMeta | null> {
  const rows = await db(app)
    .select()
    .from(documents)
    .where(and(eq(documents.importId, importId), eq(documents.status, "retained")))
    .limit(1);
  return (rows[0] as DocumentMeta) ?? null;
}

export async function getDocumentForTransaction(
  app: AppLikeDb,
  txId: string,
  txImportId: string | null,
): Promise<DocumentMeta | null> {
  const txRows = await db(app)
    .select()
    .from(documents)
    .where(and(eq(documents.transactionId, txId), eq(documents.status, "retained")))
    .orderBy(desc(documents.storedAt))
    .limit(1);
  if (txRows.length > 0) return txRows[0] as DocumentMeta;

  if (!txImportId) return null;
  const impRows = await db(app)
    .select()
    .from(documents)
    .where(and(eq(documents.importId, txImportId), eq(documents.status, "retained")))
    .limit(1);
  return (impRows[0] as DocumentMeta) ?? null;
}

export async function getDocumentSummaryForImport(
  app: AppLikeDb,
  importId: string,
): Promise<DocumentSummary | null> {
  const rows = await db(app)
    .select({
      id: documents.id,
      originalFilename: documents.originalFilename,
      mimeType: documents.mimeType,
      sizeBytes: documents.sizeBytes,
      storedAt: documents.storedAt,
    })
    .from(documents)
    .where(and(eq(documents.importId, importId), eq(documents.status, "retained")))
    .limit(1);
  return rows[0] ?? null;
}

export async function getOriginalFilenamesForImports(
  app: AppLikeDb,
  importIds: string[],
): Promise<Map<string, string>> {
  if (importIds.length === 0) return new Map();
  const rows = await db(app)
    .select({ importId: documents.importId, originalFilename: documents.originalFilename })
    .from(documents)
    .where(
      and(
        inArray(documents.importId, importIds),
        inArray(documents.status, ["staged", "retained"]),
      ),
    );
  const out = new Map<string, string>();
  for (const r of rows) {
    if (!r.importId || !r.originalFilename || out.has(r.importId)) continue;
    out.set(r.importId, r.originalFilename);
  }
  return out;
}

export async function getDocumentSummariesForImports(
  app: AppLikeDb,
  importIds: string[],
): Promise<Map<string, DocumentSummary>> {
  if (importIds.length === 0) return new Map();
  const rows = await db(app)
    .select({
      importId: documents.importId,
      id: documents.id,
      originalFilename: documents.originalFilename,
      mimeType: documents.mimeType,
      sizeBytes: documents.sizeBytes,
      storedAt: documents.storedAt,
    })
    .from(documents)
    .where(and(inArray(documents.importId, importIds), eq(documents.status, "retained")));
  const out = new Map<string, DocumentSummary>();
  for (const r of rows) {
    if (!r.importId || out.has(r.importId)) continue;
    out.set(r.importId, {
      id: r.id,
      originalFilename: r.originalFilename,
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      storedAt: r.storedAt,
    });
  }
  return out;
}

export async function importIdsWithDocuments(
  app: AppLikeDb,
  importIds: string[],
): Promise<Set<string>> {
  if (importIds.length === 0) return new Set();
  const rows = await db(app)
    .select({ importId: documents.importId })
    .from(documents)
    .where(and(inArray(documents.importId, importIds), eq(documents.status, "retained")));
  return new Set(rows.map((r) => r.importId).filter((id): id is string => id !== null));
}

export async function transactionIdsWithDocuments(
  app: AppLikeDb,
  txIds: string[],
): Promise<Set<string>> {
  if (txIds.length === 0) return new Set();
  const rows = await db(app)
    .select({ transactionId: documents.transactionId })
    .from(documents)
    .where(and(inArray(documents.transactionId, txIds), eq(documents.status, "retained")));
  return new Set(rows.map((r) => r.transactionId).filter((id): id is string => id !== null));
}

export async function documentIdsWithRetained(
  app: AppLikeDb,
  importIds: string[],
  txIds: string[],
): Promise<{ importIdsWithDocs: Set<string>; txIdsWithDocs: Set<string> }> {
  const hasImportIds = importIds.length > 0;
  const hasTxIds = txIds.length > 0;
  if (!hasImportIds && !hasTxIds) return { importIdsWithDocs: new Set(), txIdsWithDocs: new Set() };

  const conditions: ReturnType<typeof and>[] = [eq(documents.status, "retained")];
  if (hasImportIds && hasTxIds) {
    conditions.push(
      or(inArray(documents.importId, importIds), inArray(documents.transactionId, txIds)),
    );
  } else if (hasImportIds) {
    conditions.push(inArray(documents.importId, importIds));
  } else {
    conditions.push(inArray(documents.transactionId, txIds));
  }

  const rows = await db(app)
    .select({ importId: documents.importId, transactionId: documents.transactionId })
    .from(documents)
    .where(and(...conditions));

  const importIdsWithDocsSet = new Set(
    rows.map((r) => r.importId).filter((id): id is string => id !== null),
  );
  const txIdsWithDocsSet = new Set(
    rows.map((r) => r.transactionId).filter((id): id is string => id !== null),
  );
  return { importIdsWithDocs: importIdsWithDocsSet, txIdsWithDocs: txIdsWithDocsSet };
}
