import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, count, eq, isNotNull, sql } from "drizzle-orm";
import {
  accountHolders,
  documents,
  portfolios,
  screenshotImports,
  transactions,
  trConnections,
  trResolvedEvents,
} from "@portfolio/db";
import { requireUser } from "../plugins/auth.js";
import { PytrApprovalError, PytrAuthError, PytrError, PytrUnavailableError } from "../services/pytr/runner.js";
import { syncTrConnection } from "../services/pytr/sync.js";
import { enrichTransactionsFromStoredDocuments } from "../services/enrichment.js";
import { enqueueTrSync } from "../services/scheduler.js";
import {
  storeReceipt,
  linkTrReceiptsToTransactions,
  finalizeReceipts,
  transactionIdsWithDocuments,
} from "../storage/receipts.js";

const connectBodySchema = z.object({
  phone: z.string().min(3),
  pin: z.string().min(4),
  portfolioId: z.guid(),
  // Break-glass: a manually pasted aws-waf-token, used instead of the solver.
  wafToken: z.string().min(1).optional(),
});

// The DB enum value `awaiting_2fa` denotes the v2 state "push sent, awaiting the user's
// approval in the Trade Republic mobile app" (kept as-is to avoid an enum-rename migration).

type TrConnection = typeof trConnections.$inferSelect;

const IMPORT_CATEGORIES = ["trade", "income", "cashflow", "card"] as const;
const settingsBodySchema = z.object({
  importCategories: z.array(z.enum(IMPORT_CATEGORIES)).min(1),
});

// Never expose the encrypted secrets — only the connection's public state.
function serialize(conn: TrConnection | null) {
  return {
    status: conn?.status ?? "disconnected",
    portfolioId: conn?.portfolioId ?? null,
    lastSyncAt: conn?.lastSyncAt ?? null,
    lastError: conn?.lastError ?? null,
    // Null = the sync default (everything but card spending).
    importCategories: conn?.importCategories ?? null,
    // TR's reported cash vs our derived cash at the last sync (null until first synced).
    lastReconciliation: conn?.lastReconciliation ?? null,
    // True while a background sync job is running.
    syncing: conn?.syncing ?? false,
  };
}

export async function trRoute(app: FastifyInstance) {
  async function getConnection(userId: string): Promise<TrConnection | null> {
    const [conn] = await app.db
      .select()
      .from(trConnections)
      .where(eq(trConnections.userId, userId))
      .limit(1);
    return conn ?? null;
  }

  async function lookupPortfolio(userId: string, portfolioId: string) {
    const [p] = await app.db
      .select({ id: portfolios.id, holderType: accountHolders.type })
      .from(portfolios)
      .leftJoin(accountHolders, eq(portfolios.accountHolderId, accountHolders.id))
      .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
      .limit(1);
    if (!p) return null;
    // A portfolio is a child/Kinderdepot iff its linked holder is type "child".
    return { id: p.id, isChild: p.holderType === "child" };
  }

  // Current connection state (no secrets).
  app.get("/tr/connection", { preHandler: app.authenticate }, async (request) => {
    const { id } = requireUser(request);
    return serialize(await getConnection(id));
  });

  // Update which event categories the sync stages (trade/income/cashflow/card).
  app.patch("/tr/connection", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = requireUser(request);
    const conn = await getConnection(id);
    if (!conn) return reply.code(404).send({ error: "not_connected" });
    const { importCategories } = settingsBodySchema.parse(request.body);
    await app.db
      .update(trConnections)
      .set({ importCategories, updatedAt: new Date() })
      .where(eq(trConnections.id, conn.id));
    return serialize({ ...conn, importCategories });
  });

  // Begin pairing: store encrypted creds and kick off the v2 web-login (sends an approval
  // push to the user's Trade Republic mobile app).
  app.post("/tr/connection", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = requireUser(request);
    // Refuse to store Trade Republic credentials without encryption at rest.
    if (!app.encryption.isEnabled) {
      return reply.code(503).send({ error: "encryption_required" });
    }
    const body = connectBodySchema.parse(request.body);
    const portfolio = await lookupPortfolio(id, body.portfolioId);
    if (!portfolio) {
      return reply.code(404).send({ error: "portfolio_not_found" });
    }
    // Trade Republic child accounts (Kinderdepot) cannot be synced — TR exposes no
    // account selector via the API pytr uses, so a binding here would never pull data.
    // Refuse the connection rather than let the user pair into a dead end (see #123, #199).
    if (portfolio.isChild) {
      return reply.code(422).send({ error: "tr_child_account_unsupported" });
    }

    request.log.info(
      { userId: id, portfolioId: body.portfolioId, wafStrategy: body.wafToken ? "token" : "default" },
      "tr pairing started",
    );
    try {
      await app.pytr.startPairing(id, {
        phone: body.phone,
        pin: body.pin,
        wafToken: body.wafToken,
      });
    } catch (err) {
      if (err instanceof PytrUnavailableError) {
        return reply.code(503).send({ error: "pytr_not_available" });
      }
      request.log.error({ err }, "tr pairing failed to start");
      return reply.code(502).send({ error: "tr_pairing_failed" });
    }

    await app.db
      .insert(trConnections)
      .values({
        userId: id,
        portfolioId: body.portfolioId,
        phoneEnc: app.encryption.encryptString(body.phone),
        pinEnc: app.encryption.encryptString(body.pin),
        status: "awaiting_2fa",
        lastError: null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: trConnections.userId,
        set: {
          portfolioId: body.portfolioId,
          phoneEnc: app.encryption.encryptString(body.phone),
          pinEnc: app.encryption.encryptString(body.pin),
          sessionEnc: null,
          status: "awaiting_2fa",
          lastError: null,
          updatedAt: new Date(),
        },
      });

    reply.code(202);
    return { status: "awaiting_2fa" };
  });

  // Complete pairing: long-poll until the user approves the push in the TR mobile app,
  // then persist the encrypted session. Takes no body — there is no code in the v2 flow.
  // The request hangs until approval, rejection, or the approval window expires (~180s).
  app.post(
    "/tr/connection/verify",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);

      const conn = await getConnection(id);
      if (!conn || conn.status !== "awaiting_2fa" || !app.pytr.hasPendingPairing(id)) {
        return reply.code(409).send({ error: "no_pairing_in_progress" });
      }

      request.log.info({ userId: id }, "tr approval awaiting");
      let sessionData: string;
      try {
        sessionData = await app.pytr.awaitApproval(id);
      } catch (err) {
        const error = err instanceof Error ? err.message : "approval failed";
        await app.db
          .update(trConnections)
          .set({ status: "error", lastError: error, updatedAt: new Date() })
          .where(eq(trConnections.userId, id));
        // A declined/expired push is a user-actionable 400; anything else is a 502.
        if (err instanceof PytrApprovalError) {
          request.log.info({ err }, "tr login not approved");
          return reply.code(400).send({ error: "not_approved" });
        }
        request.log.warn({ err }, "tr approval failed");
        return reply.code(502).send({ error: "tr_approval_failed" });
      }

      await app.db
        .update(trConnections)
        .set({
          sessionEnc: app.encryption.encryptString(sessionData),
          status: "connected",
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(trConnections.userId, id));

      request.log.info({ userId: id }, "tr connected");
      return { status: "connected" };
    },
  );

  // Sync now: enqueue a background pg-boss job (deduped per connection). Returns 202
  // immediately so the UI stays unblocked; the frontend polls GET /tr/connection watching
  // `syncing` + `lastSyncAt` to know when it's done. Falls back to inline sync when
  // pg-boss is unavailable (PGlite / tests).
  app.post(
    "/tr/connection/sync",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const conn = await getConnection(id);
      if (!conn || conn.status !== "connected") {
        return reply.code(409).send({ error: "not_connected" });
      }
      const { queued } = await enqueueTrSync(conn.id);
      if (queued) {
        // Mark syncing immediately so the poller sees it without waiting for the worker to pick up.
        await app.db
          .update(trConnections)
          .set({ syncing: true, updatedAt: new Date() })
          .where(eq(trConnections.id, conn.id));
        reply.code(202);
        return { queued: true };
      }
      // pg-boss unavailable (PGlite / tests) — fall back to inline sync.
      try {
        const result = await syncTrConnection(app.db, app.encryption, app.pytr, conn, request.log, app.storage);
        request.log.info(
          { userId: id, status: result.status, importId: result.importId, drafts: result.drafts, errors: result.errors, cancelled: result.cancelled },
          "tr manual sync done",
        );
        return result;
      } catch (err) {
        request.log.error({ err }, "tr sync failed");
        return reply.code(502).send({ error: "tr_sync_failed" });
      }
    },
  );

  // Re-import everything: wipe the portfolio's pytr transactions, clear the resolved-events
  // ledger, and discard any open pytr draft. The next sync then re-stages the full timeline
  // fresh (enriched) for the user to confirm — the user-driven backfill/refresh path.
  app.post("/tr/connection/reimport", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = requireUser(request);
    const conn = await getConnection(id);
    if (!conn || !conn.portfolioId) {
      return reply.code(409).send({ error: "not_connected" });
    }
    const portfolioId = conn.portfolioId;
    return app.db.transaction(async (tx) => {
      const removed = await tx
        .delete(transactions)
        .where(and(eq(transactions.portfolioId, portfolioId), eq(transactions.source, "pytr")))
        .returning({ id: transactions.id });
      await tx
        .delete(trResolvedEvents)
        .where(and(eq(trResolvedEvents.portfolioId, portfolioId), eq(trResolvedEvents.source, "pytr")));
      await tx
        .update(screenshotImports)
        .set({ status: "discarded" })
        .where(
          and(
            eq(screenshotImports.userId, id),
            eq(screenshotImports.portfolioId, portfolioId),
            eq(screenshotImports.parser, "pytr"),
            eq(screenshotImports.status, "draft"),
          ),
        );
      request.log.info({ userId: id, portfolioId, removed: removed.length }, "tr reimport");
      return { removed: removed.length };
    });
  });

  // Re-process retained settlement PDFs: enrich all already-confirmed pytr transactions
  // from their linked retained documents (tax components, fee, price, FX rate). Non-
  // destructive — does NOT delete or re-stage transactions. Useful after a batch of
  // settlement PDFs are retained by a fresh sync to backfill tax on older confirmed rows.
  app.post(
    "/tr/connection/reprocess-documents",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const conn = await getConnection(id);
      if (!conn || !conn.portfolioId) {
        return reply.code(409).send({ error: "not_connected" });
      }
      const txIds = (
        await app.db
          .select({ id: transactions.id })
          .from(transactions)
          .where(
            and(
              eq(transactions.portfolioId, conn.portfolioId),
              eq(transactions.source, "pytr"),
            ),
          )
      ).map((r) => r.id);

      await enrichTransactionsFromStoredDocuments(app, txIds);
      request.log.info({ userId: id, portfolioId: conn.portfolioId, count: txIds.length }, "tr reprocess-documents done");
      return { processed: txIds.length };
    },
  );

  // Diagnose: identify *why* postbox PDF download/storage failed for this connection.
  //
  // Runs two independent probes in parallel so one failure can't mask the other:
  //   • storage self-test: put → getSignedUrl → get → delete via app.storage.
  //   • python self-test: downloadDocuments for one real (eventId, docId) pair.
  //
  // Reading the result:
  //   storage.ok=false  → mode (b): S3 credentials/bucket misconfigured.
  //   storage.ok=true + python.status≠"ok" → mode (a): Python/session failure.
  //   both ok + counts.retainedDocuments=0 + counts.withDocumentRefs>0
  //     → live path works; use backfill-documents to fetch historical PDFs.
  app.post(
    "/tr/connection/diagnose-documents",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const conn = await getConnection(id);
      if (!conn || conn.status !== "connected") {
        return reply.code(409).send({ error: "not_connected" });
      }
      if (!conn.portfolioId) {
        return reply.code(409).send({ error: "no_portfolio" });
      }

      // ── Probe 1: Storage self-test ──────────────────────────────────────────
      interface StorageResult {
        ok: boolean;
        signedUrlOk: boolean;
        roundTripOk: boolean;
        error?: { name: string; message: string; httpStatusCode?: number };
      }
      const storageResult: StorageResult = { ok: false, signedUrlOk: false, roundTripOk: false };
      const testKey = `__healthcheck/tr-docs-${id}-${Date.now()}`;
      try {
        await app.storage.put(testKey, Buffer.from("tr-doc-healthcheck"), { mimeType: "text/plain" });
        storageResult.signedUrlOk = true;
        await app.storage.getSignedUrl(testKey, 60);
        const bytes = await app.storage.get(testKey);
        storageResult.roundTripOk = bytes !== null && bytes.byteLength > 0;
        await app.storage.delete(testKey);
        storageResult.ok = storageResult.roundTripOk;
      } catch (err) {
        const e = err as Record<string, unknown>;
        const meta = (e["$metadata"] as Record<string, unknown> | undefined);
        storageResult.error = {
          name: typeof e["name"] === "string" ? e["name"] : "Error",
          message: err instanceof Error ? err.message : String(err),
          ...(meta?.["httpStatusCode"] !== undefined
            ? { httpStatusCode: meta["httpStatusCode"] as number }
            : {}),
        };
        // Best-effort cleanup after a partial failure.
        app.storage.delete(testKey).catch(() => undefined);
      }

      // ── Probe 2: Python download self-test ──────────────────────────────────
      interface PythonResult {
        status: "ok" | "session_expired" | "process_failed" | "no_candidate" | "disabled";
        downloaded?: number;
        failures?: { docId: string | null; error: string }[];
        candidate?: { txId: string; eventId: string; docId: string };
        error?: string;
      }
      let pythonResult: PythonResult = { status: "disabled" };

      if (app.pytr.isEnabled !== false) {
        // Find one confirmed pytr tx with a non-empty documentRefs.
        const txRows = await app.db
          .select({ id: transactions.id, externalId: transactions.externalId, documentRefs: transactions.documentRefs })
          .from(transactions)
          .where(
            and(
              eq(transactions.portfolioId, conn.portfolioId),
              eq(transactions.source, "pytr"),
              isNotNull(transactions.externalId),
              isNotNull(transactions.documentRefs),
            ),
          );
        const candidate = txRows.find((tx) => {
          const refs = tx.documentRefs as { id?: string }[] | null;
          return Array.isArray(refs) && refs.some((r) => r?.id);
        });

        if (!candidate || !candidate.externalId) {
          pythonResult = { status: "no_candidate" };
        } else {
          const refs = candidate.documentRefs as { id?: string }[];
          const docId = refs.find((r) => r?.id)!.id!;
          const pair = { eventId: candidate.externalId, docId };

          try {
            const phone = app.encryption.decryptString(conn.phoneEnc!);
            const pin = app.encryption.decryptString(conn.pinEnc!);
            const sessionData = app.encryption.decryptString(conn.sessionEnc!);

            const downloaded = await app.pytr.downloadDocuments({ phone, pin, sessionData }, [pair]);
            pythonResult = {
              status: "ok",
              downloaded: downloaded.docs.size,
              failures: downloaded.failures,
              candidate: { txId: candidate.id, eventId: pair.eventId, docId },
            };
          } catch (err) {
            if (err instanceof PytrAuthError) {
              pythonResult = { status: "session_expired", error: err.message };
            } else if (err instanceof PytrError || err instanceof Error) {
              pythonResult = { status: "process_failed", error: err.message };
            } else {
              pythonResult = { status: "process_failed", error: String(err) };
            }
          }
        }
      }

      // ── Counts ──────────────────────────────────────────────────────────────
      const [[{ confirmedPytrTxns }], [{ withDocumentRefs }], [{ retainedDocuments }]] =
        await Promise.all([
          app.db
            .select({ confirmedPytrTxns: count() })
            .from(transactions)
            .where(and(eq(transactions.portfolioId, conn.portfolioId), eq(transactions.source, "pytr"))),
          app.db
            .select({ withDocumentRefs: count() })
            .from(transactions)
            .where(
              and(
                eq(transactions.portfolioId, conn.portfolioId),
                eq(transactions.source, "pytr"),
                isNotNull(transactions.documentRefs),
                sql`jsonb_array_length(${transactions.documentRefs}) > 0`,
              ),
            ),
          app.db
            .select({ retainedDocuments: count() })
            .from(documents)
            .where(
              and(
                eq(documents.userId, id),
                eq(documents.status, "retained"),
                eq(documents.source, "pytr"),
              ),
            ),
        ]);

      const [{ documentRetention }] = await app.db
        .select({ documentRetention: portfolios.documentRetention })
        .from(portfolios)
        .where(eq(portfolios.id, conn.portfolioId))
        .limit(1);

      return {
        connectionId: conn.id,
        portfolioId: conn.portfolioId,
        documentRetention: documentRetention ?? false,
        storage: storageResult,
        python: pythonResult,
        counts: {
          confirmedPytrTxns: Number(confirmedPytrTxns),
          withDocumentRefs: Number(withDocumentRefs),
          retainedDocuments: Number(retainedDocuments),
        },
      };
    },
  );

  // Non-destructive backfill: fetch and retain postbox PDFs for already-confirmed pytr
  // transactions that have documentRefs but no stored document yet.
  //
  // Unlike reimport (destructive — wipes txns + ledger) and reprocess-documents (enriches
  // from already-stored docs), this fetches the missing bytes from TR's postbox, stores them
  // as retained documents linked to their transactions, and optionally enriches tax/fees.
  //
  // Idempotent: re-running skips transactions already covered by a retained document.
  // Gate: portfolio must have documentRetention=true, else 409 (fetching bytes to immediately
  // discard them is pointless). Run diagnose-documents first to confirm the path is healthy.
  app.post(
    "/tr/connection/backfill-documents",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const conn = await getConnection(id);
      if (!conn || conn.status !== "connected") {
        return reply.code(409).send({ error: "not_connected" });
      }
      if (!conn.portfolioId) {
        return reply.code(409).send({ error: "no_portfolio" });
      }

      const [portfolio] = await app.db
        .select({ documentRetention: portfolios.documentRetention })
        .from(portfolios)
        .where(eq(portfolios.id, conn.portfolioId))
        .limit(1);

      if (!portfolio?.documentRetention) {
        return reply.code(409).send({ error: "document_retention_disabled" });
      }

      // Select all confirmed pytr transactions with at least one documentRef.
      const txRows = await app.db
        .select({ id: transactions.id, externalId: transactions.externalId, documentRefs: transactions.documentRefs })
        .from(transactions)
        .where(
          and(
            eq(transactions.portfolioId, conn.portfolioId),
            eq(transactions.source, "pytr"),
            isNotNull(transactions.externalId),
            isNotNull(transactions.documentRefs),
          ),
        );

      const eligible = txRows.filter((tx) => {
        const refs = tx.documentRefs as { id?: string }[] | null;
        return Array.isArray(refs) && refs.some((r) => r?.id);
      });

      if (eligible.length === 0) {
        return { scanned: txRows.length, eligible: 0, downloaded: 0, stored: 0, linked: 0, failures: [] };
      }

      // Filter out transactions already covered by a retained document.
      const txIds = eligible.map((tx) => tx.id);
      const alreadyCovered = await transactionIdsWithDocuments(app, txIds);
      const needsDoc = eligible.filter((tx) => !alreadyCovered.has(tx.id));

      if (needsDoc.length === 0) {
        return { scanned: txRows.length, eligible: eligible.length, downloaded: 0, stored: 0, linked: 0, failures: [] };
      }

      // Build (eventId, docId) pairs; track the tx they belong to for linking.
      const pairs: { eventId: string; docId: string; txId: string }[] = [];
      for (const tx of needsDoc) {
        if (!tx.externalId) continue;
        const refs = tx.documentRefs as { id?: string }[];
        for (const ref of refs) {
          if (ref?.id) pairs.push({ eventId: tx.externalId, docId: ref.id, txId: tx.id });
        }
      }

      const phone = app.encryption.decryptString(conn.phoneEnc!);
      const pin = app.encryption.decryptString(conn.pinEnc!);
      const sessionData = app.encryption.decryptString(conn.sessionEnc!);

      let downloaded = 0;
      let stored = 0;
      let linked = 0;
      const failures: { docId: string | null; error: string }[] = [];

      // Create one synthetic carrier import so the staged documents have a valid importId FK.
      // status="discarded" keeps it invisible to the sync collector and the imports list UI.
      const [carrierImport] = await app.db
        .insert(screenshotImports)
        .values({
          userId: id,
          portfolioId: conn.portfolioId,
          parser: "pytr",
          parsedJson: { drafts: [], errors: [] },
          status: "discarded",
        })
        .returning({ id: screenshotImports.id });
      const importId = carrierImport.id;

      try {
        const result = await app.pytr.downloadDocuments(
          { phone, pin, sessionData },
          pairs.map(({ eventId, docId }) => ({ eventId, docId })),
        );

        downloaded = result.docs.size;
        failures.push(...result.failures);

        for (const [docId, { buf, mimeType }] of result.docs) {
          const sourceEventId = pairs.find((p) => p.docId === docId)?.eventId ?? null;
          const receipt = await storeReceipt(app, {
            userId: id,
            importId,
            buf,
            mimeType,
            originalFilename: `${docId}.pdf`,
            source: "pytr",
            sourceEventId,
            status: "staged",
          });
          if (receipt.ok) {
            stored++;
          } else {
            failures.push({ docId, error: receipt.error });
          }
        }

        // Link staged docs to their transactions (sourceEventId → externalId matching).
        const links = pairs
          .filter((p) => result.docs.has(p.docId))
          .map((p) => ({ sourceEventId: p.eventId, transactionId: p.txId }));
        if (links.length > 0) {
          await linkTrReceiptsToTransactions(app, { importId, links });
          linked = links.length;
        }

        // Finalize: flip staged→retained and re-key to the structured path.
        await finalizeReceipts(app, { importId, portfolioId: conn.portfolioId, retain: true });

        // Enrich tax/fees from the now-stored settlement PDFs.
        const enrichedTxIds = [...new Set(links.map((l) => l.transactionId))];
        if (enrichedTxIds.length > 0) {
          await enrichTransactionsFromStoredDocuments(app, enrichedTxIds);
        }
      } catch (err) {
        request.log.warn({ err, importId }, "backfill-documents: download failed (non-fatal)");
        failures.push({ docId: null, error: err instanceof Error ? err.message : String(err) });
      }

      request.log.info(
        { userId: id, portfolioId: conn.portfolioId, scanned: txRows.length, eligible: needsDoc.length, downloaded, stored, linked, failures: failures.length },
        "tr backfill-documents done",
      );

      return {
        scanned: txRows.length,
        eligible: needsDoc.length,
        downloaded,
        stored,
        linked,
        failures,
      };
    },
  );

  // Disconnect: wipe the stored connection (and any pending pairing).
  app.delete(
    "/tr/connection",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      app.pytr.cancelPairing(id);
      await app.db.delete(trConnections).where(eq(trConnections.userId, id));
      request.log.info({ userId: id }, "tr disconnected");
      reply.code(204);
      return null;
    },
  );
}
