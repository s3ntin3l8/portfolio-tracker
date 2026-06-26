import { eq } from "drizzle-orm";
import { instruments, transactions } from "@portfolio/db";
import type { ParsedTransaction } from "@portfolio/schema";
import type { DB } from "../../db/client.js";
import { findCrossSourceDuplicates } from "./dedup.js";

/** Best-effort instrument identity for upload-time dedup, before instruments are resolved:
 *  prefer ISIN, then WKN, then a normalised name. Returns null when nothing is available.
 *  Internal to the dedup pass — both the upload-time annotator and the /duplicates preview
 *  route go through {@link findCommittedDuplicates}, so neither route needs this directly. */
function uploadIdentity(
  isin: string | null | undefined,
  wkn: string | null | undefined,
  name: string | null | undefined,
): string | null {
  if (isin) return `isin:${isin.trim().toUpperCase()}`;
  if (wkn) return `wkn:${wkn.trim().toUpperCase()}`;
  const n = (name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return n ? `name:${n}` : null;
}

/** A committed transaction reduced to what the dedup pass and its callers need: the dedup
 *  fields {@link findCrossSourceDuplicates} matches on, plus `id`/`source`/`executedAt`
 *  which both callers read back off the matched row. */
interface CommittedTx {
  id: string;
  key: string | null;
  action: string;
  quantity: string;
  price: string;
  executedAt: Date | string;
  source: string | null;
}

/**
 * Find drafts that economically match transactions already committed to `portfolioId`
 * (#196 cross-format dedup, hardened in #217). Shared by the upload-time annotator
 * (`annotateLikelyDuplicates`, imports/parse.ts) and the `/duplicates` preview route
 * (imports.ts) — the instruments-joined query, the identity-keyed candidate construction,
 * and the count-aware match are identical between them, so they live here once.
 *
 * Instruments aren't resolved at upload time, so identity falls back to ISIN → WKN →
 * normalised name (see {@link uploadIdentity}). Each committed row is consumed by at most
 * one draft (count-aware). Returns one entry per matched draft; the caller decides how to
 * classify (`enrichment` vs `duplicate`) and what to do with each match.
 */
export async function findCommittedDuplicates(
  dbClient: DB,
  portfolioId: string,
  drafts: ParsedTransaction[],
): Promise<Array<{ draftIndex: number; matched: CommittedTx }>> {
  if (drafts.length === 0) return [];

  const rows = await dbClient
    .select({
      id: transactions.id,
      type: transactions.type,
      executedAt: transactions.executedAt,
      quantity: transactions.quantity,
      price: transactions.price,
      source: transactions.source,
      isin: instruments.isin,
      wkn: instruments.wkn,
      name: instruments.name,
    })
    .from(transactions)
    .leftJoin(instruments, eq(instruments.id, transactions.instrumentId))
    .where(eq(transactions.portfolioId, portfolioId));

  const committed: CommittedTx[] = rows.map((r) => ({
    id: r.id,
    key: uploadIdentity(r.isin, r.wkn, r.name),
    action: r.type,
    quantity: r.quantity,
    price: r.price,
    executedAt: r.executedAt,
    source: r.source,
  }));
  const draftCandidates = drafts.map((d) => ({
    key: uploadIdentity(d.isin, d.wkn, d.name),
    action: d.action,
    quantity: d.quantity,
    price: d.price,
    executedAt: d.executedAt,
  }));

  return findCrossSourceDuplicates(draftCandidates, committed);
}
