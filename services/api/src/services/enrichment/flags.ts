import { inArray } from "drizzle-orm";
import { transactionSources } from "@portfolio/db";
import { LOW_CONFIDENCE_THRESHOLD } from "@portfolio/schema";
import { dbHelper, type AppLike } from "./core.js";

export async function txFlagsFromSources(
  app: AppLike,
  txIds: string[],
  threshold = LOW_CONFIDENCE_THRESHOLD,
): Promise<{ needsReview: Set<string>; fullTaxDetail: Set<string> }> {
  if (txIds.length === 0) return { needsReview: new Set(), fullTaxDetail: new Set() };
  const rows = await dbHelper(app)
    .select({
      transactionId: transactionSources.transactionId,
      confidence: transactionSources.confidence,
      taxComponents: transactionSources.taxComponents,
    })
    .from(transactionSources)
    .where(inArray(transactionSources.transactionId, txIds));

  const needsReview = new Set<string>();
  const fullTaxDetail = new Set<string>();
  for (const r of rows) {
    if (r.confidence != null && Number(r.confidence) < threshold) {
      needsReview.add(r.transactionId);
    }
    if (r.taxComponents != null && Object.keys(r.taxComponents as object).length > 0) {
      fullTaxDetail.add(r.transactionId);
    }
  }
  return { needsReview, fullTaxDetail };
}

export async function txIdsNeedingReview(
  app: AppLike,
  txIds: string[],
  threshold = LOW_CONFIDENCE_THRESHOLD,
): Promise<Set<string>> {
  if (txIds.length === 0) return new Set();
  const rows = await dbHelper(app)
    .select({
      transactionId: transactionSources.transactionId,
      confidence: transactionSources.confidence,
    })
    .from(transactionSources)
    .where(inArray(transactionSources.transactionId, txIds));
  return new Set(
    rows
      .filter((r) => r.confidence != null && Number(r.confidence) < threshold)
      .map((r) => r.transactionId),
  );
}

export async function txIdsWithFullTaxDetail(app: AppLike, txIds: string[]): Promise<Set<string>> {
  if (txIds.length === 0) return new Set();

  const rows = await dbHelper(app)
    .select({
      transactionId: transactionSources.transactionId,
      taxComponents: transactionSources.taxComponents,
    })
    .from(transactionSources)
    .where(inArray(transactionSources.transactionId, txIds));

  return new Set(
    rows
      .filter((r) => r.taxComponents != null && Object.keys(r.taxComponents as object).length > 0)
      .map((r) => r.transactionId),
  );
}

export function txFlagsFromSourcesRows(
  sourcesRows: { transactionId: string; confidence: string | null; taxComponents: unknown }[],
  threshold = LOW_CONFIDENCE_THRESHOLD,
): { needsReview: Set<string>; fullTaxDetail: Set<string> } {
  const needsReview = new Set<string>();
  const fullTaxDetail = new Set<string>();
  for (const r of sourcesRows) {
    if (r.confidence != null && Number(r.confidence) < threshold) {
      needsReview.add(r.transactionId);
    }
    if (r.taxComponents != null && Object.keys(r.taxComponents as object).length > 0) {
      fullTaxDetail.add(r.transactionId);
    }
  }
  return { needsReview, fullTaxDetail };
}
