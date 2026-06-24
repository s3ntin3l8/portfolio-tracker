import type { TaxComponents } from "@portfolio/schema";

/**
 * Cross-source economic duplicate detection (#196, hardened in #217).
 *
 * The same real-world trade imported once as a CSV row and once as a PDF settlement
 * note must be recognised as one event even though the two sources disagree on the
 * incidental details. Measured against real DKB exports, the divergences are:
 *
 *   - **action label** — a savings-plan execution is `buy` in the Umsatzliste CSV but
 *     `savings_plan` in the Wertpapierabrechnung PDF. Same acquisition, two labels.
 *   - **calendar day** — one source carries the trade date, the other the settlement /
 *     value date, so the same buy lands a day apart (e.g. 2021-11-17 vs 2021-11-18).
 *   - **decimal precision / locale** — quantities and prices can differ in trailing
 *     precision, and German exports spell decimals with a comma (`74,506`).
 *
 * So instead of an exact string fingerprint (the old `economicFingerprint`, which keyed
 * on action + UTC day + canonicalised quantity/price and missed every case above), we
 * match **pairwise** within an identity group: same instrument identity, same action
 * *class*, day within ±1, and quantity/price within a small relative tolerance. Matching
 * is **count-aware** — each committed row is consumed by at most one draft — so two
 * legitimate same-day buys of *different* size stay distinct (they're orders of magnitude
 * apart, far outside tolerance) and only genuine repeats collapse.
 */

/** Relative tolerance for quantity/price equality (0.2%). Comfortably absorbs a
 *  precision/rounding divergence (`74.506` vs `74.51` is 0.005%) while keeping two
 *  genuinely different same-day buys (e.g. 1.3358 vs 3.1399 units) far apart. */
const REL_TOL = 0.002;
/** Absolute floor so sub-unit quantities/prices (a 0.34-unit fund buy) still match
 *  when their relative difference would otherwise be large. */
const ABS_TOL = 0.0005;
const DAY_MS = 86_400_000;

/** Acquisition actions that are the *same* economic event under different source labels.
 *  Deliberately narrow — `sell` is an acquisition's opposite, never a dedup peer. */
const ACQUISITION_ACTIONS = new Set(["buy", "savings_plan"]);

/** Collapse interchangeable action labels to a single class for matching. A DKB
 *  Umsatzliste row (`buy`) and the matching Wertpapierabrechnung PDF (`savings_plan`)
 *  describe one acquisition; everything else keys on its own action. */
export function actionClass(action: string): string {
  return ACQUISITION_ACTIONS.has(action) ? "acquire" : action;
}

/**
 * Parse a decimal that may use either an English (`.`) or German (`,`) decimal mark,
 * with optional thousands separators. Returns null when it isn't a finite number.
 *
 * Domain note: DKB Umsatzliste values are German (`74,50600000`); Trade Republic and the
 * PDF parser emit dot-decimals. When both marks are present the *last* one is the decimal
 * point; a lone comma is treated as the decimal mark (the German convention these files use).
 */
export function parseLooseDecimal(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  const hasDot = s.includes(".");
  const hasComma = s.includes(",");
  if (hasDot && hasComma) {
    const decimal = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
    const thousands = decimal === "." ? "," : ".";
    s = s.split(thousands).join("").replace(decimal, ".");
  } else if (hasComma) {
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Two decimal strings equal within tolerance. Falls back to a trimmed string compare
 *  when either side isn't a finite number, so non-numeric values still match exactly. */
export function decimalsClose(a: string, b: string): boolean {
  const x = parseLooseDecimal(a);
  const y = parseLooseDecimal(b);
  if (x === null || y === null) return String(a).trim() === String(b).trim();
  const diff = Math.abs(x - y);
  return diff <= ABS_TOL || diff <= REL_TOL * Math.max(Math.abs(x), Math.abs(y));
}

function dayIndex(d: Date | string): number {
  const date = d instanceof Date ? d : new Date(d);
  return Math.floor(date.getTime() / DAY_MS);
}

/** Same calendar day or adjacent (±1), absorbing trade-date vs settlement-date skew. */
export function withinDayTolerance(a: Date | string, b: Date | string): boolean {
  return Math.abs(dayIndex(a) - dayIndex(b)) <= 1;
}

/**
 * Map an import parser tag to the `transactions.source` value that would be written for it.
 * Mirrors the mapping in the confirm endpoint (imports.ts), kept here for shared use by the
 * preview endpoint and the upload-time annotator.
 */
export function parserToTxSource(parser: string): string {
  if (parser === "pytr") return "pytr";
  if (parser === "ibkr") return "ibkr";
  if (parser === "dkb-pdf" || parser === "tr-pdf") return "pdf";
  if (parser === "csv" || parser === "dkb" || parser === "tr-csv") return "csv";
  return "screenshot";
}

/**
 * Classify a cross-source economic match as **enrichment** or **duplicate**.
 *
 * Enrichment: the incoming import is from a *different* source than the committed transaction
 * **and** it brings new value (the import is a file upload carrying a document, or the draft
 * carries `taxComponents` — i.e. it's a richer PDF than a plain CSV row). Enrichment is
 * auto-applied at confirm time (links the PDF, folds in tax/fees) without a blocking 409.
 *
 * Duplicate: same source as the committed row, or no new value. These block at confirm time
 * so the user consciously decides whether to import or discard.
 */
export function classifyMatch(
  importParser: string,
  matchedTxSource: string,
  draftHasEnrichment: boolean,
): "enrichment" | "duplicate" {
  const incomingTxSource = parserToTxSource(importParser);
  if (incomingTxSource !== matchedTxSource && draftHasEnrichment) {
    return "enrichment";
  }
  return "duplicate";
}

/** A record reduced to the fields that decide economic identity. `key` is the caller's
 *  instrument identity: the resolved `instrumentId` at confirm time, or an ISIN/WKN at
 *  upload time (before instruments are resolved). */
export interface DedupCandidate {
  key: string | null | undefined;
  action: string;
  quantity: string;
  price: string;
  executedAt: Date | string;
}

/**
 * Match each draft against an already-committed record economically, count-aware. Returns
 * one entry per draft that matches a distinct committed record (greedy: each committed
 * record is consumed once). Generic over the committed type so callers get their own
 * payload back (source + executedAt at upload, source + externalId at confirm).
 */
export function findCrossSourceDuplicates<C extends DedupCandidate>(
  drafts: DedupCandidate[],
  committed: C[],
): Array<{ draftIndex: number; matched: C }> {
  const groups = new Map<string, C[]>();
  for (const c of committed) {
    if (!c.key) continue; // cash legs / unresolved instruments have no identity
    const g = `${c.key}|${actionClass(c.action)}`;
    let bucket = groups.get(g);
    if (!bucket) groups.set(g, (bucket = []));
    bucket.push(c);
  }

  const out: Array<{ draftIndex: number; matched: C }> = [];
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    if (!d.key) continue;
    const bucket = groups.get(`${d.key}|${actionClass(d.action)}`);
    if (!bucket || bucket.length === 0) continue;
    const idx = bucket.findIndex(
      (c) =>
        decimalsClose(c.quantity, d.quantity) &&
        decimalsClose(c.price, d.price) &&
        withinDayTolerance(c.executedAt, d.executedAt),
    );
    if (idx >= 0) {
      out.push({ draftIndex: i, matched: bucket[idx] });
      bucket.splice(idx, 1); // consume — a committed row dedups at most one draft
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Multi-source rollup & aggregation helpers (issue #230)
// ---------------------------------------------------------------------------

/** Richness rank used by recomputeRollup. Higher = wins over lower. */
const SOURCE_RANK: Record<string, number> = {
  manual: 100,
  pdf: 40,
  pytr: 30,
  ibkr: 25, // IBKR Flex XML: richer than plain CSV but no settlement PDFs
  csv: 20,
  screenshot: 10,
};

/** A source row that can contribute to a rollup (from transaction_sources or a draft). */
export interface SourceRow {
  sourceType: string;
  tax?: string | null;
  fees?: string | null;
  executedPrice?: string | null;
  fxRate?: string | null;
  venue?: string | null;
  taxComponents?: TaxComponents | null;
}

/**
 * Derive the gold-standard scalar rollup from a set of source rows.
 *
 * For each field (tax, fees, executedPrice, fxRate, venue):
 *  - Pick the **highest-rank** source type present that has a non-null value.
 *  - For `tax` and `fees`: SUM across ALL rows of that winning rank (so both legs of a
 *    split order's settlement PDFs both contribute — a crucial correctness invariant).
 *  - For `executedPrice`, `fxRate`, `venue`: take the first/only value (they don't sum).
 *
 * Returns null on each field when no source row provides it.
 *
 * **`manual` protection:** if a `manual` source row exists, skip recomputing the
 * transaction's scalars entirely — the user's hand-edited values are authoritative.
 * (The caller checks this and skips the DB write for scalars when a manual row exists.)
 *
 * Idempotent and order-independent: re-running on the same source rows is a fixed point.
 */
export function recomputeRollup(rows: SourceRow[]): {
  tax: string | null;
  fees: string | null;
  executedPrice: string | null;
  fxRate: string | null;
  venue: string | null;
  hasManual: boolean;
  mergedTaxComponents: TaxComponents;
} {
  const hasManual = rows.some((r) => r.sourceType === "manual");

  // Find the winning rank for each scalar type.
  function winningRank(field: keyof Pick<SourceRow, "tax" | "fees" | "executedPrice" | "fxRate" | "venue">): number {
    return rows.reduce((best, r) => {
      const rank = SOURCE_RANK[r.sourceType] ?? 0;
      return r[field] != null && rank > best ? rank : best;
    }, -1);
  }

  function sumField(field: "tax" | "fees", rank: number): string | null {
    if (rank < 0) return null;
    let cents = 0;
    let found = false;
    for (const r of rows) {
      if ((SOURCE_RANK[r.sourceType] ?? 0) === rank && r[field] != null) {
        const n = parseFloat(r[field]!);
        if (Number.isFinite(n)) { cents += Math.round(n * 100); found = true; }
      }
    }
    return found ? (cents / 100).toFixed(2) : null;
  }

  function pickField(field: "executedPrice" | "fxRate" | "venue", rank: number): string | null {
    if (rank < 0) return null;
    for (const r of rows) {
      if ((SOURCE_RANK[r.sourceType] ?? 0) === rank && r[field] != null) return r[field]!;
    }
    return null;
  }

  // Merge taxComponents across all rows (union — later rows clobber earlier for same key).
  const mergedTaxComponents: TaxComponents = {};
  for (const r of rows) {
    if (r.taxComponents) {
      Object.assign(mergedTaxComponents, r.taxComponents);
    }
  }

  return {
    tax: sumField("tax", winningRank("tax")),
    fees: sumField("fees", winningRank("fees")),
    executedPrice: pickField("executedPrice", winningRank("executedPrice")),
    fxRate: pickField("fxRate", winningRank("fxRate")),
    venue: pickField("venue", winningRank("venue")),
    hasManual,
    mergedTaxComponents,
  };
}

// NOTE: aggregateByOrderRef was removed (fix 4.2).
// A TR split order (two settlement PDFs, same AUFTRAG/different AUSFÜHRUNG) imports as two
// separate transactions. This is CORRECT — each PDF represents a real settlement (fills at
// different prices/quantities). `packages/core` derives P&L per-transaction, so two legs =
// two real fills = correct cost basis and realized gain.
// The function was never wired into the confirm pipeline (see enrichment.ts, intentionally
// not called). It is removed here to prevent stale "pipeline" documentation from implying
// it runs. If combined timeline rows become desirable in the future, the implementation
// history is available in git. The `orderRef` field remains on `transaction_sources` for
// bookkeeping.
