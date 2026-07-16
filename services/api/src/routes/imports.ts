import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  loans,
  screenshotImports,
  transactions,
  transactionSources,
  trResolvedEvents,
} from "@portfolio/db";
import { toDateKey } from "@portfolio/core";
import {
  parsedTransactionSchema,
  type ImportIssue,
  type ParsedTransaction,
} from "@portfolio/schema";
import { requireUser } from "../plugins/auth.js";
import { enrichTransactionFromDrafts } from "../services/enrichment.js";
import { classifyMatch, parserToTxSource } from "../services/parsers/dedup.js";
import { findCommittedDuplicates } from "../services/parsers/likely-duplicates.js";
import {
  finalizeReceipts,
  deleteReceiptsForImport,
  getDocumentForImport,
  getDocumentSummariesForImports,
  getOriginalFilenamesForImports,
  retainDocumentForTransaction,
} from "../storage/receipts.js";
import { gatherDocumentNaming, buildDocumentName } from "../storage/naming.js";
import { ownedPortfolio } from "./helpers.js";
import { reassignTransactions } from "../services/reassign.js";
import { enqueueRecompute } from "../services/scheduler.js";
import { registerConfirmImportRoute } from "./imports/confirm.js";
import { registerParseImportRoutes } from "./imports/parse.js";
import { logTiming } from "../lib/timing.js";
import { withDerivationCache, createStore } from "../lib/derivation-cache.js";

const importsCache = createStore<{ rows: unknown[]; importCount: number }>();
const importDetailCache = createStore<{
  id: string;
  portfolioId: string | null;
  parser: string | null;
  status: string | null;
  drafts: unknown[];
  contracts: unknown[];
  errors: { line: number; message: string }[];
}>();

// Batch hard-delete of discarded imports. Mirrors transactions' bulk-delete so the
// web "clear all" fires one request instead of N parallel DELETE /clear calls (which
// trip the global rate limiter — issue surfaced after a bulk import undo).
const bulkClearSchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
});

export async function importsRoute(app: FastifyInstance) {
  // Upload/parse routes — POST /imports/csv and POST /imports/screenshot, plus their
  // parser-dispatch + upload-time dedup machinery (./imports/parse.ts). Called directly
  // (not app.register) so the handlers share this encapsulation context.
  registerParseImportRoutes(app);

  async function ownedImport(userId: string, importId: string) {
    const [imp] = await app.db
      .select()
      .from(screenshotImports)
      .where(and(eq(screenshotImports.id, importId), eq(screenshotImports.userId, userId)))
      .limit(1);
    return imp ?? null;
  }

  type OwnedImport = NonNullable<Awaited<ReturnType<typeof ownedImport>>>;

  // Discard a draft (draft → discarded): for pytr/ibkr durably record the events as
  // discarded so the next sync doesn't resurface them, drop any staged documents, then
  // flip the status. Shared by POST /imports/:id/discard and the bulk path so both apply
  // identical side effects. Returns how many resolved-events rows were recorded.
  async function discardImportRow(imp: OwnedImport): Promise<number> {
    let resolvedEventsRecorded = 0;
    const isSyncParser = (imp.parser === "pytr" || imp.parser === "ibkr") && imp.portfolioId;
    if (isSyncParser) {
      const source = imp.parser as "pytr" | "ibkr";
      const parsed = (imp.parsedJson ?? {}) as {
        drafts?: { externalId?: string | null }[];
        errors?: { eventId?: string | null }[];
      };
      const ids = [
        ...(parsed.drafts ?? []).map((d) => d.externalId),
        ...(parsed.errors ?? []).map((e) => e.eventId),
      ].filter((x): x is string => Boolean(x));
      if (ids.length) {
        await app.db
          .insert(trResolvedEvents)
          .values(
            ids.map((eventId) => ({
              portfolioId: imp.portfolioId!,
              source,
              eventId,
              resolution: "discarded",
            })),
          )
          .onConflictDoNothing();
        resolvedEventsRecorded = ids.length;
      }
    }
    await deleteReceiptsForImport(app, imp.id);
    await app.db
      .update(screenshotImports)
      .set({ status: "discarded" })
      .where(eq(screenshotImports.id, imp.id));
    return resolvedEventsRecorded;
  }

  // Undo a confirmed import (confirmed → discarded): remove the transactions + loans it
  // wrote, drop its documents, flip the status, and enqueue a recompute for each affected
  // (portfolio, day) so derived snapshots/holdings don't go stale. Shared by DELETE
  // /imports/:id and the bulk path. Returns how many transactions were removed.
  async function undoImportRow(imp: OwnedImport): Promise<number> {
    const removed = await app.db
      .delete(transactions)
      .where(eq(transactions.importId, imp.id))
      .returning();
    await app.db.delete(loans).where(eq(loans.importId, imp.id));
    await deleteReceiptsForImport(app, imp.id);
    await app.db
      .update(screenshotImports)
      .set({ status: "discarded" })
      .where(eq(screenshotImports.id, imp.id));
    // Recompute each distinct (portfolio, day) the removed rows touched (mirrors the
    // single-transaction delete, which the per-import undo historically skipped).
    const days = new Set<string>();
    for (const t of removed) {
      days.add(`${t.portfolioId}|${toDateKey(t.executedAt)}`);
    }
    for (const key of days) {
      const [pid, day] = key.split("|");
      await enqueueRecompute(pid, day);
    }
    return removed.length;
  }

  // List the current user's imports (newest first) — id, status, parser, draft count,
  // and document summary if one has been retained (#231).
  app.get("/imports", { preHandler: app.authenticate }, async (request) => {
    const t0 = performance.now();
    const { id } = requireUser(request);
    const { rows, importCount } = await withDerivationCache(importsCache, id, async () => {
      const rows = await app.db
        .select({
          id: screenshotImports.id,
          portfolioId: screenshotImports.portfolioId,
          parser: screenshotImports.parser,
          status: screenshotImports.status,
          confidence: screenshotImports.confidence,
          parsedJson: screenshotImports.parsedJson,
          batchId: screenshotImports.batchId,
          createdAt: screenshotImports.createdAt,
        })
        .from(screenshotImports)
        .where(eq(screenshotImports.userId, id))
        .orderBy(desc(screenshotImports.createdAt));
      const confirmedIds = rows.filter((r) => r.status === "confirmed").map((r) => r.id);
      const allIds = rows.map((r) => r.id);
      const syncImportIds = rows
        .filter((r) => r.parser === "pytr" || r.parser === "ibkr")
        .map((r) => r.id);
      const [docByImport, filenameByImport, syncCountRows] = await Promise.all([
        getDocumentSummariesForImports(app, confirmedIds),
        getOriginalFilenamesForImports(app, allIds),
        syncImportIds.length
          ? app.db
              .select({ importId: transactions.importId, n: count() })
              .from(transactions)
              .where(inArray(transactions.importId, syncImportIds))
              .groupBy(transactions.importId)
          : [],
      ]);
      const syncCountByImport = new Map(
        (Array.isArray(syncCountRows) ? syncCountRows : []).map((r) => [r.importId, r.n]),
      );
      const result = rows.map((r) => {
        const parsed = (r.parsedJson ?? {}) as { drafts?: unknown[] };
        const document = r.status === "confirmed" ? (docByImport.get(r.id) ?? null) : null;
        const isSync = r.parser === "pytr" || r.parser === "ibkr";
        return {
          id: r.id,
          portfolioId: r.portfolioId,
          parser: r.parser,
          status: r.status,
          confidence: r.confidence,
          count: isSync
            ? (syncCountByImport.get(r.id) ?? 0)
            : Array.isArray(parsed.drafts)
              ? parsed.drafts.length
              : 0,
          batchId: r.batchId,
          createdAt: r.createdAt,
          document,
          originalFilename: filenameByImport.get(r.id) ?? null,
        };
      });
      return { rows: result, importCount: rows.length };
    });
    const durationMs = performance.now() - t0;
    logTiming(request, "GET /imports", durationMs, { importCount });
    return rows;
  });

  // Safety net: aggregate event types that reached the importer but have no mapping yet
  // (TR `unmapped_event_type` / `unparseable_event`), so a future gap is self-announcing on
  // the dashboard + admin panel instead of buried in a single import's errors JSON. Grouped
  // by event type (falling back to the message for the null-eventType / unparseable case),
  // scoped to the user's non-discarded imports, most-frequent first.
  app.get("/imports/unmapped-types", { preHandler: app.authenticate }, async (request) => {
    const { id } = requireUser(request);
    const rows = await app.db
      .select()
      .from(screenshotImports)
      .where(eq(screenshotImports.userId, id))
      .orderBy(desc(screenshotImports.createdAt));
    const byKey = new Map<
      string,
      {
        eventType: string | null;
        code: NonNullable<ImportIssue["code"]>;
        message: string;
        count: number;
        lastSeen: Date;
        sample: ImportIssue["raw"] | null;
      }
    >();
    for (const r of rows) {
      if (r.status === "discarded") continue;
      const parsed = (r.parsedJson ?? {}) as { errors?: ImportIssue[] };
      for (const e of parsed.errors ?? []) {
        if (e.code !== "unmapped_event_type" && e.code !== "unparseable_event") continue;
        const key = `${e.code}:${e.eventType ?? e.message}`;
        const existing = byKey.get(key);
        if (existing) {
          existing.count += 1;
          if (r.createdAt > existing.lastSeen) existing.lastSeen = r.createdAt;
        } else {
          byKey.set(key, {
            eventType: e.eventType ?? null,
            code: e.code,
            message: e.message,
            count: 1,
            lastSeen: r.createdAt,
            sample: e.raw ?? null,
          });
        }
      }
    }
    return Array.from(byKey.values()).sort((a, b) => b.count - a.count);
  });

  // Discard a draft import (draft → discarded). Confirmed imports are undone via DELETE.
  app.post<{ Params: { importId: string } }>(
    "/imports/:importId/discard",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const imp = await ownedImport(id, request.params.importId);
      if (!imp) return reply.code(404).send({ error: "import_not_found" });
      if (imp.status === "confirmed") {
        return reply.code(409).send({ error: "already_confirmed" });
      }
      const resolvedEventsRecorded = await discardImportRow(imp);
      request.log.info(
        { importId: imp.id, parser: imp.parser, resolvedEventsRecorded },
        "import discarded",
      );
      reply.code(204);
      return null;
    },
  );

  // Undo an import: remove any transactions it wrote, then mark it discarded.
  app.delete<{ Params: { importId: string } }>(
    "/imports/:importId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const imp = await ownedImport(id, request.params.importId);
      if (!imp) return reply.code(404).send({ error: "import_not_found" });
      const removed = await undoImportRow(imp);
      request.log.info({ importId: imp.id, removedTransactions: removed }, "import undone");
      return { removed };
    },
  );

  // Reassign every transaction this import wrote to another portfolio (fix a wrong-portfolio
  // import in one action). Delegates to the shared mover: dedup-index conflicts and
  // financed-gold legs are skipped and reported; source + target are recomputed.
  app.post<{ Params: { importId: string } }>(
    "/imports/:importId/reassign",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const imp = await ownedImport(id, request.params.importId);
      if (!imp) return reply.code(404).send({ error: "import_not_found" });
      const { targetPortfolioId } = z
        .object({ targetPortfolioId: z.string().uuid() })
        .parse(request.body);
      if (!(await ownedPortfolio(app, id, targetPortfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const res = await reassignTransactions(app.db, {
        importId: imp.id,
        toPortfolioId: targetPortfolioId,
      });
      for (const { portfolioId: pid, day } of res.recompute) await enqueueRecompute(pid, day);
      request.log.info(
        { importId: imp.id, ...res, recompute: res.recompute.length },
        "import reassigned",
      );
      return {
        moved: res.moved,
        skippedConflicts: res.skippedConflicts,
        skippedLoans: res.skippedLoans,
      };
    },
  );

  // Batch hard-delete of discarded imports — one request for the web "clear all" instead
  // of N parallel DELETE /clear calls. Scoped to the user and to discarded rows; ids that
  // aren't owned-and-discarded are silently skipped (same forgiving contract as the
  // transactions bulk-delete). Returns how many rows were actually removed.
  app.post<{ Body: { ids?: unknown } }>(
    "/imports/bulk-clear",
    { preHandler: app.authenticate },
    async (request) => {
      const { id } = requireUser(request);
      const { ids } = bulkClearSchema.parse(request.body);
      const cleared = await app.db
        .delete(screenshotImports)
        .where(
          and(
            eq(screenshotImports.userId, id),
            eq(screenshotImports.status, "discarded"),
            inArray(screenshotImports.id, ids),
          ),
        )
        .returning({ id: screenshotImports.id });
      request.log.info({ requested: ids.length, cleared: cleared.length }, "imports bulk-cleared");
      return { cleared: cleared.length };
    },
  );

  // Batch delete of a mixed selection — one request instead of N per-row discard/undo/clear
  // calls (each followed by a route refresh), which is what trips the rate limiter when
  // cleaning up a large upload batch. Dispatches per current status, reusing the exact
  // per-row side effects: draft → discard, confirmed → undo (remove its transactions/loans),
  // discarded → hard clear. Forgiving contract: ids not owned by the user are silently
  // skipped. Two-step semantics preserved — undo/discard leave the row as `discarded` (the
  // audit trail); a follow-up bulk-delete of those same ids then clears them.
  app.post<{ Body: { ids?: unknown } }>(
    "/imports/bulk-delete",
    { preHandler: app.authenticate },
    async (request) => {
      const { id } = requireUser(request);
      const { ids } = bulkClearSchema.parse(request.body);
      const owned = await app.db
        .select()
        .from(screenshotImports)
        .where(and(eq(screenshotImports.userId, id), inArray(screenshotImports.id, ids)));
      let discarded = 0;
      let undone = 0;
      let cleared = 0;
      let removedTransactions = 0;
      for (const imp of owned) {
        if (imp.status === "draft") {
          await discardImportRow(imp);
          discarded += 1;
        } else if (imp.status === "confirmed") {
          removedTransactions += await undoImportRow(imp);
          undone += 1;
        } else {
          // already discarded → hard clear the row
          await app.db.delete(screenshotImports).where(eq(screenshotImports.id, imp.id));
          cleared += 1;
        }
      }
      request.log.info(
        { requested: ids.length, discarded, undone, cleared, removedTransactions },
        "imports bulk-deleted",
      );
      return { discarded, undone, cleared, removedTransactions };
    },
  );

  // Hard-delete a discarded import row. Only works on discarded rows (which provably have
  // no child transactions/loans — both FK columns are onDelete:"set null"). Safe vs TR
  // sync: trResolvedEvents has no FK to screenshot_imports; events are written before the
  // row is discarded, so deleting the row doesn't resurface them.
  app.delete<{ Params: { importId: string } }>(
    "/imports/:importId/clear",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const imp = await ownedImport(id, request.params.importId);
      if (!imp) return reply.code(404).send({ error: "import_not_found" });
      if (imp.status !== "discarded") {
        return reply.code(409).send({ error: "not_discarded" });
      }
      await app.db.delete(screenshotImports).where(eq(screenshotImports.id, imp.id));
      request.log.info({ importId: imp.id }, "import cleared");
      reply.code(204);
      return null;
    },
  );

  // Fetch a single import with its parsed drafts (owner only) — powers reviewing an
  // already-staged draft (e.g. a Trade Republic sync) from the import history.
  app.get<{ Params: { importId: string } }>(
    "/imports/:importId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const { importId } = request.params;
      const result = await withDerivationCache(importDetailCache, importId, async () => {
        const imp = await ownedImport(id, importId);
        if (!imp) return null;
        const parsed = (imp.parsedJson ?? {}) as {
          drafts?: unknown[];
          contracts?: unknown[];
          errors?: { line: number; message: string }[];
        };
        return {
          id: imp.id,
          portfolioId: imp.portfolioId,
          parser: imp.parser,
          status: imp.status,
          drafts: Array.isArray(parsed.drafts) ? parsed.drafts : [],
          contracts: Array.isArray(parsed.contracts) ? parsed.contracts : [],
          errors: Array.isArray(parsed.errors) ? parsed.errors : [],
        };
      });
      if (!result) return reply.code(404).send({ error: "import_not_found" });
      const durationMs = performance.now() - t0;
      logTiming(request, "GET /imports/:importId", durationMs, { importId });
      return result;
    },
  );

  // Preview-check: run the economic duplicate analysis for a specific target portfolio
  // and return per-draft annotations (kind: "enrichment" | "duplicate", matchedTransactionId,
  // etc.). Does NOT persist anything — lets the review screen show badges immediately after
  // the user selects/changes the portfolio, before the user clicks Confirm.
  app.post<{ Params: { importId: string } }>(
    "/imports/:importId/duplicates",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const imp = await ownedImport(id, request.params.importId);
      if (!imp) return reply.code(404).send({ error: "import_not_found" });

      const { portfolioId } = z.object({ portfolioId: z.string().uuid() }).parse(request.body);
      if (!(await ownedPortfolio(app, id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }

      const parsed = (imp.parsedJson ?? {}) as { drafts?: ParsedTransaction[] };
      const drafts: ParsedTransaction[] = Array.isArray(parsed.drafts) ? parsed.drafts : [];
      if (drafts.length === 0) return { annotations: [] };

      const matches = await findCommittedDuplicates(app.db, portfolioId, drafts);

      // Classify against the import's *raw* parser tag — classifyMatch converts it to a tx
      // source internally, so passing an already-converted source here would double-convert
      // ("dkb-pdf" → "pdf" → "screenshot") and mis-badge PDF re-imports. A PDF upload carries
      // a document, so it counts as a file upload (enrichment-capable) just like a screenshot.
      const incomingParser = imp.parser ?? "csv";
      const incomingTxSource = parserToTxSource(incomingParser);
      const importIsFileUpload = incomingTxSource === "screenshot" || incomingTxSource === "pdf";
      const isoDay = (v: Date | string) =>
        (v instanceof Date ? v.toISOString() : new Date(v).toISOString()).slice(0, 10);

      const annotations = matches.map(({ draftIndex, matched }) => {
        const d = drafts[draftIndex];
        const hasTaxComponents = d.taxComponents && Object.keys(d.taxComponents).length > 0;
        const draftHasEnrichment = importIsFileUpload || !!hasTaxComponents;
        const kind = classifyMatch(incomingParser, matched.source ?? "csv", draftHasEnrichment);
        return {
          draftIndex,
          kind,
          matchedTransactionId: matched.id,
          matchedSource: matched.source,
          matchedExecutedAt: isoDay(matched.executedAt),
          name: d.name ?? d.isin ?? d.ticker ?? null,
          action: d.action,
          quantity: d.quantity,
          executedAt: isoDay(d.executedAt),
        };
      });

      return { annotations };
    },
  );

  // Confirm an import: write the (possibly edited) drafts as transactions (./imports/confirm.ts).
  registerConfirmImportRoute(app);

  // Enrich existing confirmed transactions with richer detail from an import's drafts.
  // Used when a draft matches a committed transaction (409 duplicate_transactions) and
  // the user chooses "Enrich existing" instead of "Import anyway" or "Skip".
  // Each {draftIndex, targetTransactionId} pair folds the draft onto the target tx.
  // POST /imports/:importId/enrich
  //
  // Body carries the FULL draft payload + targetTransactionId — NOT a draftIndex.
  //
  // Why: the 409 confirm response's draftIndex indexes the submitted confirm-subset
  // (`resolved`, which excludes likelyDuplicate rows), but storedDrafts =
  // imp.parsedJson.drafts is the full set — different arrays. A passed-through draftIndex
  // would fold the WRONG draft.  Sending the draft payload the frontend already holds
  // removes the ambiguity entirely.
  const enrichBodySchema = z.object({
    portfolioId: z.string().uuid().optional(),
    enrichments: z
      .array(
        z.object({
          draft: parsedTransactionSchema,
          targetTransactionId: z.string().uuid(),
        }),
      )
      .min(1),
  });

  app.post<{ Params: { importId: string } }>(
    "/imports/:importId/enrich",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const imp = await ownedImport(id, request.params.importId);
      if (!imp) return reply.code(404).send({ error: "import_not_found" });

      const { portfolioId: bodyPortfolioId, enrichments } = enrichBodySchema.parse(request.body);
      const targetPortfolioId = bodyPortfolioId ?? imp.portfolioId;
      if (!targetPortfolioId) {
        return reply.code(400).send({ error: "portfolio_required" });
      }
      if (!(await ownedPortfolio(app, id, targetPortfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }

      const source =
        imp.parser === "pytr"
          ? "pytr"
          : imp.parser === "dkb-pdf" || imp.parser === "tr-pdf"
            ? "pdf"
            : imp.parser === "csv" || imp.parser === "dkb" || imp.parser === "tr-csv"
              ? "csv"
              : "screenshot";
      const isEnrichPdf = imp.parser === "dkb-pdf" || imp.parser === "tr-pdf";

      let enriched = 0;
      const skipped: number[] = [];
      const portfolio = await ownedPortfolio(app, id, targetPortfolioId);
      const retain = portfolio?.documentRetention ?? false;

      // Track whether we've already linked the staged document (one doc per import, 1:1 case).
      let documentLinked = false;

      for (let i = 0; i < enrichments.length; i++) {
        const { draft, targetTransactionId } = enrichments[i];

        // IDOR: verify the target transaction belongs to the user's portfolio.
        const [targetTx] = await app.db
          .select({ id: transactions.id, portfolioId: transactions.portfolioId })
          .from(transactions)
          .where(eq(transactions.id, targetTransactionId))
          .limit(1);
        if (!targetTx || targetTx.portfolioId !== targetPortfolioId) {
          skipped.push(i);
          continue;
        }

        await enrichTransactionFromDrafts(targetTransactionId, app.db, [draft], {
          importId: imp.id,
          importSource: source,
        });

        // Link and retain the staged PDF to the target transaction so it surfaces in the
        // transaction-detail view. Single-doc-per-import: only link on the first enrichment.
        if (retain && !documentLinked) {
          const docId = await retainDocumentForTransaction(app, {
            importId: imp.id,
            transactionId: targetTransactionId,
            portfolioId: targetPortfolioId,
          });
          if (docId) documentLinked = true;
        }

        enriched++;
      }

      // If retention is off (or no enrichments retained a doc), clean up any remaining staged
      // document for this import — the /enrich path previously left docs staged indefinitely.
      await finalizeReceipts(app, {
        importId: imp.id,
        portfolioId: targetPortfolioId,
        retain,
      });

      // For DKB/TR-PDF imports: link every source row to the retained document so the
      // per-source download button works (mirrors the confirm path).
      if (isEnrichPdf && retain) {
        try {
          const retainedDoc = await getDocumentForImport(app, imp.id);
          if (retainedDoc) {
            await app.db
              .update(transactionSources)
              .set({ documentId: retainedDoc.id })
              .where(
                and(eq(transactionSources.importId, imp.id), isNull(transactionSources.documentId)),
              );
            request.log.debug(
              { importId: imp.id, docId: retainedDoc.id },
              "enrich: linked PDF source rows to retained document",
            );
          }
        } catch (err) {
          request.log.warn(
            { err },
            "enrich: failed to link PDF source rows to document (non-fatal)",
          );
        }
      }

      request.log.info(
        { importId: imp.id, enriched, skipped: skipped.length, documentLinked },
        "enrich complete",
      );
      return { enriched, skipped };
    },
  );

  // Return a signed URL for the retained source document of an import (#231).
  // IDOR guard: only the document owner can obtain a URL.
  app.get<{ Params: { importId: string } }>(
    "/imports/:importId/document-url",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const imp = await ownedImport(id, request.params.importId);
      if (!imp) return reply.code(404).send({ error: "import_not_found" });

      const doc = await getDocumentForImport(app, imp.id);
      if (!doc) return reply.code(404).send({ error: "document_not_found" });

      // IDOR guard: verify document ownership explicitly (belt-and-suspenders).
      if (doc.userId !== id) return reply.code(403).send({ error: "forbidden" });

      // Build a structured, date-first download filename (statement scope for imports).
      let filename: string | null = doc.originalFilename;
      if (doc.portfolioId) {
        try {
          const parts = await gatherDocumentNaming(app, { doc, portfolioId: doc.portfolioId });
          filename = buildDocumentName(parts);
        } catch {
          // Non-fatal: fall back to originalFilename.
        }
      }

      const url = await app.storage.getSignedUrl(doc.storageKey, undefined, {
        downloadName: filename ?? undefined,
      });
      return { url, filename, mimeType: doc.mimeType };
    },
  );
}
