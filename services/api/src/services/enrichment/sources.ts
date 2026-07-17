import { and, eq, inArray, isNull } from "drizzle-orm";
import { transactionSources, documents } from "@portfolio/db";
import type { TaxComponents } from "@portfolio/schema";
import { dbHelper, type AppLike } from "./core.js";
import {
  gatherDocumentMetadata,
  namingContextFor,
  computeNamingParts,
  buildDocumentName,
  type NamingRequest,
  type DocumentForNaming,
  type DocumentNamingMetadata,
} from "../../storage/naming.js";

export interface SourceSummary {
  id: string;
  sourceType: string;
  externalId: string | null;
  orderRef: string | null;
  documentId: string | null;
  taxComponents: TaxComponents | null;
  createdAt: Date;
  filename: string | null;
  hasDocument: boolean;
}

export async function sourcesForTransactions(
  app: AppLike,
  txIds: string[],
  portfolioId: string,
): Promise<Map<string, SourceSummary[]>> {
  if (txIds.length === 0) return new Map();

  const rows = await dbHelper(app)
    .select({
      id: transactionSources.id,
      transactionId: transactionSources.transactionId,
      sourceType: transactionSources.sourceType,
      externalId: transactionSources.externalId,
      orderRef: transactionSources.orderRef,
      documentId: transactionSources.documentId,
      importId: transactionSources.importId,
      taxComponents: transactionSources.taxComponents,
      createdAt: transactionSources.createdAt,
    })
    .from(transactionSources)
    .where(inArray(transactionSources.transactionId, txIds));

  const fallbackRows = rows.filter((r) => !r.documentId && r.sourceType !== "pytr");
  const docIds = [...new Set(rows.map((r) => r.documentId).filter((d): d is string => !!d))];
  const importIds = [
    ...new Set(fallbackRows.map((r) => r.importId).filter((i): i is string => !!i)),
  ];
  const claimedDocIds = new Set(docIds);

  const namingRequests: { entry: SourceSummary; request: NamingRequest }[] = [];

  const docNameById = new Map<string, { originalFilename: string | null; mimeType: string }>();
  if (docIds.length > 0) {
    const docRows = await dbHelper(app)
      .select({
        id: documents.id,
        originalFilename: documents.originalFilename,
        mimeType: documents.mimeType,
      })
      .from(documents)
      .where(and(inArray(documents.id, docIds), eq(documents.status, "retained")));
    for (const d of docRows) {
      docNameById.set(d.id, { originalFilename: d.originalFilename, mimeType: d.mimeType });
    }
  }

  const docNameByImportId = new Map<
    string,
    { id: string; originalFilename: string | null; mimeType: string }
  >();
  if (importIds.length > 0) {
    const impRows = await dbHelper(app)
      .select({
        id: documents.id,
        importId: documents.importId,
        originalFilename: documents.originalFilename,
        mimeType: documents.mimeType,
      })
      .from(documents)
      .where(
        and(
          inArray(documents.importId, importIds),
          eq(documents.status, "retained"),
          isNull(documents.transactionId),
        ),
      );
    for (const d of impRows) {
      if (d.importId && !docNameByImportId.has(d.importId)) {
        docNameByImportId.set(d.importId, {
          id: d.id,
          originalFilename: d.originalFilename,
          mimeType: d.mimeType,
        });
      }
    }
  }

  const out = new Map<string, SourceSummary[]>();
  for (const r of rows) {
    let filename: string | null = null;
    let hasDocument = false;
    let namingDoc: DocumentForNaming | null = null;
    if (r.sourceType !== "pytr") {
      if (r.documentId && docNameById.has(r.documentId)) {
        const doc = docNameById.get(r.documentId)!;
        filename = doc.originalFilename;
        hasDocument = true;
        namingDoc = {
          id: r.documentId,
          mimeType: doc.mimeType,
          source: null,
          storedAt: r.createdAt,
          importId: null,
          transactionId: null,
        };
      } else if (r.importId && docNameByImportId.has(r.importId)) {
        const doc = docNameByImportId.get(r.importId)!;
        filename = doc.originalFilename;
        hasDocument = true;
        namingDoc = {
          id: doc.id,
          mimeType: doc.mimeType,
          source: null,
          storedAt: r.createdAt,
          importId: r.importId,
          transactionId: null,
        };
      }
    }
    const entry: SourceSummary = {
      id: r.id,
      sourceType: r.sourceType,
      externalId: r.externalId,
      orderRef: r.orderRef,
      documentId: r.documentId,
      taxComponents: r.taxComponents as TaxComponents | null,
      createdAt: r.createdAt,
      filename,
      hasDocument,
    };
    const bucket = out.get(r.transactionId);
    if (bucket) bucket.push(entry);
    else out.set(r.transactionId, [entry]);
    if (namingDoc)
      namingRequests.push({ entry, request: { doc: namingDoc, txId: r.transactionId } });
  }

  const unclaimedDocs = await dbHelper(app)
    .select({
      id: documents.id,
      transactionId: documents.transactionId,
      originalFilename: documents.originalFilename,
      mimeType: documents.mimeType,
      storedAt: documents.storedAt,
    })
    .from(documents)
    .where(and(inArray(documents.transactionId, txIds), eq(documents.status, "retained")));
  for (const d of unclaimedDocs) {
    if (!d.transactionId || claimedDocIds.has(d.id)) continue;
    const entry: SourceSummary = {
      id: `doc:${d.id}`,
      sourceType: "pdf",
      externalId: null,
      orderRef: null,
      documentId: d.id,
      taxComponents: null,
      createdAt: d.storedAt,
      filename: d.originalFilename,
      hasDocument: true,
    };
    const bucket = out.get(d.transactionId);
    if (bucket) bucket.push(entry);
    else out.set(d.transactionId, [entry]);
    namingRequests.push({
      entry,
      request: {
        doc: {
          id: d.id,
          mimeType: d.mimeType,
          source: null,
          storedAt: d.storedAt,
          importId: null,
          transactionId: d.transactionId,
        },
        txId: d.transactionId,
      },
    });
  }

  if (namingRequests.length > 0) {
    try {
      const meta = await gatherDocumentMetadata(
        app,
        namingRequests.map((n) => n.request),
        portfolioId,
      );
      for (const { entry, request } of namingRequests) {
        const parts = computeNamingParts(request.doc, namingContextFor(request, meta));
        entry.filename = buildDocumentName(parts);
      }
    } catch (err) {
      app.log.warn(
        { err, portfolioId },
        "sourcesForTransactions: display-name synthesis failed (non-fatal, raw filenames kept)",
      );
    }
  }

  return out;
}

export function sourcesFromPreFetched(
  sourcesRows: {
    id: string;
    transactionId: string;
    sourceType: string;
    externalId: string | null;
    orderRef: string | null;
    documentId: string | null;
    importId: string | null;
    taxComponents: unknown;
    createdAt: Date;
  }[],
  docsRows: {
    id: string;
    transactionId: string | null;
    importId: string | null;
    status: string;
    originalFilename: string | null;
    mimeType: string;
    storedAt: Date;
  }[],
  rows: { id: string; type: string; executedAt: Date; instrumentId: string | null }[],
  instrumentsMeta: Map<string, { symbol: string }>,
  portfolioName: string | null,
  importMinDateById?: Map<string, Date>,
): Map<string, SourceSummary[]> {
  if (sourcesRows.length === 0 && docsRows.length === 0) return new Map();

  const txById = new Map<string, { type: string; executedAt: Date; instrumentId: string | null }>();
  for (const r of rows)
    txById.set(r.id, { type: r.type, executedAt: r.executedAt, instrumentId: r.instrumentId });

  const instrumentSymbolById = new Map<string, string>();
  for (const [id, m] of instrumentsMeta) instrumentSymbolById.set(id, m.symbol);

  const namingMeta: DocumentNamingMetadata = {
    portfolioName,
    txById,
    instrumentSymbolById,
    importMinDateById: importMinDateById ?? new Map(),
  };

  const docById = new Map<string, { originalFilename: string | null; mimeType: string }>();
  const importDocById = new Map<
    string,
    { id: string; originalFilename: string | null; mimeType: string }
  >();
  for (const d of docsRows) {
    if (d.status !== "retained") continue;
    docById.set(d.id, { originalFilename: d.originalFilename, mimeType: d.mimeType });
    if (d.importId && !d.transactionId && !importDocById.has(d.importId)) {
      importDocById.set(d.importId, {
        id: d.id,
        originalFilename: d.originalFilename,
        mimeType: d.mimeType,
      });
    }
  }

  const claimedDocIds = new Set(sourcesRows.map((r) => r.documentId).filter(Boolean) as string[]);

  const namingRequests: { entry: SourceSummary; request: NamingRequest }[] = [];
  const out = new Map<string, SourceSummary[]>();

  for (const r of sourcesRows) {
    let filename: string | null = null;
    let hasDocument = false;
    let namingDoc: DocumentForNaming | null = null;

    if (r.sourceType !== "pytr") {
      if (r.documentId && docById.has(r.documentId)) {
        const doc = docById.get(r.documentId)!;
        filename = doc.originalFilename;
        hasDocument = true;
        namingDoc = {
          id: r.documentId,
          mimeType: doc.mimeType,
          source: null,
          storedAt: r.createdAt,
          importId: null,
          transactionId: null,
        };
      } else if (r.importId && importDocById.has(r.importId)) {
        const doc = importDocById.get(r.importId)!;
        filename = doc.originalFilename;
        hasDocument = true;
        namingDoc = {
          id: doc.id,
          mimeType: doc.mimeType,
          source: null,
          storedAt: r.createdAt,
          importId: r.importId,
          transactionId: null,
        };
      }
    }

    const entry: SourceSummary = {
      id: r.id,
      sourceType: r.sourceType,
      externalId: r.externalId,
      orderRef: r.orderRef,
      documentId: r.documentId,
      taxComponents: r.taxComponents as TaxComponents | null,
      createdAt: r.createdAt,
      filename,
      hasDocument,
    };
    const bucket = out.get(r.transactionId);
    if (bucket) bucket.push(entry);
    else out.set(r.transactionId, [entry]);
    if (namingDoc)
      namingRequests.push({ entry, request: { doc: namingDoc, txId: r.transactionId } });
  }

  for (const d of docsRows) {
    if (!d.transactionId || d.status !== "retained" || claimedDocIds.has(d.id)) continue;
    const entry: SourceSummary = {
      id: `doc:${d.id}`,
      sourceType: "pdf",
      externalId: null,
      orderRef: null,
      documentId: d.id,
      taxComponents: null,
      createdAt: d.storedAt,
      filename: d.originalFilename,
      hasDocument: true,
    };
    const bucket = out.get(d.transactionId);
    if (bucket) bucket.push(entry);
    else out.set(d.transactionId, [entry]);
    namingRequests.push({
      entry,
      request: {
        doc: {
          id: d.id,
          mimeType: d.mimeType,
          source: null,
          storedAt: d.storedAt,
          importId: null,
          transactionId: d.transactionId,
        },
        txId: d.transactionId,
      },
    });
  }

  for (const { entry, request } of namingRequests) {
    try {
      const ctx = namingContextFor(request, namingMeta);
      entry.filename = buildDocumentName(computeNamingParts(request.doc, ctx));
    } catch {
      // Fallback: keep raw stored filename.
    }
  }

  return out;
}
