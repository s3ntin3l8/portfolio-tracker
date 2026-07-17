import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { transactionSources } from "@portfolio/db";
import type { ResolvedDraft } from "../../services/materialize-drafts.js";
import {
  enrichTransactionFromDrafts,
  enrichTransactionsFromStoredDocuments,
} from "../../services/enrichment.js";
import {
  finalizeReceipts,
  linkTrReceiptsToTransactions,
  retainDocumentForTransaction,
  getDocumentForImport,
} from "../../storage/receipts.js";
import { ownedPortfolio } from "../helpers.js";

export async function finalizeConfirmedImport(
  app: FastifyInstance,
  opts: {
    importId: string;
    targetPortfolioId: string;
    created: { id: string; externalId?: string | null }[];
    isPytr: boolean;
    isDkbPdf: boolean;
    isTrPdf: boolean;
    source: string;
    enrichmentMatches: { draftIndex: number; matchedTransactionId: string }[];
    resolved: ResolvedDraft[];
    userId: string;
    requestLog: {
      info: (...args: unknown[]) => void;
      debug: (...args: unknown[]) => void;
      warn: (...args: unknown[]) => void;
    };
  },
): Promise<{ enriched: number }> {
  const {
    importId,
    targetPortfolioId,
    created,
    isPytr,
    isDkbPdf,
    isTrPdf,
    source,
    enrichmentMatches,
    resolved,
    userId,
    requestLog,
  } = opts;

  // For TR imports: link each staged document to its confirmed transaction.
  // Must run BEFORE finalizeReceipts.
  if (isPytr && created.length > 0) {
    const links = created
      .filter((r): r is typeof r & { externalId: string } => Boolean(r.externalId))
      .map((r) => ({ sourceEventId: r.externalId as string, transactionId: r.id }));
    if (links.length > 0) {
      await linkTrReceiptsToTransactions(app, { importId, links });
    }
    try {
      await enrichTransactionsFromStoredDocuments(
        app,
        created.map((r) => r.id),
      );
    } catch (err) {
      requestLog.warn({ err }, "auto TR enrichment failed (non-fatal)");
    }
  }

  const portfolio = await ownedPortfolio(app, userId, targetPortfolioId);
  const retain = portfolio?.documentRetention ?? false;

  // Auto-enrich: for each draft classified as "enrichment", fold its
  // fields into the matched existing transaction and link/retain the staged PDF.
  // Must run BEFORE finalizeReceipts.
  let enriched = 0;
  if (enrichmentMatches.length > 0) {
    try {
      for (const { draftIndex, matchedTransactionId } of enrichmentMatches) {
        const { draft } = resolved[draftIndex];
        await enrichTransactionFromDrafts(matchedTransactionId, app.db, [draft], {
          importId,
          importSource: source,
        });
        if (retain) {
          await retainDocumentForTransaction(app, {
            importId,
            transactionId: matchedTransactionId,
            portfolioId: targetPortfolioId,
          });
        }
        enriched++;
      }
      requestLog.info({ importId, enriched }, "confirm: auto-enrichment applied");
    } catch (err) {
      requestLog.warn({ err }, "confirm: auto-enrichment failed (non-fatal)");
    }
  }

  await finalizeReceipts(app, {
    importId,
    portfolioId: targetPortfolioId,
    retain,
  });

  // For DKB/TR-PDF imports: link every source row to the retained document.
  if ((isDkbPdf || isTrPdf) && retain) {
    try {
      const retainedDoc = await getDocumentForImport(app, importId);
      if (retainedDoc) {
        await app.db
          .update(transactionSources)
          .set({ documentId: retainedDoc.id })
          .where(
            and(eq(transactionSources.importId, importId), isNull(transactionSources.documentId)),
          );
        requestLog.debug(
          { importId, docId: retainedDoc.id },
          "confirm: linked PDF source rows to retained document",
        );
      }
    } catch (err) {
      requestLog.warn({ err }, "confirm: failed to link PDF source rows to document (non-fatal)");
    }
  }

  return { enriched };
}
