import type { FastifyInstance } from "fastify";
import { and, count, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { documents, portfolios, screenshotImports, transactions } from "@portfolio/db";
import { PytrAuthError, PytrError } from "../../services/pytr/runner.js";
import { enrichTransactionsFromStoredDocuments } from "../../services/enrichment.js";
import {
  storeReceipt,
  linkTrReceiptsToTransactions,
  finalizeReceipts,
  transactionIdsWithDocuments,
} from "../../storage/receipts.js";
import { getConnection } from "./_shared.js";

export function registerDocumentRoutes(app: FastifyInstance) {
  app.post(
    "/tr/connection/reprocess-documents",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const id = request.userId;
      const conn = await getConnection(app, id);
      if (!conn || !conn.portfolioId) {
        return reply.code(409).send({ error: "not_connected" });
      }
      const txIds = (
        await app.db
          .select({ id: transactions.id })
          .from(transactions)
          .where(
            and(eq(transactions.portfolioId, conn.portfolioId), eq(transactions.source, "pytr")),
          )
      ).map((r) => r.id);

      await enrichTransactionsFromStoredDocuments(app, txIds);
      request.log.info(
        { userId: id, portfolioId: conn.portfolioId, count: txIds.length },
        "tr reprocess-documents done",
      );
      return { processed: txIds.length };
    },
  );

  app.post(
    "/tr/connection/diagnose-documents",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const id = request.userId;
      const conn = await getConnection(app, id);
      if (!conn || conn.status !== "connected") {
        return reply.code(409).send({ error: "not_connected" });
      }
      if (!conn.portfolioId) {
        return reply.code(409).send({ error: "no_portfolio" });
      }

      interface StorageResult {
        ok: boolean;
        signedUrlOk: boolean;
        roundTripOk: boolean;
        error?: { name: string; message: string; httpStatusCode?: number };
      }
      const storageResult: StorageResult = { ok: false, signedUrlOk: false, roundTripOk: false };
      const testKey = `__healthcheck/tr-docs-${id}-${Date.now()}`;
      try {
        await app.storage.put(testKey, Buffer.from("tr-doc-healthcheck"), {
          mimeType: "text/plain",
        });
        storageResult.signedUrlOk = true;
        await app.storage.getSignedUrl(testKey, 60);
        const bytes = await app.storage.get(testKey);
        storageResult.roundTripOk = bytes !== null && bytes.byteLength > 0;
        await app.storage.delete(testKey);
        storageResult.ok = storageResult.roundTripOk;
      } catch (err) {
        const e = err as Record<string, unknown>;
        const meta = e["$metadata"] as Record<string, unknown> | undefined;
        storageResult.error = {
          name: typeof e["name"] === "string" ? e["name"] : "Error",
          message: err instanceof Error ? err.message : String(err),
          ...(meta?.["httpStatusCode"] !== undefined
            ? { httpStatusCode: meta["httpStatusCode"] as number }
            : {}),
        };
        app.storage.delete(testKey).catch(() => undefined);
      }

      interface PythonResult {
        status: "ok" | "session_expired" | "process_failed" | "no_candidate" | "disabled";
        downloaded?: number;
        failures?: { docId: string | null; error: string }[];
        candidate?: { txId: string; eventId: string; docId: string };
        error?: string;
      }
      let pythonResult: PythonResult = { status: "disabled" };

      if (app.pytr.isEnabled !== false) {
        const txRows = await app.db
          .select({
            id: transactions.id,
            externalId: transactions.externalId,
            documentRefs: transactions.documentRefs,
          })
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

            const downloaded = await app.pytr.downloadDocuments({ phone, pin, sessionData }, [
              pair,
            ]);
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

      const [[{ confirmedPytrTxns }], [{ withDocumentRefs }], [{ retainedDocuments }]] =
        await Promise.all([
          app.db
            .select({ confirmedPytrTxns: count() })
            .from(transactions)
            .where(
              and(eq(transactions.portfolioId, conn.portfolioId), eq(transactions.source, "pytr")),
            ),
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

  app.post(
    "/tr/connection/backfill-documents",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const id = request.userId;
      const conn = await getConnection(app, id);
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

      const txRows = await app.db
        .select({
          id: transactions.id,
          externalId: transactions.externalId,
          documentRefs: transactions.documentRefs,
        })
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
        return {
          scanned: txRows.length,
          eligible: 0,
          downloaded: 0,
          stored: 0,
          linked: 0,
          failures: [],
        };
      }

      const txIds = eligible.map((tx) => tx.id);
      const alreadyCovered = await transactionIdsWithDocuments(app, txIds);
      const needsDoc = eligible.filter((tx) => !alreadyCovered.has(tx.id));

      if (needsDoc.length === 0) {
        return {
          scanned: txRows.length,
          eligible: eligible.length,
          downloaded: 0,
          stored: 0,
          linked: 0,
          failures: [],
        };
      }

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

        const links = pairs
          .filter((p) => result.docs.has(p.docId))
          .map((p) => ({ sourceEventId: p.eventId, transactionId: p.txId }));
        if (links.length > 0) {
          await linkTrReceiptsToTransactions(app, { importId, links });
          linked = links.length;
        }

        await finalizeReceipts(app, { importId, portfolioId: conn.portfolioId, retain: true });

        const enrichedTxIds = [...new Set(links.map((l) => l.transactionId))];
        if (enrichedTxIds.length > 0) {
          await enrichTransactionsFromStoredDocuments(app, enrichedTxIds);
        }
      } catch (err) {
        request.log.warn({ err, importId }, "backfill-documents: download failed (non-fatal)");
        failures.push({ docId: null, error: err instanceof Error ? err.message : String(err) });
      }

      request.log.info(
        {
          userId: id,
          portfolioId: conn.portfolioId,
          scanned: txRows.length,
          eligible: needsDoc.length,
          downloaded,
          stored,
          linked,
          failures: failures.length,
        },
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
}
