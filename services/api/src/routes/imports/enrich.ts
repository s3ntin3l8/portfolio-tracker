import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { screenshotImports, transactions, transactionSources } from "@portfolio/db";
import { parsedTransactionSchema } from "@portfolio/schema";
import { enrichTransactionFromDrafts } from "../../services/enrichment.js";
import {
  finalizeReceipts,
  getDocumentForImport,
  retainDocumentForTransaction,
} from "../../storage/receipts.js";
import { gatherDocumentNaming, buildDocumentName } from "../../storage/naming.js";
import { ownedPortfolio } from "../helpers.js";

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

export function registerEnrichRoute(app: FastifyInstance) {
  async function ownedImport(userId: string, importId: string) {
    const [imp] = await app.db
      .select()
      .from(screenshotImports)
      .where(and(eq(screenshotImports.id, importId), eq(screenshotImports.userId, userId)))
      .limit(1);
    return imp ?? null;
  }

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
  app.post<{ Params: { importId: string } }>(
    "/imports/:importId/enrich",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const id = request.userId;
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
      const id = request.userId;
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
