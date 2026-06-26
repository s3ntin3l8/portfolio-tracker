import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import {
  portfolios,
  screenshotImports,
  transactions,
  trConnections,
  trResolvedEvents,
} from "@portfolio/db";
import type { ImportIssue, ParsedTransaction } from "@portfolio/schema";
import { mapTrEvents, mapTrEventToDraft, isCashMovementEvent } from "./mapper.js";
import { PytrAuthError } from "./runner.js";
import type { PytrRunner } from "./runner.js";
import {
  asReconciliation,
  logCashDrift,
  reconcileCash,
  reconcilePositions,
  type CashReconciliation,
} from "./reconcile.js";
import { applyCancellations, isCancelled } from "./cancellation.js";
import { downloadNewDraftDocuments } from "./documents.js";
import type { DB } from "../../db/client.js";
import type { EncryptionService } from "../encryption.js";
import type { StorageProvider } from "../../storage/types.js";

type TrConnectionRow = typeof trConnections.$inferSelect;

export type { CashReconciliation };

export interface SyncResult {
  status: "connected" | "expired" | "error";
  importId?: string;
  drafts?: number;
  errors?: number;
  /** Confirmed transactions removed because their source event was cancelled. */
  cancelled?: number;
  /** TR's reported cash vs our derived cash, per currency (when TR reported a balance). */
  reconciliation?: CashReconciliation;
  /** How many postbox PDFs were requested this sync (only set when documentRetention=true). */
  documentsRequested?: number;
  /** How many postbox PDFs were successfully stored this sync. */
  documentsStored?: number;
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

// Reads the app's OWN round-tripped JSONB column, so corruption is unlikely — but a malformed
// row (failed write, a future shape change, a manual DB edit) shouldn't throw mid-sync.
// Validate the shape just enough to use it safely and fall back otherwise, so the next sync
// self-heals: a dropped collector simply re-stages unresolved events from the durable ledger.
function asCollectorJson(v: unknown, log?: FastifyBaseLogger): CollectorJson | null {
  const o = v as Record<string, unknown> | null;
  if (o && Array.isArray(o.drafts) && Array.isArray(o.errors)) return o as unknown as CollectorJson;
  if (v != null) log?.warn({ parsedJson: v }, "tr collector json malformed — ignoring (will re-stage)");
  return null;
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
 * This file is the orchestrator; the concern-specific steps live in siblings —
 * reconcile.ts (cash/positions), cancellation.ts (un-import), documents.ts (postbox PDFs).
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

  // The portfolio's cash boundary drives what we stage (cashCounted) and document retention.
  // Fetch both once up front and reuse below.
  const [portfolio] = await db
    .select({
      cashCounted: portfolios.cashCounted,
      documentRetention: portfolios.documentRetention,
    })
    .from(portfolios)
    .where(eq(portfolios.id, portfolioId))
    .limit(1);
  const cashCounted = portfolio?.cashCounted ?? false;

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
        syncing: false,
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

  // Boundary-driven staging filter (issue #326): a cash-inside (savings) portfolio imports
  // everything; a cash-outside (invest-only) portfolio excludes genuine cash movements
  // (deposits/withdrawals/card spending) so they don't manufacture phantom flows against a
  // value boundary that excludes cash. Unknown/unmapped event types are NOT excluded — they
  // flow through and surface as attention gaps (never silently dropped). Excluded events stay
  // NOT-seen, so flipping the portfolio to cash-inside re-stages them on the next sync.
  const allowed = (id: string) =>
    cashCounted ? true : !isCashMovementEvent(eventTypeById.get(id) ?? "");

  // 1. Un-import any confirmed transactions whose source event is now cancelled, and forget
  //    them in the ledger so a later re-execution can re-stage.
  const cancelled = await applyCancellations({
    db,
    portfolioId,
    cancelledIds,
    connectionId,
    storage,
    log,
  });

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
      .values(confirmedIds.map((eventId) => ({ portfolioId, source: "pytr", eventId, resolution: "confirmed" })))
      .onConflictDoNothing();
  }
  const resolvedRows = await db
    .select({ eventId: trResolvedEvents.eventId, resolution: trResolvedEvents.resolution })
    .from(trResolvedEvents)
    .where(and(eq(trResolvedEvents.portfolioId, portfolioId), eq(trResolvedEvents.source, "pytr")));
  const resolved = new Set(resolvedRows.map((r) => r.eventId));

  // 2b. Self-heal discarded events that the mapper can now handle. When an import is
  //     confirmed, leftover "info" errors (auto-skipped events like CARD_VERIFICATION) are
  //     written to the ledger as "discarded" so they don't reappear every sync. If the mapper
  //     is later fixed to recognise one of those event types (e.g. INTEREST_PAYOUT_CREATED
  //     moved from SKIP_EVENTS to FIXED_ACTIONS), the event is stuck. Fix: on each sync,
  //     re-run the mapper against every discarded event still present in the export; if it
  //     would now produce a draft, evict it from the ledger so this sync can re-stage it.
  //     "confirmed" events are never re-evaluated — only "discarded" ones.
  const discardedIds = new Set(
    resolvedRows.filter((r) => r.resolution === "discarded").map((r) => r.eventId),
  );
  if (discardedIds.size > 0) {
    const rawById = new Map(
      events
        .map((e) => {
          const o = e as Record<string, unknown>;
          return typeof o.id === "string" ? ([o.id, e] as [string, unknown]) : null;
        })
        .filter((x): x is [string, unknown] => x !== null),
    );
    const healable = [...discardedIds].filter((id) => {
      const raw = rawById.get(id);
      if (!raw || cancelledIds.has(id)) return false;
      return "draft" in mapTrEventToDraft(raw);
    });
    if (healable.length > 0) {
      await db
        .delete(trResolvedEvents)
        .where(
          and(
            eq(trResolvedEvents.portfolioId, portfolioId),
            eq(trResolvedEvents.source, "pytr"),
            inArray(trResolvedEvents.eventId, healable),
          ),
        );
      for (const id of healable) resolved.delete(id);
      log?.info({ connectionId, healed: healable.length }, "tr discarded events re-staged (mapper updated)");
    }
  }

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
  const existing = collector ? asCollectorJson(collector.parsedJson, log) : null;
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

  // 6b. Download postbox document bytes for newly-staged drafts (best-effort, never fatal).
  const docResult = await downloadNewDraftDocuments({
    db,
    runner,
    storage,
    connection,
    importId,
    newDrafts,
    retention: Boolean(portfolio?.documentRetention),
    session: { phone, pin, sessionData: result.sessionData },
    log,
  });
  const { requested: documentsRequested, stored: documentsStored, error: documentsError } = docResult;

  // 7. Reconcile cash + positions against TR's reported balances, then roll the session.
  // Pass the previous reconciliation (loaded with the connection, before this sync overwrites
  // it) so reconcileCash can report how much the diff moved — the incremental drift guard.
  const prevReconciliation = asReconciliation(connection.lastReconciliation, log);
  const cashRec = reconcileCash(events, result.summary, prevReconciliation);
  const posRec = reconcilePositions(events, result.summary);
  logCashDrift(cashRec, connectionId, log);
  // Build the reconciliation object; fold in document counts when we attempted a download
  // so the UI can show "0 of 20 PDFs saved" without needing a separate column/migration.
  const docsSummary =
    documentsRequested !== undefined
      ? {
          documents: {
            requested: documentsRequested,
            stored: documentsStored ?? 0,
            checkedAt: new Date().toISOString(),
            ...(documentsError ? { error: documentsError } : {}),
          },
        }
      : {};
  const reconciliation: CashReconciliation | undefined =
    cashRec || posRec || documentsRequested !== undefined
      ? {
          ...(cashRec ?? { checkedAt: new Date().toISOString(), cash: [] }),
          ...(posRec ? { positions: posRec } : {}),
          ...docsSummary,
        }
      : undefined;
  await db
    .update(trConnections)
    .set({
      sessionEnc: encryption.encryptString(result.sessionData),
      status: "connected",
      lastSyncAt: new Date(),
      lastError: null,
      syncing: false,
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
    ...(documentsRequested !== undefined ? { documentsRequested, documentsStored } : {}),
  };
}
