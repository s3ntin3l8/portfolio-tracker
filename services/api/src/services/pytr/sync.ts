import { and, desc, eq, inArray } from "drizzle-orm";
import { Decimal } from "decimal.js";
import type { FastifyBaseLogger } from "fastify";
import {
  portfolios,
  screenshotImports,
  transactions,
  trConnections,
  trResolvedEvents,
} from "@portfolio/db";
import type { ImportIssue, ParsedTransaction } from "@portfolio/schema";
import { cashBalances, type CoreTransaction } from "@portfolio/core";
import { mapTrEvents, categoryForEventType } from "./mapper.js";
import { PytrAuthError } from "./runner.js";
import type { PytrRunner, TrExportSummary } from "./runner.js";
import type { DB } from "../../db/client.js";
import type { EncryptionService } from "../encryption.js";
import type { StorageProvider } from "../../storage/types.js";
import { deleteReceiptsForTransactions, storeReceipt } from "../../storage/receipts.js";

type TrConnectionRow = typeof trConnections.$inferSelect;

export interface CashReconciliation {
  checkedAt: string;
  cash: { currency: string; reported: string; derived: string; diff: string }[];
}

export interface SyncResult {
  status: "connected" | "expired" | "error";
  importId?: string;
  drafts?: number;
  errors?: number;
  /** Confirmed transactions removed because their source event was cancelled. */
  cancelled?: number;
  /** TR's reported cash vs our derived cash, per currency (when TR reported a balance). */
  reconciliation?: CashReconciliation;
}

// The parsed_json shape of a pytr "collector" draft: the single open draft per connection
// that accumulates only new, not-yet-confirmed items across syncs. `seenEventIds` tracks
// every event already processed (mapped OR skipped) so nothing is re-evaluated.
interface CollectorJson {
  drafts: ParsedTransaction[];
  errors: ImportIssue[];
  // `seenEventIds` (legacy) is no longer written — "already handled" now lives durably in
  // tr_resolved_events; staged-not-resolved items are derived from the draft's own contents.
  seenEventIds?: string[];
}

// A cancelled event keeps its id but flips status — these are removed, not re-imported.
function isCancelled(status: unknown): boolean {
  const s = typeof status === "string" ? status.toUpperCase() : "";
  return s === "CANCELED" || s === "CANCELLED";
}

// Default staged categories: everything except day-to-day card spending.
const DEFAULT_CATEGORIES = ["trade", "income", "cashflow"];

// Compare TR's reported cash balance against the cash we derive from the full event
// timeline. By deriving from the mapped events (not from confirmed transactions), this
// answers "did our mapper account for every cash movement TR knows about?" regardless of
// how many events have been confirmed by the user. Card spending is included even when
// that category is disabled for staging (its CARD_TRANSACTION events map to `withdrawal`).
// A near-zero diff means all events are mapped; a non-zero diff typically indicates
// events with unknown types or amounts the mapper can't yet handle. Returns undefined
// when TR didn't report a balance.
function reconcileCash(
  allEvents: unknown[],
  summary: TrExportSummary | undefined,
): CashReconciliation | undefined {
  const reported = summary?.cash;
  if (!reported || reported.length === 0) return undefined;

  // Map the full timeline (all categories, all event states — the mapper itself skips
  // non-EXECUTED events). Convert the resulting drafts to CoreTransaction for cashBalances.
  const { drafts } = mapTrEvents(allEvents);
  const coreTxns: CoreTransaction[] = drafts.map((d) => ({
    instrumentId: null, // cashBalances only uses type/qty/price/fees/currency
    type: d.action as CoreTransaction["type"],
    quantity: d.quantity,
    price: d.price,
    fees: d.fees,
    currency: d.currency,
    executedAt: d.executedAt,
  }));

  const derived = cashBalances(coreTxns);
  const currencies = new Set([...reported.map((c) => c.currency), ...Object.keys(derived)]);
  const cash = [...currencies].map((currency) => {
    const reportedStr = String(reported.find((c) => c.currency === currency)?.amount ?? "0");
    const derivedStr = derived[currency] ?? "0";
    return {
      currency,
      reported: reportedStr,
      derived: derivedStr,
      // Use Decimal arithmetic (not JS float) to avoid floating-point drift.
      diff: new Decimal(reportedStr).sub(new Decimal(derivedStr)).toFixed(2),
    };
  });
  return { checkedAt: new Date().toISOString(), cash };
}

/**
 * Sync one Trade Republic connection: resume the saved session, export the full timeline,
 * and **reconcile** it against what's already confirmed/staged rather than blindly inserting.
 *
 * The export is always the full timeline (idempotent — every event carries a stable id), so:
 *   - cancelled events that were previously confirmed have their transactions removed;
 *   - a single open "collector" draft accumulates only NEW, not-yet-confirmed items across
 *     syncs (no duplicate drafts, no re-offering already-confirmed events every hour);
 *   - the rolling cookie session is re-saved to extend its life; a session that can't be
 *     resumed flips the connection to `expired`.
 *
 * Pure of HTTP/pg-boss: callable from both the manual endpoint and the cron worker, and
 * unit-testable with a mock runner (no Python, no network).
 */
export async function syncTrConnection(
  db: DB,
  encryption: EncryptionService,
  runner: PytrRunner,
  connection: TrConnectionRow,
  log?: FastifyBaseLogger,
  /** Optional storage provider for document cleanup on cancellation (#231). */
  storage?: StorageProvider,
): Promise<SyncResult> {
  if (!connection.sessionEnc || !connection.portfolioId) {
    log?.warn({ connectionId: connection.id }, "tr sync skipped: missing session/portfolio");
    return { status: "error" };
  }

  const phone = encryption.decryptString(connection.phoneEnc);
  const pin = encryption.decryptString(connection.pinEnc);
  const sessionData = encryption.decryptString(connection.sessionEnc);
  const portfolioId = connection.portfolioId;

  const connectionId = connection.id;
  let result: Awaited<ReturnType<PytrRunner["export"]>>;
  try {
    log?.debug({ connectionId }, "tr export starting");
    result = await runner.export({ phone, pin, sessionData });
  } catch (err) {
    const status = err instanceof PytrAuthError ? "expired" : "error";
    const lastError = err instanceof Error ? err.message : "sync failed";
    log?.warn({ connectionId, status, lastError }, "tr connection flipped");
    await db
      .update(trConnections)
      .set({
        status,
        lastError,
        updatedAt: new Date(),
      })
      .where(eq(trConnections.id, connection.id));
    return { status };
  }

  const events = result.events;

  // Light id/status pass over the raw events for reconciliation (the mapper validates the
  // rest). Every real event has an id; cancelled events keep theirs but flip status.
  const meta = events
    .map((e) => {
      const o = e as Record<string, unknown>;
      return {
        id: typeof o.id === "string" ? o.id : "",
        status: o.status,
        eventType: typeof o.eventType === "string" ? o.eventType : "",
      };
    })
    .filter((m) => m.id);
  const exportIds = new Set(meta.map((m) => m.id));
  const cancelledIds = new Set(meta.filter((m) => isCancelled(m.status)).map((m) => m.id));
  const eventTypeById = new Map(meta.map((m) => [m.id, m.eventType]));

  // Per-connection category filter: only stage events whose category is enabled. Excluded
  // events are NOT marked seen, so enabling the category later stages them on the next sync.
  const enabled = new Set(connection.importCategories ?? DEFAULT_CATEGORIES);
  const allowed = (id: string) =>
    enabled.has(categoryForEventType(eventTypeById.get(id) ?? ""));

  // 1. Un-import any confirmed transactions whose source event is now cancelled, and forget
  //    them in the ledger so a later re-execution can re-stage.
  let cancelled = 0;
  if (cancelledIds.size) {
    const removed = await db
      .delete(transactions)
      .where(
        and(
          eq(transactions.portfolioId, portfolioId),
          eq(transactions.source, "pytr"),
          inArray(transactions.externalId, [...cancelledIds]),
        ),
      )
      .returning({ id: transactions.id, importId: transactions.importId });
    cancelled = removed.length;
    // Clean up any linked documents (#231). Best-effort — no-op in phase 1 since
    // TR per-tx docs aren't stored yet; forward-compatible for phase 2.
    if (storage && removed.length > 0) {
      const storageApp = { storage, db, log: log ?? console } as Parameters<typeof deleteReceiptsForTransactions>[0];
      await deleteReceiptsForTransactions(
        storageApp,
        removed.map((r) => r.id),
        removed.map((r) => r.importId).filter((x): x is string => x !== null),
      );
    }
    await db
      .delete(trResolvedEvents)
      .where(
        and(
          eq(trResolvedEvents.portfolioId, portfolioId),
          inArray(trResolvedEvents.eventId, [...cancelledIds]),
        ),
      );
    if (cancelled > 0) {
      log?.info({ connectionId, cancelled }, "tr cancelled events removed");
    }
  }

  // 2. The durable "resolved" ledger — the authoritative record of events already confirmed
  //    or discarded, immune to manual transaction deletion. Seed it once from any pre-existing
  //    confirmed pytr transactions (rows imported before the ledger existed), so deletions are
  //    durable from the first sync after deploy without a re-stage regression.
  const confirmedRows = await db
    .select({ ext: transactions.externalId })
    .from(transactions)
    .where(and(eq(transactions.portfolioId, portfolioId), eq(transactions.source, "pytr")));
  const confirmedIds = confirmedRows
    .map((r) => r.ext)
    .filter((x): x is string => Boolean(x));
  if (confirmedIds.length) {
    await db
      .insert(trResolvedEvents)
      .values(confirmedIds.map((eventId) => ({ portfolioId, eventId, resolution: "confirmed" })))
      .onConflictDoNothing();
  }
  const resolvedRows = await db
    .select({ eventId: trResolvedEvents.eventId })
    .from(trResolvedEvents)
    .where(eq(trResolvedEvents.portfolioId, portfolioId));
  const resolved = new Set(resolvedRows.map((r) => r.eventId));

  // 3. The open collector draft (at most one). Its current contents are "staged" — shown but
  //    not yet resolved, so don't duplicate them on this sync.
  const [collector] = await db
    .select()
    .from(screenshotImports)
    .where(
      and(
        eq(screenshotImports.userId, connection.userId),
        eq(screenshotImports.portfolioId, portfolioId),
        eq(screenshotImports.parser, "pytr"),
        eq(screenshotImports.status, "draft"),
      ),
    )
    .orderBy(desc(screenshotImports.createdAt))
    .limit(1);
  const existing = collector ? (collector.parsedJson as CollectorJson) : null;
  // Only staged *drafts* block re-import. Staged *errors* (attention issues, e.g. a trade
  // whose detail fetch transiently failed so its share count is missing) are intentionally
  // left re-mappable: re-deriving them from a fresh export self-heals once the detail
  // succeeds. Safe because no user intent lives on an error object — mapping one turns it
  // into a confirmed transaction + a resolved-ledger entry, which is filtered out above.
  const stagedIds = new Set<string>(
    (existing?.drafts ?? []).map((d) => d.externalId).filter((x): x is string => Boolean(x)),
  );

  // 4. New events = present, executed, in an enabled category, neither resolved nor staged.
  const newRaw = events.filter((e) => {
    const o = e as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : "";
    if (!id || resolved.has(id) || stagedIds.has(id) || !allowed(id)) return false;
    if (typeof o.status === "string" && o.status.toUpperCase() !== "EXECUTED") return false;
    return true;
  });
  const { drafts: newDrafts, errors: newErrors } = mapTrEvents(newRaw);
  log?.debug(
    { connectionId, exported: events.length, new: newRaw.length, drafts: newDrafts.length, errors: newErrors.length },
    "tr events mapped",
  );

  // 5. Keep staged items still pending (not resolved/cancelled/vanished/excluded), then append.
  const keptDrafts = (existing?.drafts ?? []).filter(
    (d) =>
      d.externalId &&
      !resolved.has(d.externalId) &&
      !cancelledIds.has(d.externalId) &&
      exportIds.has(d.externalId) &&
      allowed(d.externalId),
  );
  // Errors are NOT carried verbatim: any whose event is still in the export was just
  // re-derived above (into a fresh draft if its detail recovered, else a fresh error), so
  // drop the stale copy to avoid duplication. Keep only errors with no id, or whose event
  // has vanished from the export (and isn't resolved/cancelled).
  const keptErrors = (existing?.errors ?? []).filter(
    (e) =>
      !e.eventId ||
      (!resolved.has(e.eventId) && !cancelledIds.has(e.eventId) && !exportIds.has(e.eventId)),
  );
  const mergedDrafts = [...keptDrafts, ...newDrafts];
  const mergedErrors = [...keptErrors, ...newErrors];
  const parsedJson: CollectorJson = { drafts: mergedDrafts, errors: mergedErrors };

  // 6. Persist: update / create / close the collector.
  let importId: string | undefined = collector?.id;
  const hasContent = mergedDrafts.length > 0 || mergedErrors.length > 0;
  let collectorAction: "updated" | "created" | "discarded" | "unchanged" = "unchanged";
  if (collector) {
    if (!hasContent) {
      await db
        .update(screenshotImports)
        .set({ status: "discarded" })
        .where(eq(screenshotImports.id, collector.id));
      importId = undefined;
      collectorAction = "discarded";
    } else {
      await db
        .update(screenshotImports)
        .set({ parsedJson })
        .where(eq(screenshotImports.id, collector.id));
      collectorAction = "updated";
    }
  } else if (hasContent) {
    const [imp] = await db
      .insert(screenshotImports)
      .values({ userId: connection.userId, portfolioId, parser: "pytr", parsedJson, status: "draft" })
      .returning();
    importId = imp.id;
    collectorAction = "created";
  }
  log?.info(
    { connectionId, importId, action: collectorAction, drafts: mergedDrafts.length, errors: mergedErrors.length },
    "tr collector updated",
  );

  // 6b. Download postbox document bytes for newly-staged drafts (best-effort).
  //
  // Only fires when:
  //   • storage is injected (skipped in tests / callers without storage),
  //   • there is an open collector with an importId,
  //   • the portfolio has documentRetention=true (never download bytes to discard them),
  //   • at least one new draft has a documentRefs entry.
  //
  // Future-only by design: incremental sync skips already-ledger'd events, so events
  // confirmed before retention was enabled won't get their PDFs retroactively. This is
  // intentional (no backfill), since we are pre-release with no live users.
  if (storage && importId && newDrafts.length > 0) {
    const [portfolio] = await db
      .select({ documentRetention: portfolios.documentRetention })
      .from(portfolios)
      .where(eq(portfolios.id, portfolioId))
      .limit(1);

    if (portfolio?.documentRetention) {
      // Collect (eventId, docId) pairs from new drafts' documentRefs.
      const pairs: { eventId: string; docId: string }[] = [];
      for (const draft of newDrafts) {
        if (!draft.externalId || !draft.documentRefs) continue;
        for (const ref of draft.documentRefs) {
          if (ref?.id) pairs.push({ eventId: draft.externalId, docId: ref.id });
        }
      }

      if (pairs.length > 0) {
        const appLike = { storage, db, log: log ?? console } as Parameters<typeof storeReceipt>[0];
        const userId = connection.userId;

        try {
          const downloaded = await runner.downloadDocuments(
            { phone, pin, sessionData: result.sessionData },
            pairs,
          );
          for (const [docId, { buf, mimeType }] of downloaded) {
            // sourceEventId links this doc to its transaction at confirm time
            // (via tx.externalId ↔ document.sourceEventId matching).
            const sourceEventId = pairs.find((p) => p.docId === docId)?.eventId ?? null;
            await storeReceipt(appLike, {
              userId,
              importId,
              buf,
              mimeType,
              originalFilename: `${docId}.pdf`,
              source: "pytr",
              sourceEventId,
            });
          }
          log?.info(
            { connectionId, importId, requested: pairs.length, stored: downloaded.size },
            "tr postbox documents staged",
          );
        } catch (err) {
          // Best-effort: a document-fetch failure must never abort the sync.
          log?.warn({ connectionId, importId, err }, "tr document download failed (non-fatal)");
        }
      }
    }
  }

  // 7. Reconcile cash against TR's reported balance, then roll the session forward.
  const reconciliation = reconcileCash(events, result.summary);
  await db
    .update(trConnections)
    .set({
      sessionEnc: encryption.encryptString(result.sessionData),
      status: "connected",
      lastSyncAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
      ...(reconciliation ? { lastReconciliation: reconciliation } : {}),
    })
    .where(eq(trConnections.id, connection.id));

  log?.info({ connectionId, reconciled: !!reconciliation }, "tr connection synced");

  return {
    status: "connected",
    importId,
    drafts: newDrafts.length,
    errors: newErrors.length,
    cancelled,
    reconciliation,
  };
}
