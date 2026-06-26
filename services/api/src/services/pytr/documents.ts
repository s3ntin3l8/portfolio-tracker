import type { FastifyBaseLogger } from "fastify";
import type { ParsedTransaction } from "@portfolio/schema";
import type { PytrRunner, DownloadDocumentsResult } from "./runner.js";
import type { DB } from "../../db/client.js";
import type { StorageProvider } from "../../storage/types.js";
import { storeReceipt } from "../../storage/receipts.js";

/** Outcome of a postbox-document download attempt. All fields are absent when no download
 *  was applicable (no storage / no importId / retention off / no documentRefs). */
export interface DocumentDownloadResult {
  requested?: number;
  stored?: number;
  /** Set when the whole download failed (e.g. session expired). */
  error?: string;
}

/**
 * Download postbox document bytes for newly-staged drafts and store them (best-effort).
 *
 * Only does work when:
 *   • storage is injected (skipped in tests / callers without storage),
 *   • there is an open collector with an importId,
 *   • the portfolio has documentRetention=true (never download bytes to discard them),
 *   • at least one new draft has a documentRefs entry.
 *
 * Future-only by design: incremental sync skips already-ledger'd events, so events confirmed
 * before retention was enabled won't get their PDFs retroactively (no backfill).
 *
 * Never throws — a download/storage failure is surfaced via the returned `error`/counts and
 * must not abort the sync.
 */
export async function downloadNewDraftDocuments(opts: {
  db: DB;
  runner: PytrRunner;
  storage?: StorageProvider;
  connection: { id: string; userId: string };
  importId?: string;
  newDrafts: ParsedTransaction[];
  retention: boolean;
  session: { phone: string; pin: string; sessionData: string };
  log?: FastifyBaseLogger;
}): Promise<DocumentDownloadResult> {
  const { db, runner, storage, connection, importId, newDrafts, retention, session, log } = opts;
  if (!storage || !importId || newDrafts.length === 0 || !retention) return {};

  // Collect (eventId, docId) pairs from new drafts' documentRefs.
  const pairs: { eventId: string; docId: string }[] = [];
  for (const draft of newDrafts) {
    if (!draft.externalId || !draft.documentRefs) continue;
    for (const ref of draft.documentRefs) {
      if (ref?.id) pairs.push({ eventId: draft.externalId, docId: ref.id });
    }
  }
  if (pairs.length === 0) return {};

  const connectionId = connection.id;
  const appLike = { storage, db, log: log ?? console } as Parameters<typeof storeReceipt>[0];
  let stored = 0;
  let failed = 0;
  let error: string | undefined;

  try {
    const downloaded: DownloadDocumentsResult = await runner.downloadDocuments(
      { phone: session.phone, pin: session.pin, sessionData: session.sessionData },
      pairs,
    );
    // Count per-doc download failures from Python (surfaced in result.failures).
    failed += downloaded.failures.length;
    for (const [docId, { buf, mimeType }] of downloaded.docs) {
      // sourceEventId links this doc to its transaction at confirm time
      // (via tx.externalId ↔ document.sourceEventId matching). storeReceipt is
      // contractually non-throwing — it returns { ok: false } on storage/DB errors —
      // so a single bad doc never aborts the batch nor reaches the outer catch.
      const sourceEventId = pairs.find((p) => p.docId === docId)?.eventId ?? null;
      const receipt = await storeReceipt(appLike, {
        userId: connection.userId,
        importId,
        buf,
        mimeType,
        originalFilename: `${docId}.pdf`,
        source: "pytr",
        sourceEventId,
      });
      if (receipt.ok) {
        stored++;
      } else {
        failed++;
      }
    }
  } catch (err) {
    // Process-level failure (PytrAuthError / PytrError) from downloadDocuments — best-
    // effort, must never abort the sync. Reached before any doc is stored, so count
    // every requested pair as failed (add rather than overwrite, defensively).
    failed += pairs.length - stored - failed;
    error = err instanceof Error ? err.message : "document download failed";
    log?.warn({ connectionId, importId, err }, "tr document download failed (non-fatal)");
  }

  // Always emit so partial failures are visible in logs even when stored=0.
  log?.info(
    { connectionId, importId, requested: pairs.length, stored, failed },
    "tr postbox documents staged",
  );

  return { requested: pairs.length, stored, ...(error ? { error } : {}) };
}
