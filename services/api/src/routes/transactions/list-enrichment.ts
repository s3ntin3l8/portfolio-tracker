import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { Decimal } from "decimal.js";
import { and, eq, inArray } from "drizzle-orm";
import { documents, transactionSources, transactions } from "@portfolio/db";
import { buildShareTimelines, sharesHeldAt } from "@portfolio/core";
import { logTiming } from "../../lib/timing.js";
import { getFxRatesForDates } from "../../services/fx.js";
import { toCoreTxns } from "../../services/tx-core.js";
import { sourcesFromPreFetched, txFlagsFromSourcesRows } from "../../services/enrichment.js";
import { corporateActionsFor, instrumentMeta } from "./shared.js";

export async function deriveIncomeShares(
  app: FastifyInstance,
  rowsByPortfolio: Map<string, (typeof transactions.$inferSelect)[]>,
): Promise<
  Map<string, { perShare: string | null; shares: string | null; sharesEstimated: true }>
> {
  const patch = new Map<
    string,
    { perShare: string | null; shares: string | null; sharesEstimated: true }
  >();

  const isCandidate = (r: (typeof transactions.$inferSelect)) =>
    r.type === "dividend" && r.instrumentId !== null && (r.perShare === null || r.shares === null);

  const portfolioIdsNeeded = [...rowsByPortfolio.entries()]
    .filter(([, rows]) => rows.some(isCandidate))
    .map(([portfolioId]) => portfolioId);
  if (portfolioIdsNeeded.length === 0) return patch;

  const historyRows = await app.db
    .select()
    .from(transactions)
    .where(inArray(transactions.portfolioId, portfolioIdsNeeded));
  const historyByPortfolio = new Map<string, (typeof transactions.$inferSelect)[]>();
  for (const r of historyRows) {
    const list = historyByPortfolio.get(r.portfolioId) ?? [];
    list.push(r);
    historyByPortfolio.set(r.portfolioId, list);
  }

  for (const portfolioId of portfolioIdsNeeded) {
    const coreTxns = toCoreTxns(historyByPortfolio.get(portfolioId) ?? []);
    const cas = await corporateActionsFor(app, coreTxns.map((t) => t.instrumentId));
    const timelines = buildShareTimelines(coreTxns, cas);

    const candidates = (rowsByPortfolio.get(portfolioId) ?? []).filter(isCandidate);
    for (const r of candidates) {
      const sharesDec =
        r.shares !== null ? new Decimal(r.shares) : sharesHeldAt(timelines, r.instrumentId!, r.executedAt);
      if (!sharesDec || sharesDec.lte(0)) continue;
      let perShare = r.perShare;
      if (perShare === null) {
        const gross = new Decimal(r.price).plus(r.tax !== null ? new Decimal(r.tax) : 0);
        perShare = gross.div(sharesDec).toString();
      }
      patch.set(r.id, { shares: r.shares ?? sharesDec.toString(), perShare, sharesEstimated: true });
    }
  }

  return patch;
}

export async function enrichRows(
  app: FastifyInstance,
  rows: typeof transactions.$inferSelect[],
  total: number,
  summary: { totalInvested: string; totalProceeds: string; totalIncome: string } | undefined,
  portfolioName: string,
  portfolioId: string,
  convertTo: string | undefined,
  paginate: boolean,
  page: number,
  log: FastifyBaseLogger,
) {
  const t0 = performance.now();
  const allImportIds = rows
    .map((r) => r.importId)
    .filter((x): x is string => x !== null);
  const allTxIds = rows.map((r) => r.id);
  const enrichStart = performance.now();
  let instrMs = 0;
  let sourcesMs = 0;
  let docsTxMs = 0;
  let docsImpMs = 0;
  const [meta, sourcesRows, docsByTx, docsByImport] = await Promise.all([
    (async () => {
      const s = performance.now();
      const r = await instrumentMeta(app, rows.map((r) => r.instrumentId));
      instrMs = performance.now() - s;
      return r;
    })(),
    (async () => {
      const s = performance.now();
      const r = await app.db
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
          confidence: transactionSources.confidence,
        })
        .from(transactionSources)
        .where(inArray(transactionSources.transactionId, allTxIds));
      sourcesMs = performance.now() - s;
      return r;
    })(),
    (async () => {
      const s = performance.now();
      const r = await app.db
        .select({
          id: documents.id,
          transactionId: documents.transactionId,
          importId: documents.importId,
          status: documents.status,
          originalFilename: documents.originalFilename,
          mimeType: documents.mimeType,
          storedAt: documents.storedAt,
        })
        .from(documents)
        .where(
          and(
            eq(documents.status, "retained"),
            inArray(documents.transactionId, allTxIds),
          ),
        );
      docsTxMs = performance.now() - s;
      return r;
    })(),
    allImportIds.length > 0
      ? (async () => {
          const s = performance.now();
          const r = await app.db
            .select({
              id: documents.id,
              transactionId: documents.transactionId,
              importId: documents.importId,
              status: documents.status,
              originalFilename: documents.originalFilename,
              mimeType: documents.mimeType,
              storedAt: documents.storedAt,
            })
            .from(documents)
            .where(
              and(
                eq(documents.status, "retained"),
                inArray(documents.importId, allImportIds),
              ),
            );
          docsImpMs = performance.now() - s;
          return r;
        })()
      : [],
  ]);
  const docsRows = docsByTx.concat(docsByImport);

  const { needsReview, fullTaxDetail } = txFlagsFromSourcesRows(sourcesRows);
  const importIdsWithDocs = new Set(
    docsRows
      .map((r) => r.importId)
      .filter((x): x is string => x !== null),
  );
  const txIdsWithDocs = new Set(
    docsRows
      .map((r) => r.transactionId)
      .filter((x): x is string => x !== null),
  );
  const importMinDateById = new Map<string, Date>();
  for (const r of rows) {
    if (r.importId && (!importMinDateById.has(r.importId) || r.executedAt < importMinDateById.get(r.importId)!)) {
      importMinDateById.set(r.importId, r.executedAt);
    }
  }
  const sourcesMap = sourcesFromPreFetched(
    sourcesRows,
    docsRows,
    rows,
    meta,
    portfolioName,
    importMinDateById,
  );
  const tD = performance.now();

  let ratesByDate: Map<string, Record<string, string>> | undefined;
  if (convertTo) {
    const currencies = [...new Set(rows.map((r) => r.currency))];
    const dates = [...new Set(rows.map((r) => r.executedAt.toISOString().slice(0, 10)))];
    ratesByDate = await getFxRatesForDates(app.db, currencies, convertTo, dates);
  }
  const tE = performance.now();

  const incomeSharesPatch = await deriveIncomeShares(
    app,
    new Map([[portfolioId, rows]]),
  );

  const responseRows = rows.map((r) => {
    let displayRate: string | undefined;
    if (ratesByDate && convertTo) {
      const date = r.executedAt.toISOString().slice(0, 10);
      const rates = ratesByDate.get(date) ?? {};
      displayRate = r.currency === convertTo ? "1" : (rates[r.currency] ?? "1");
    }
    return {
      ...r,
      instrument: r.instrumentId ? (meta.get(r.instrumentId) ?? null) : null,
      hasDocument:
        txIdsWithDocs.has(r.id) ||
        (r.importId ? importIdsWithDocs.has(r.importId) : false),
      hasFullTaxDetail: fullTaxDetail.has(r.id),
      needsReview: needsReview.has(r.id),
      sources: sourcesMap.get(r.id) ?? [],
      ...(incomeSharesPatch.get(r.id) ?? {}),
      ...(displayRate
        ? { displayCurrency: convertTo, displayRate }
        : {}),
    };
  });

  const durationMs = performance.now() - t0;
  logTiming({ log }, "GET /portfolios/:id/transactions", durationMs, {
    portfolioId,
    transactionCount: responseRows.length,
    total: paginate ? total : undefined,
    page: paginate ? page : undefined,
    hasFxConversion: !!convertTo,
    enrichMs: tD - enrichStart,
    instrMs: Math.round(instrMs * 100) / 100,
    sourcesMs: Math.round(sourcesMs * 100) / 100,
    docsTxMs: Math.round(docsTxMs * 100) / 100,
    docsImpMs: Math.round(docsImpMs * 100) / 100,
    enrichPhase2Ms: Math.round((tD - enrichStart - Math.max(instrMs, sourcesMs, docsTxMs, docsImpMs)) * 100) / 100,
    fxMs: tE - tD,
    mapMs: performance.now() - tE,
  });

  return { rows: responseRows, total, summary };
}

export async function enrichAggregateRows(
  app: FastifyInstance,
  rows: typeof transactions.$inferSelect[],
  nameById: Map<string, string>,
  log: FastifyBaseLogger,
) {
  const tB = performance.now();
  const allImportIds = rows.map((r) => r.importId).filter((x): x is string => x !== null);
  const allTxIds = rows.map((r) => r.id);
  const enrichStart = performance.now();

  const meta = await instrumentMeta(app, rows.map((r) => r.instrumentId).filter((x): x is string => x !== null));
  const instrMs = performance.now() - enrichStart;

  const [sourcesRows, docsByTx, docsByImport] = await Promise.all([
    app.db
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
        confidence: transactionSources.confidence,
      })
      .from(transactionSources)
      .where(inArray(transactionSources.transactionId, allTxIds)),
    app.db
      .select()
      .from(documents)
      .where(and(inArray(documents.transactionId, allTxIds), eq(documents.status, "retained"))),
    app.db
      .select()
      .from(documents)
      .where(and(inArray(documents.importId, allImportIds), eq(documents.status, "retained"))),
  ]);
  const sourcesMs = performance.now() - (enrichStart + instrMs);

  const docsRows = docsByTx.concat(docsByImport);
  const importIdsWithDocs = new Set(docsRows.map((r) => r.importId).filter((x): x is string => x !== null));
  const txIdsWithDocs = new Set(docsRows.map((r) => r.transactionId).filter((x): x is string => x !== null));

  const importMinDateById = new Map<string, Date>();
  for (const r of rows) {
    if (r.importId && (!importMinDateById.has(r.importId) || r.executedAt < importMinDateById.get(r.importId)!)) {
      importMinDateById.set(r.importId, r.executedAt);
    }
  }

  const sourcesMap = sourcesFromPreFetched(
    sourcesRows,
    docsRows,
    rows,
    meta,
    null,
    importMinDateById,
  );

  const phase2Ms = performance.now() - (tB + sourcesMs + instrMs);
  logTiming({ log }, "enrichAggregateRows", performance.now() - tB, {
    rowCount: rows.length,
    instrMs: Math.round(instrMs * 100) / 100,
    sourcesMs: Math.round(sourcesMs * 100) / 100,
    phase2Ms: Math.round(phase2Ms * 100) / 100,
  });

  const { needsReview, fullTaxDetail } = txFlagsFromSourcesRows(sourcesRows);

  const rowsByPortfolio = new Map<string, typeof transactions.$inferSelect[]>();
  for (const r of rows) {
    const list = rowsByPortfolio.get(r.portfolioId) ?? [];
    list.push(r);
    rowsByPortfolio.set(r.portfolioId, list);
  }
  const incomeSharesPatch = await deriveIncomeShares(app, rowsByPortfolio);

  return rows.map((r) => ({
    ...r,
    instrument: meta.get(r.instrumentId ?? "") ?? null,
    sources: sourcesMap.get(r.id) ?? [],
    hasSources: (sourcesMap.get(r.id)?.length ?? 0) > 0,
    needsReview: needsReview.has(r.id),
    fullTaxDetail: fullTaxDetail.has(r.id),
    documentRetained: txIdsWithDocs.has(r.id) || (r.importId != null && importIdsWithDocs.has(r.importId)),
    portfolioName: nameById.get(r.portfolioId) ?? "",
    ...(incomeSharesPatch.get(r.id) ?? {}),
  }));
}
