import type { FastifyInstance } from "fastify";
import type { Multipart } from "@fastify/multipart";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { documents, portfolios, transactions, transactionSources } from "@portfolio/db";
import { documentUploadFieldsSchema, documentListQuerySchema } from "@portfolio/schema";
import { requireUser } from "../plugins/auth.js";
import { withDerivationCache, createStore } from "../lib/derivation-cache.js";
import { logTiming } from "../lib/timing.js";
import {
  storeInboxDocument,
  deleteInboxDocument,
  listInboxDocuments,
  getInboxDocument,
} from "../storage/inbox.js";
import { ownedPortfolio } from "./imports/helpers.js";
import { shortHash } from "../services/parsers/hash.js";
import { getDocumentForTransaction } from "../storage/receipts.js";
import { gatherDocumentNaming, buildDocumentName } from "../storage/naming.js";

const documentsCache = createStore<{ rows: unknown[]; total: number }>();

/** Read a plain-field value out of a multipart `part.fields[name]` entry (which may be a
 *  file, a value, an array of either, or absent). Returns undefined for anything but a
 *  single scalar field. */
function fieldValue(entry: Multipart | Multipart[] | undefined): string | undefined {
  const f = Array.isArray(entry) ? entry[0] : entry;
  if (!f || f.type !== "field") return undefined;
  return f.value == null ? undefined : String(f.value);
}

/**
 * The tax-reports inbox: account-level documents (currently: the annual TR tax report,
 * plus user uploads) that don't belong to any single transaction — see storage/inbox.ts
 * for why these bypass the receipts staging/GC lifecycle.
 */
export async function documentsRoute(app: FastifyInstance) {
  // List the current user's inbox documents, newest first. Defaults to category=tax_report
  // (the only category today) — see listInboxDocuments.
  app.get("/documents", { preHandler: app.authenticate }, async (request) => {
    const { id: userId } = requireUser(request);
    const { category, portfolioId, page: rawPage, pageSize: rawPageSize } = documentListQuerySchema.parse(request.query);
    const paginate = rawPage !== undefined;
    const page = paginate ? Math.max(1, parseInt(rawPage!, 10) || 1) : 1;
    const pageSize = paginate
      ? Math.min(100, Math.max(1, parseInt(rawPageSize ?? "25", 10) || 25))
      : 0;

    const renderRow = (d: { id: string; category: string | null; taxYear: number | null; source: string | null; originalFilename: string | null; mimeType: string | null; sizeBytes: number | null; portfolioId: string | null; storedAt: Date }, nameById: Map<string, string>) => ({
      id: d.id,
      category: d.category,
      taxYear: d.taxYear,
      source: d.source,
      originalFilename: d.originalFilename,
      mimeType: d.mimeType,
      sizeBytes: d.sizeBytes,
      portfolioId: d.portfolioId,
      portfolioLabel: d.portfolioId ? (nameById.get(d.portfolioId) ?? null) : null,
      storedAt: d.storedAt,
    });

    const t0 = performance.now();

    if (paginate) {
      const conditions = [eq(documents.userId, userId), eq(documents.category, category ?? "tax_report")];
      if (portfolioId) conditions.push(eq(documents.portfolioId, portfolioId));

      const cacheKey = `${userId}:${page}:${pageSize}:${category ?? ""}:${portfolioId ?? ""}`;
      const cached = await withDerivationCache(documentsCache, cacheKey, async () => {
        const [cnt, rows] = await Promise.all([
          app.db
            .select({ count: count() })
            .from(documents)
            .where(and(...conditions))
            .then((r) => Number(r[0].count)),
          app.db
            .select()
            .from(documents)
            .where(and(...conditions))
            .orderBy(desc(documents.storedAt))
            .limit(pageSize)
            .offset((page - 1) * pageSize),
        ]);

        const portfolioIds = [...new Set(rows.map((d) => d.portfolioId).filter((x): x is string => Boolean(x)))];
        const portfolioRows = portfolioIds.length
          ? await app.db
              .select({ id: portfolios.id, name: portfolios.name })
              .from(portfolios)
              .where(inArray(portfolios.id, portfolioIds))
          : [];
        const nameById = new Map(portfolioRows.map((p) => [p.id, p.name]));

        return { rows: rows.map((d) => renderRow(d, nameById)), total: cnt };
      });

      const durationMs = performance.now() - t0;
      logTiming(request, "GET /documents", durationMs, { total: cached.total, page, pageSize });

      return cached;
    }

    const docs = await listInboxDocuments(app, { userId, category, portfolioId });

    const portfolioIds = [...new Set(docs.map((d) => d.portfolioId).filter((x): x is string => Boolean(x)))];
    const portfolioRows = portfolioIds.length
      ? await app.db
          .select({ id: portfolios.id, name: portfolios.name })
          .from(portfolios)
          .where(inArray(portfolios.id, portfolioIds))
      : [];
    const nameById = new Map(portfolioRows.map((p) => [p.id, p.name]));

    const durationMs = performance.now() - t0;
    logTiming(request, "GET /documents", durationMs, { docCount: docs.length });

    return docs.map((d) => renderRow(d, nameById));
  });

  // Upload a tax PDF straight into the inbox — no import required at upload time, but
  // portfolioId IS required: every inbox document must be associated with the account it
  // covers. Mirrors POST /imports/screenshot's multipart handling
  // (routes/imports/parse.ts), scoped to PDF only.
  app.post("/documents", { preHandler: app.authenticate }, async (request, reply) => {
    const { id: userId } = requireUser(request);

    let part;
    try {
      part = await request.file();
    } catch {
      return reply.code(400).send({ error: "no_file" });
    }
    if (!part) return reply.code(400).send({ error: "no_file" });

    const mimeType = part.mimetype || "application/pdf";
    if (mimeType !== "application/pdf") {
      await part.toBuffer().catch(() => {});
      return reply.code(415).send({ error: "unsupported_media_type" });
    }

    let buf: Buffer;
    try {
      buf = await part.toBuffer();
    } catch (err) {
      if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
        return reply.code(413).send({ error: "file_too_large", limitMb: 25 });
      }
      throw err;
    }

    const parsedFields = documentUploadFieldsSchema.safeParse({
      category: fieldValue(part.fields.category),
      taxYear: fieldValue(part.fields.taxYear),
      portfolioId: fieldValue(part.fields.portfolioId),
    });
    if (!parsedFields.success) {
      return reply.code(400).send({ error: "invalid_fields" });
    }
    const { category, taxYear, portfolioId: requestedPortfolioId } = parsedFields.data;

    // IDOR guard: the portfolio must belong to the uploading user.
    const portfolio = await ownedPortfolio(app, userId, requestedPortfolioId);
    if (!portfolio) return reply.code(404).send({ error: "portfolio_not_found" });
    const portfolioId = portfolio.id;

    // Content-hash dedup (mirrors the screenshot import path's rawHash): re-uploading the
    // exact same PDF is a no-op rather than a duplicate inbox row. Reuses storeInboxDocument's
    // sourceEventId idempotency machinery — no separate content-hash column needed.
    const contentHash = shortHash(buf.toString("base64"));
    const result = await storeInboxDocument(app, {
      userId,
      portfolioId,
      category,
      taxYear: taxYear ?? null,
      buf,
      mimeType,
      originalFilename: part.filename,
      source: "upload",
      sourceEventId: `upload:${contentHash}`,
    });

    if (!result.ok) {
      request.log.error({ err: result.error }, "document upload failed");
      return reply.code(500).send({ error: "upload_failed" });
    }

    request.log.info(
      { documentId: result.documentId, category, duplicate: Boolean(result.duplicate) },
      "inbox document uploaded",
    );
    reply.code(result.duplicate ? 200 : 201);
    return { id: result.documentId, duplicate: Boolean(result.duplicate), category, taxYear: taxYear ?? null };
  });

  // Signed URL for downloading an inbox document. IDOR guard: only the owner can obtain a URL.
  app.get<{ Params: { documentId: string } }>(
    "/documents/:documentId/url",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id: userId } = requireUser(request);
      const doc = await getInboxDocument(app, request.params.documentId);
      if (!doc) return reply.code(404).send({ error: "document_not_found" });
      if (doc.userId !== userId) return reply.code(403).send({ error: "forbidden" });

      const url = await app.storage.getSignedUrl(doc.storageKey, undefined, {
        downloadName: doc.originalFilename ?? undefined,
      });
      return { url, filename: doc.originalFilename, mimeType: doc.mimeType };
    },
  );

  // Delete an inbox document — removes the storage object then the row.
  app.delete<{ Params: { documentId: string } }>(
    "/documents/:documentId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id: userId } = requireUser(request);
      const doc = await getInboxDocument(app, request.params.documentId);
      if (!doc) return reply.code(404).send({ error: "document_not_found" });
      if (doc.userId !== userId) return reply.code(403).send({ error: "forbidden" });

      await deleteInboxDocument(app, { documentId: doc.id, storageKey: doc.storageKey });
      request.log.info({ documentId: doc.id }, "inbox document deleted");
      reply.code(204);
      return null;
    },
  );

  // ── Transaction-linked document endpoints (moved from transactions.ts) ───────
  // Return a signed URL for the document linked to a transaction.
  app.get<{ Params: { portfolioId: string; txId: string } }>(
    "/portfolios/:portfolioId/transactions/:txId/document-url",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId, txId } = request.params;
      if (!(await ownedPortfolio(app, id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }

      const [tx] = await app.db
        .select({ id: transactions.id, importId: transactions.importId })
        .from(transactions)
        .where(and(eq(transactions.id, txId), eq(transactions.portfolioId, portfolioId)))
        .limit(1);
      if (!tx) return reply.code(404).send({ error: "transaction_not_found" });

      const doc = await getDocumentForTransaction(app, tx.id, tx.importId);
      if (!doc) return reply.code(404).send({ error: "document_not_found" });
      if (doc.userId !== id) return reply.code(403).send({ error: "forbidden" });

      let filename: string | null = doc.originalFilename;
      try {
        const parts = await gatherDocumentNaming(app, { doc, portfolioId, txId: tx.id });
        filename = buildDocumentName(parts);
      } catch {
        // Non-fatal: fall back to originalFilename.
      }

      const url = await app.storage.getSignedUrl(doc.storageKey, undefined, {
        downloadName: filename ?? undefined,
      });
      return { url, filename, mimeType: doc.mimeType };
    },
  );

  // Return a signed URL for the document linked to a specific transaction_sources row.
  app.get<{ Params: { portfolioId: string; txId: string; sourceId: string } }>(
    "/portfolios/:portfolioId/transactions/:txId/sources/:sourceId/document-url",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId, txId, sourceId } = request.params;
      if (!(await ownedPortfolio(app, id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }

      const [tx] = await app.db
        .select({ id: transactions.id })
        .from(transactions)
        .where(and(eq(transactions.id, txId), eq(transactions.portfolioId, portfolioId)))
        .limit(1);
      if (!tx) return reply.code(404).send({ error: "transaction_not_found" });

      let doc: {
        id: string;
        storageKey: string;
        originalFilename: string | null;
        mimeType: string;
        source: string | null;
        storedAt: Date;
        importId: string | null;
        transactionId: string | null;
        userId: string;
      } | null;

      if (sourceId.startsWith("doc:")) {
        const documentId = sourceId.slice("doc:".length);
        const [row] = await app.db
          .select({
            id: documents.id,
            storageKey: documents.storageKey,
            originalFilename: documents.originalFilename,
            mimeType: documents.mimeType,
            source: documents.source,
            storedAt: documents.storedAt,
            importId: documents.importId,
            transactionId: documents.transactionId,
            userId: documents.userId,
          })
          .from(documents)
          .where(and(eq(documents.id, documentId), eq(documents.transactionId, txId)))
          .limit(1);
        doc = row ?? null;
      } else {
        const [sourceRow] = await app.db
          .select({
            id: transactionSources.id,
            documentId: transactionSources.documentId,
            importId: transactionSources.importId,
          })
          .from(transactionSources)
          .where(
            and(eq(transactionSources.id, sourceId), eq(transactionSources.transactionId, txId)),
          )
          .limit(1);
        if (!sourceRow) return reply.code(404).send({ error: "source_not_found" });

        if (sourceRow.documentId) {
          const [row] = await app.db
            .select({
              id: documents.id,
              storageKey: documents.storageKey,
              originalFilename: documents.originalFilename,
              mimeType: documents.mimeType,
              source: documents.source,
              storedAt: documents.storedAt,
              importId: documents.importId,
              transactionId: documents.transactionId,
              userId: documents.userId,
            })
            .from(documents)
            .where(eq(documents.id, sourceRow.documentId))
            .limit(1);
          doc = row ?? null;
        } else {
          doc = await getDocumentForTransaction(app, txId, sourceRow.importId);
        }
      }
      if (!doc) return reply.code(404).send({ error: "document_not_found" });
      if (doc.userId !== id) return reply.code(403).send({ error: "forbidden" });

      let filename: string | null = doc.originalFilename;
      try {
        const parts = await gatherDocumentNaming(app, { doc, portfolioId, txId });
        filename = buildDocumentName(parts);
      } catch {
        // Non-fatal: fall back to originalFilename.
      }

      const url = await app.storage.getSignedUrl(doc.storageKey, undefined, {
        downloadName: filename ?? undefined,
      });
      return { url, filename, mimeType: doc.mimeType };
    },
  );

  // Bulk-export all retained documents for a portfolio as a zip archive.
  app.get<{ Params: { portfolioId: string } }>(
    "/portfolios/:portfolioId/documents/export",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      if (!(await ownedPortfolio(app, id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }

      const docs = await app.db
        .select({
          id: documents.id,
          storageKey: documents.storageKey,
          mimeType: documents.mimeType,
          originalFilename: documents.originalFilename,
          source: documents.source,
          storedAt: documents.storedAt,
          importId: documents.importId,
          transactionId: documents.transactionId,
          userId: documents.userId,
        })
        .from(documents)
        .where(
          and(eq(documents.portfolioId, portfolioId), eq(documents.status, "retained")),
        );

      if (docs.length === 0) {
        return reply.code(404).send({ error: "no_documents" });
      }

      const usedNames = new Set<string>();

      function dedupeFilename(name: string): string {
        if (!usedNames.has(name)) {
          usedNames.add(name);
          return name;
        }
        const dotIdx = name.lastIndexOf(".");
        const base = dotIdx >= 0 ? name.slice(0, dotIdx) : name;
        const ext = dotIdx >= 0 ? name.slice(dotIdx) : "";
        let n = 2;
        let candidate = `${base}-${n}${ext}`;
        while (usedNames.has(candidate)) {
          n++;
          candidate = `${base}-${n}${ext}`;
        }
        usedNames.add(candidate);
        return candidate;
      }

      const { zipSync } = await import("fflate");
      const entries: Record<string, Uint8Array> = {};

      for (const doc of docs) {
        let entryName: string;
        try {
          const parts = await gatherDocumentNaming(app, { doc, portfolioId });
          entryName = buildDocumentName(parts);
        } catch {
          entryName = doc.originalFilename ?? `document_${doc.id.slice(0, 8)}`;
        }
        entryName = dedupeFilename(entryName);

        const buf = await app.storage.get(doc.storageKey);
        if (!buf) {
          app.log.warn({ docId: doc.id, key: doc.storageKey }, "export: object not found, skipping");
          continue;
        }
        entries[entryName] = new Uint8Array(buf);
      }

      const [portfolio] = await app.db
        .select({ name: portfolios.name })
        .from(portfolios)
        .where(eq(portfolios.id, portfolioId))
        .limit(1);

      const archiveName = portfolio
        ? `${portfolio.name.replace(/[^\w-]/g, "-")}_documents.zip`
        : "documents.zip";

      const zipped = zipSync(entries);

      void reply.header("Content-Type", "application/zip");
      void reply.header("Content-Disposition", `attachment; filename="${archiveName}"`);
      void reply.header("Content-Length", String(zipped.length));
      return reply.code(200).send(Buffer.from(zipped));
    },
  );
}
