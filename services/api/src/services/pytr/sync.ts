import { and, desc, eq, inArray } from "drizzle-orm";
import { screenshotImports, transactions, trConnections } from "@portfolio/db";
import type { ImportIssue, ParsedTransaction } from "@portfolio/schema";
import { mapTrEvents, categoryForEventType } from "./mapper.js";
import { PytrAuthError } from "./runner.js";
import type { PytrRunner } from "./runner.js";
import type { DB } from "../../db/client.js";
import type { EncryptionService } from "../encryption.js";

type TrConnectionRow = typeof trConnections.$inferSelect;

export interface SyncResult {
  status: "connected" | "expired" | "error";
  importId?: string;
  drafts?: number;
  errors?: number;
  /** Confirmed transactions removed because their source event was cancelled. */
  cancelled?: number;
}

// The parsed_json shape of a pytr "collector" draft: the single open draft per connection
// that accumulates only new, not-yet-confirmed items across syncs. `seenEventIds` tracks
// every event already processed (mapped OR skipped) so nothing is re-evaluated.
interface CollectorJson {
  drafts: ParsedTransaction[];
  errors: ImportIssue[];
  seenEventIds?: string[];
}

// A cancelled event keeps its id but flips status — these are removed, not re-imported.
function isCancelled(status: unknown): boolean {
  const s = typeof status === "string" ? status.toUpperCase() : "";
  return s === "CANCELED" || s === "CANCELLED";
}

// Default staged categories: everything except day-to-day card spending.
const DEFAULT_CATEGORIES = ["trade", "income", "cashflow"];

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
): Promise<SyncResult> {
  if (!connection.sessionEnc || !connection.portfolioId) return { status: "error" };

  const phone = encryption.decryptString(connection.phoneEnc);
  const pin = encryption.decryptString(connection.pinEnc);
  const sessionData = encryption.decryptString(connection.sessionEnc);
  const portfolioId = connection.portfolioId;

  let result: Awaited<ReturnType<PytrRunner["export"]>>;
  try {
    result = await runner.export({ phone, pin, sessionData });
  } catch (err) {
    const status = err instanceof PytrAuthError ? "expired" : "error";
    await db
      .update(trConnections)
      .set({
        status,
        lastError: err instanceof Error ? err.message : "sync failed",
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

  // 1. Un-import any already-confirmed transactions whose source event is now cancelled.
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
      .returning({ id: transactions.id });
    cancelled = removed.length;
  }

  // 2. What's already confirmed (after the cancellation sweep) — never re-stage these.
  const confirmedRows = await db
    .select({ ext: transactions.externalId })
    .from(transactions)
    .where(and(eq(transactions.portfolioId, portfolioId), eq(transactions.source, "pytr")));
  const confirmedIds = new Set(
    confirmedRows.map((r) => r.ext).filter((x): x is string => Boolean(x)),
  );

  // 3. The open collector draft for this connection (at most one going forward).
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
  const seen = new Set<string>(
    existing?.seenEventIds ??
      (existing?.drafts ?? []).map((d) => d.externalId).filter((x): x is string => Boolean(x)),
  );

  // 4. New events = present, executed, in an enabled category, not confirmed, not seen.
  const newRaw = events.filter((e) => {
    const o = e as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : "";
    if (!id || confirmedIds.has(id) || seen.has(id) || !allowed(id)) return false;
    if (typeof o.status === "string" && o.status.toUpperCase() !== "EXECUTED") return false;
    return true;
  });
  const { drafts: newDrafts, errors: newErrors } = mapTrEvents(newRaw);

  // 5. Reconcile the collector: keep staged drafts that are still pending + present + in an
  //    enabled category, drop ones now confirmed/cancelled/vanished/excluded, then append.
  const keptDrafts = (existing?.drafts ?? []).filter(
    (d) =>
      d.externalId &&
      !confirmedIds.has(d.externalId) &&
      !cancelledIds.has(d.externalId) &&
      exportIds.has(d.externalId) &&
      allowed(d.externalId),
  );
  const mergedDrafts = [...keptDrafts, ...newDrafts];
  const mergedErrors = [...(existing?.errors ?? []), ...newErrors];

  const nextSeen = new Set(seen);
  for (const m of meta) {
    if (confirmedIds.has(m.id) && !cancelledIds.has(m.id)) continue; // confirmed → tracked there
    if (!allowed(m.id)) continue; // category-excluded → stay re-evaluatable if enabled later
    nextSeen.add(m.id);
  }
  for (const id of cancelledIds) nextSeen.delete(id); // allow a re-executed event to re-stage
  const parsedJson: CollectorJson = {
    drafts: mergedDrafts,
    errors: mergedErrors,
    seenEventIds: [...nextSeen],
  };

  // 6. Persist: update / create / close the collector.
  let importId: string | undefined = collector?.id;
  const hasContent = mergedDrafts.length > 0 || mergedErrors.length > 0;
  if (collector) {
    if (!hasContent) {
      await db
        .update(screenshotImports)
        .set({ status: "discarded" })
        .where(eq(screenshotImports.id, collector.id));
      importId = undefined;
    } else {
      await db
        .update(screenshotImports)
        .set({ parsedJson })
        .where(eq(screenshotImports.id, collector.id));
    }
  } else if (hasContent) {
    const [imp] = await db
      .insert(screenshotImports)
      .values({ userId: connection.userId, portfolioId, parser: "pytr", parsedJson, status: "draft" })
      .returning();
    importId = imp.id;
  }

  // 7. Roll the session forward + mark the connection healthy.
  await db
    .update(trConnections)
    .set({
      sessionEnc: encryption.encryptString(result.sessionData),
      status: "connected",
      lastSyncAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(trConnections.id, connection.id));

  return {
    status: "connected",
    importId,
    drafts: newDrafts.length,
    errors: newErrors.length,
    cancelled,
  };
}
