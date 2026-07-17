import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { transactionSources, transactions, documents } from "@portfolio/db";
import type { TransactionSource } from "@portfolio/db";
import type { ParsedTransaction, TaxComponents } from "@portfolio/schema";
import type { DB } from "../../db/client.js";
import { recomputeRollup, type SourceRow } from "../parsers/dedup.js";
import { extractPdfText } from "../parsers/pdf-text.js";
import { detectTrPdf, parseTrPdf } from "../parsers/tr-pdf.js";

export type AppLike = Pick<FastifyInstance, "db" | "log">;
export type AppWithStorage = Pick<FastifyInstance, "db" | "log" | "storage">;

export function dbHelper(app: AppLike): DB {
  return app.db as DB;
}

export function draftSourceType(
  draft: ParsedTransaction,
  importSource: string,
): TransactionSource["sourceType"] {
  if (draft.taxComponents && Object.keys(draft.taxComponents).length > 0) return "pdf";
  if (importSource === "pytr") return "pytr";
  if (importSource === "ibkr") return "ibkr";
  if (importSource === "manual") return "manual";
  if (importSource === "screenshot") return "screenshot";
  if (importSource === "pdf") return "pdf";
  return "csv";
}

export async function enrichTransactionFromDrafts(
  transactionId: string,
  dbClient: DB,
  drafts: ParsedTransaction[],
  opts: {
    importId?: string;
    importSource?: string;
    documentsByExternalId?: Map<string, string>;
  } = {},
): Promise<string[]> {
  if (drafts.length === 0) return [];

  const { importId, importSource = "csv", documentsByExternalId } = opts;

  const writtenIds: string[] = [];

  for (const draft of drafts) {
    const sourceType = draftSourceType(draft, importSource);
    const externalId = draft.externalId ?? null;
    const documentId =
      externalId && documentsByExternalId ? (documentsByExternalId.get(externalId) ?? null) : null;

    const taxComponents =
      draft.taxComponents && Object.keys(draft.taxComponents).length > 0
        ? (draft.taxComponents as Record<string, unknown>)
        : null;

    const [row] = await dbClient
      .insert(transactionSources)
      .values({
        transactionId,
        sourceType,
        importId: importId ?? null,
        documentId,
        externalId,
        orderRef: draft.orderRef ?? null,
        tax: draft.tax ?? null,
        fees: draft.fees ?? null,
        executedPrice: draft.executedPrice ?? null,
        fxRate: draft.fxRate ?? null,
        venue: draft.venue ?? null,
        perShare: draft.perShare ?? null,
        shares: draft.shares ?? null,
        nativeCurrency: draft.nativeCurrency ?? null,
        grossNative: draft.grossNative ?? null,
        vorabBase: draft.vorabBase ?? null,
        taxComponents,
        rawData: null,
      })
      .onConflictDoNothing()
      .returning({ id: transactionSources.id });

    if (row) writtenIds.push(row.id);
  }

  const [txRow] = await dbClient
    .select({ id: transactions.id, type: transactions.type })
    .from(transactions)
    .where(eq(transactions.id, transactionId));
  if (!txRow) return writtenIds;

  const allSourceRows = await dbClient
    .select({
      sourceType: transactionSources.sourceType,
      tax: transactionSources.tax,
      fees: transactionSources.fees,
      executedPrice: transactionSources.executedPrice,
      fxRate: transactionSources.fxRate,
      venue: transactionSources.venue,
      perShare: transactionSources.perShare,
      shares: transactionSources.shares,
      nativeCurrency: transactionSources.nativeCurrency,
      grossNative: transactionSources.grossNative,
      vorabBase: transactionSources.vorabBase,
      taxComponents: transactionSources.taxComponents,
    })
    .from(transactionSources)
    .where(eq(transactionSources.transactionId, transactionId));

  const rollupRows: SourceRow[] = allSourceRows.map((r) => ({
    sourceType: r.sourceType,
    tax: r.tax,
    fees: r.fees,
    executedPrice: r.executedPrice,
    fxRate: r.fxRate,
    venue: r.venue,
    perShare: r.perShare,
    shares: r.shares,
    nativeCurrency: r.nativeCurrency,
    grossNative: r.grossNative,
    vorabBase: r.vorabBase,
    taxComponents: r.taxComponents as TaxComponents | null,
  }));

  const rollup = recomputeRollup(rollupRows);

  if (!rollup.hasManual) {
    const patch: Partial<typeof transactions.$inferInsert> = {};
    if (rollup.tax !== null) patch.tax = rollup.tax;
    if (rollup.fees !== null) patch.fees = rollup.fees;
    if (rollup.executedPrice !== null) {
      patch.executedPrice = rollup.executedPrice;
      if (txRow.type === "sell") {
        patch.price = rollup.executedPrice;
      }
    }
    if (rollup.fxRate !== null) patch.fxRate = rollup.fxRate;
    if (rollup.venue !== null) patch.venue = rollup.venue;
    if (rollup.perShare !== null) patch.perShare = rollup.perShare;
    if (rollup.shares !== null) patch.shares = rollup.shares;
    if (rollup.nativeCurrency !== null) patch.nativeCurrency = rollup.nativeCurrency;
    if (rollup.grossNative !== null) patch.grossNative = rollup.grossNative;
    if (rollup.vorabBase !== null) patch.vorabBase = rollup.vorabBase;

    if (Object.keys(patch).length > 0) {
      await dbClient.update(transactions).set(patch).where(eq(transactions.id, transactionId));
    }
  }

  return writtenIds;
}

export async function enrichTransactionsFromStoredDocuments(
  app: AppWithStorage,
  txIds: string[],
): Promise<void> {
  if (txIds.length === 0) return;

  const txRows = await dbHelper(app)
    .select({
      id: transactions.id,
      documentRefs: transactions.documentRefs,
      source: transactions.source,
    })
    .from(transactions)
    .where(inArray(transactions.id, txIds));

  const enrichTxIds = txRows
    .filter((tx) => ((tx.documentRefs as unknown[] | null) ?? []).length > 0)
    .map((tx) => tx.id);
  const docsByTxId = new Map<
    string,
    { id: string; storageKey: string; sourceEventId: string | null }[]
  >();
  if (enrichTxIds.length > 0) {
    const allDocRows = await dbHelper(app)
      .select({
        transactionId: documents.transactionId,
        id: documents.id,
        storageKey: documents.storageKey,
        sourceEventId: documents.sourceEventId,
      })
      .from(documents)
      .where(
        and(
          inArray(documents.transactionId, enrichTxIds),
          inArray(documents.status, ["staged", "retained"]),
        ),
      );
    for (const d of allDocRows) {
      if (!d.transactionId) continue;
      const entry = { id: d.id, storageKey: d.storageKey, sourceEventId: d.sourceEventId };
      const bucket = docsByTxId.get(d.transactionId);
      if (bucket) bucket.push(entry);
      else docsByTxId.set(d.transactionId, [entry]);
    }
  }

  for (const tx of txRows) {
    const refs = (tx.documentRefs as { id?: string; type?: string; date?: string }[] | null) ?? [];
    if (refs.length === 0) continue;

    const docRows = docsByTxId.get(tx.id) ?? [];
    if (docRows.length === 0) continue;

    const drafts: ParsedTransaction[] = [];
    const documentsByExternalId = new Map<string, string>();

    for (const doc of docRows) {
      try {
        const bytes = await app.storage.get(doc.storageKey);
        if (!bytes) continue;
        const text = await extractPdfText(Buffer.from(bytes));
        if (!detectTrPdf(text)) continue;

        const { drafts: parsed } = parseTrPdf(text);
        for (const d of parsed) {
          const externalId =
            d.externalId && (d.action === "dividend" || d.action === "interest")
              ? `${d.externalId}:${doc.id}`
              : d.externalId;
          const keyedDraft = externalId === d.externalId ? d : { ...d, externalId };
          drafts.push(keyedDraft);
          if (externalId) documentsByExternalId.set(externalId, doc.id);
        }
      } catch (err) {
        app.log.warn({ err, docId: doc.id, txId: tx.id }, "enrichment: failed to parse stored doc");
      }
    }

    if (drafts.length === 0) continue;

    try {
      await enrichTransactionFromDrafts(tx.id, dbHelper(app), drafts, {
        importSource: "pdf",
        documentsByExternalId,
      });
      app.log.info(
        { txId: tx.id, draftCount: drafts.length },
        "enrichment: tx enriched from stored settlement PDFs",
      );
    } catch (err) {
      app.log.warn(
        { err, txId: tx.id },
        "enrichment: enrichTransactionFromDrafts failed (non-fatal)",
      );
    }
  }
}
