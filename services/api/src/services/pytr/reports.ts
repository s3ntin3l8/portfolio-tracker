import type { FastifyBaseLogger } from "fastify";
import type { PytrRunner } from "./runner.js";
import type { DB } from "../../db/client.js";
import type { StorageProvider } from "../../storage/types.js";
import { storeInboxDocument } from "../../storage/inbox.js";
import type { ReportDocumentRef } from "./mapper.js";

/** Outcome of an account-level report-document fetch attempt. Fields are absent when no
 *  fetch was applicable (no storage / no report refs this sync). */
export interface ReportDocumentFetchResult {
  requested?: number;
  stored?: number;
  /** Set when the whole fetch failed (e.g. session expired). */
  error?: string;
}

/**
 * Download TR account-level report documents (currently: the annual tax report) and store
 * them in the user's tax-reports inbox (see storage/inbox.ts).
 *
 * Deliberately independent of `importId`/`portfolio.documentRetention`: unlike settlement
 * receipts (downloadNewDraftDocuments), an inbox document isn't a per-transaction receipt
 * subject to the retention toggle — it's always fetched when present, and storeInboxDocument's
 * own (userId, sourceEventId) idempotency makes a daily re-fetch of the same report a no-op.
 *
 * Best-effort: never throws — a failure here must not abort the sync. Reuses the existing
 * tr_documents.py downloader unchanged (it already handles any (eventId, docId) pair);
 * `reportRefs` comes from mapper.ts's extractReportDocuments(), run over the same raw event
 * batch mapTrEvents() sees.
 */
export async function fetchReportDocuments(opts: {
  db: DB;
  runner: PytrRunner;
  storage?: StorageProvider;
  connection: { id: string; userId: string };
  /** Guaranteed non-null: syncTrConnection (sync.ts) never calls this without a connection
   *  that has a resolved portfolioId (early-returns otherwise). */
  portfolioId: string;
  reportRefs: ReportDocumentRef[];
  session: { phone: string; pin: string; sessionData: string };
  log?: FastifyBaseLogger;
}): Promise<ReportDocumentFetchResult> {
  const { db, runner, storage, connection, portfolioId, reportRefs, session, log } = opts;
  if (!storage || reportRefs.length === 0) return {};

  const pairs = reportRefs.map((r) => ({ eventId: r.eventId, docId: r.docId }));
  const appLike = { storage, db, log: log ?? console } as Parameters<typeof storeInboxDocument>[0];
  const connectionId = connection.id;
  let stored = 0;
  let failed = 0;
  let error: string | undefined;

  try {
    const downloaded = await runner.downloadDocuments(
      { phone: session.phone, pin: session.pin, sessionData: session.sessionData },
      pairs,
    );
    failed += downloaded.failures.length;
    for (const [docId, { buf, mimeType }] of downloaded.docs) {
      const ref = reportRefs.find((r) => r.docId === docId);
      const result = await storeInboxDocument(appLike, {
        userId: connection.userId,
        portfolioId,
        category: "tax_report",
        taxYear: ref?.taxYear ?? null,
        buf,
        mimeType,
        originalFilename: `${docId}.pdf`,
        source: "pytr",
        sourceEventId: ref?.eventId ?? docId,
      });
      if (result.ok) {
        stored++;
      } else {
        failed++;
      }
    }
  } catch (err) {
    // Process-level failure (PytrAuthError / PytrError) — best-effort, must never abort
    // the sync. Reached before any doc is stored, so count every requested pair as failed.
    failed += pairs.length - stored - failed;
    error = err instanceof Error ? err.message : "report document download failed";
    log?.warn({ connectionId, err }, "tr report document download failed (non-fatal)");
  }

  log?.info(
    { connectionId, requested: pairs.length, stored, failed },
    "tr report documents fetched",
  );

  return { requested: pairs.length, stored, ...(error ? { error } : {}) };
}
