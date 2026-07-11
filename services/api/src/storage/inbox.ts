/**
 * Inbox document storage — account-level documents that don't belong to any single
 * transaction or import (e.g. TR's annual tax report, user-uploaded tax PDFs).
 *
 * Deliberately does NOT reuse the receipts.ts staging/GC lifecycle: `storeReceipt` requires
 * an importId and stages new docs as status="staged", which `gcStagedReceipts` sweeps after
 * 7 days. An inbox document has no import to confirm against, so staging it would mean
 * silent deletion on day 8. Inbox docs are written straight to status="retained" and are
 * therefore already excluded from that sweep (it only queries status="staged").
 *
 * Idempotency: pytr-sourced docs carry `sourceEventId` (the TR postbox event id) and are
 * deduped per user via `documents_user_source_event_unique_idx` — a daily re-sync that
 * re-lists the same report is a no-op. Uploads have no sourceEventId and dedup at the route
 * layer via content hash (mirroring the screenshot/CSV import upload path).
 *
 * Key convention: inbox/{userId}/{category}/{taxYear|misc}/{sanitizedFilename}
 */

import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { documents } from "@portfolio/db";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "@portfolio/db";
import type { DocumentCategory } from "@portfolio/schema";
import { extFromMime } from "./naming.js";
import { sanitiseFilename } from "./receipts.js";

type AppLike = Pick<FastifyInstance, "storage" | "db" | "log">;
type AppLikeDb = Pick<FastifyInstance, "db">;

function db(app: AppLikeDb): PostgresJsDatabase<typeof schema> {
  return app.db as PostgresJsDatabase<typeof schema>;
}

export function buildInboxKey(
  userId: string,
  category: DocumentCategory,
  taxYear: number | null | undefined,
  originalFilename?: string | null,
  mimeType?: string,
): string {
  const filename = originalFilename
    ? sanitiseFilename(originalFilename)
    : `document${mimeType ? extFromMime(mimeType) : ""}`;
  const yearSegment = taxYear ? String(taxYear) : "misc";
  return `inbox/${userId}/${category}/${yearSegment}/${filename}`;
}

export interface StoreInboxDocumentOptions {
  userId: string;
  /** The portfolio/TR connection this report covers — required (see documents' plan doc
   *  comment: every inbox document must be associated with an account). */
  portfolioId: string;
  category: DocumentCategory;
  taxYear?: number | null;
  buf: Buffer;
  mimeType: string;
  originalFilename?: string | null;
  /** "pytr" for TR postbox fetches, "upload" for user uploads. */
  source?: string | null;
  /** TR postbox event id — the idempotency key for pytr-sourced docs. Omit for uploads. */
  sourceEventId?: string | null;
}

export type StoreInboxDocumentResult =
  | { ok: true; documentId: string; duplicate?: boolean }
  | { ok: false; error: string };

export interface InboxDocumentMeta {
  id: string;
  userId: string;
  portfolioId: string | null;
  category: string;
  taxYear: number | null;
  storageKey: string;
  mimeType: string;
  originalFilename: string | null;
  sizeBytes: number | null;
  source: string | null;
  storedAt: Date;
}

/**
 * Store an inbox document and insert its `documents` row directly as status="retained" —
 * see module doc for why this bypasses storeReceipt's staging lifecycle.
 *
 * For pytr-sourced docs (sourceEventId set): checks for an existing row first so a routine
 * re-sync skips the storage put entirely; `onConflictDoNothing()` on the insert is the
 * race-safety net for two concurrent fetches, in which case the just-written object is
 * cleaned up and the existing row's id is returned.
 */
export async function storeInboxDocument(
  app: AppLike,
  opts: StoreInboxDocumentOptions,
): Promise<StoreInboxDocumentResult> {
  const { userId, portfolioId, category, taxYear, buf, mimeType, originalFilename, source, sourceEventId } =
    opts;

  if (sourceEventId) {
    const existingId = await _findBySourceEvent(app, userId, sourceEventId);
    if (existingId) return { ok: true, documentId: existingId, duplicate: true };
  }

  const key = buildInboxKey(userId, category, taxYear, originalFilename, mimeType);

  try {
    await app.storage.put(key, buf, {
      mimeType,
      originalFilename: originalFilename ?? undefined,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    app.log.error({ err, userId, key }, "storeInboxDocument: storage put failed");
    return { ok: false, error: `storage put failed: ${error}` };
  }

  try {
    const [row] = await db(app)
      .insert(documents)
      .values({
        userId,
        portfolioId,
        storageKey: key,
        mimeType,
        originalFilename: originalFilename ?? null,
        sizeBytes: buf.byteLength,
        status: "retained",
        category,
        taxYear: taxYear ?? null,
        source: source ?? null,
        sourceEventId: sourceEventId ?? null,
      })
      // Bare (no target) — documents' only unique constraint is
      // documents_user_source_event_unique_idx, the same race this guards against.
      .onConflictDoNothing()
      .returning({ id: documents.id });

    if (row) {
      app.log.debug({ userId, key, bytes: buf.byteLength, category }, "inbox document stored");
      return { ok: true, documentId: row.id };
    }

    // Lost the race: another concurrent fetch inserted the same sourceEventId first. The
    // object we just put is now orphaned — clean it up and return the winner's id.
    await _deleteObjectBestEffort(app, key, userId);
    const existingId = sourceEventId ? await _findBySourceEvent(app, userId, sourceEventId) : null;
    if (existingId) return { ok: true, documentId: existingId, duplicate: true };
    return { ok: false, error: "insert conflicted but no existing row found" };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    app.log.error({ err, userId, key }, "storeInboxDocument: db insert failed after successful put");
    return { ok: false, error: `db insert failed: ${error}` };
  }
}

/**
 * Delete an inbox document: removes the storage object first (best-effort — a missing
 * object never blocks the row delete), then the row. IDOR guard: caller must verify
 * document.userId === request.user.id before calling.
 */
export async function deleteInboxDocument(
  app: AppLike,
  opts: { documentId: string; storageKey: string },
): Promise<void> {
  await _deleteObjectBestEffort(app, opts.storageKey, opts.documentId);
  await db(app).delete(documents).where(eq(documents.id, opts.documentId));
}

/**
 * List a user's inbox documents (category != "receipt"), optionally filtered to one
 * category and/or one portfolio (e.g. the app-wide portfolio-switcher selection). Ordered
 * newest first.
 */
export async function listInboxDocuments(
  app: AppLikeDb,
  opts: { userId: string; category?: DocumentCategory; portfolioId?: string },
): Promise<InboxDocumentMeta[]> {
  const { userId, category, portfolioId } = opts;
  const conditions = [
    eq(documents.userId, userId),
    eq(documents.category, category ?? "tax_report"),
  ];
  if (portfolioId) conditions.push(eq(documents.portfolioId, portfolioId));
  const rows = await db(app)
    .select()
    .from(documents)
    .where(and(...conditions));
  return (rows as InboxDocumentMeta[]).sort(
    (a, b) => b.storedAt.getTime() - a.storedAt.getTime(),
  );
}

/** Fetch a single inbox document by id. IDOR guard is the caller's responsibility. */
export async function getInboxDocument(
  app: AppLikeDb,
  documentId: string,
): Promise<InboxDocumentMeta | null> {
  const [row] = await db(app).select().from(documents).where(eq(documents.id, documentId)).limit(1);
  return (row as InboxDocumentMeta) ?? null;
}

// ---- Internal helpers -------------------------------------------------------

async function _findBySourceEvent(
  app: AppLikeDb,
  userId: string,
  sourceEventId: string,
): Promise<string | null> {
  const [row] = await db(app)
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.sourceEventId, sourceEventId)))
    .limit(1);
  return row?.id ?? null;
}

async function _deleteObjectBestEffort(
  app: Pick<FastifyInstance, "storage" | "log">,
  key: string,
  context: string,
): Promise<void> {
  try {
    await app.storage.delete(key);
  } catch (err) {
    app.log.warn({ err, key, context }, "storage.delete failed (non-fatal)");
  }
}
