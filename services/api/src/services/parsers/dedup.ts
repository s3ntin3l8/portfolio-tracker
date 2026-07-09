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
 *  Deliberately narrow — `sell` is an acquisition's opposite, never a dedup peer.
 *  `bonus` is included so a perk-funded buy that one source collapses into a `bonus`
 *  free-share row still dedups against the same trade arriving as a plain `buy` from
 *  another source (CSV-collapsed bonus vs. live-synced buy of the same shares). */
const ACQUISITION_ACTIONS = new Set(["buy", "savings_plan", "bonus"]);

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

/** Parsers whose instruments carry ISINs and resolve via the EU/OpenFIGI path (DKB, Trade
 *  Republic, IBKR). Mirrors the `isEu` flag the confirm endpoint computes. */
export function isEuParser(parser: string): boolean {
  return (
    parser === "dkb" ||
    parser === "pytr" ||
    parser === "tr-csv" ||
    parser === "dkb-pdf" ||
    parser === "tr-pdf" ||
    parser === "ibkr"
  );
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
  // Dividend/coupon per-share display fields (see packages/db schema.ts). `perShare` and
  // `grossNative` are SUMMED like tax/fees — a single payment event can legitimately settle
  // across multiple documents (e.g. a split ordinary/return-of-capital distribution), each
  // covering the same shares; `shares`/`nativeCurrency` stay picked (each document reports the
  // full position / same currency, not a fraction of it — summing would double-count).
  perShare?: string | null;
  shares?: string | null;
  nativeCurrency?: string | null;
  grossNative?: string | null;
}

/**
 * Sum decimal strings exactly via scaled-integer (BigInt) arithmetic — unlike `sumField`'s
 * cents-rounding (fine for EUR tax/fees), this preserves full precision for values like an
 * 8-decimal-place per-share rate. Scales to the max fractional-digit count seen across the
 * inputs, adds as integers, then rescales back to a decimal string.
 */
function sumDecimalExact(values: string[]): string {
  let maxScale = 0;
  for (const v of values) {
    const dot = v.indexOf(".");
    if (dot >= 0) maxScale = Math.max(maxScale, v.length - dot - 1);
  }
  const factor = 10n ** BigInt(maxScale);
  let total = 0n;
  for (const raw of values) {
    const v = raw.trim();
    const neg = v.startsWith("-");
    const unsigned = neg ? v.slice(1) : v;
    const [intPart, fracPart = ""] = unsigned.split(".");
    const fracScaled = (fracPart + "0".repeat(maxScale)).slice(0, maxScale);
    const scaled = BigInt(intPart || "0") * factor + (maxScale > 0 ? BigInt(fracScaled || "0") : 0n);
    total += neg ? -scaled : scaled;
  }
  const sign = total < 0n ? "-" : "";
  const abs = total < 0n ? -total : total;
  const s = abs.toString().padStart(maxScale + 1, "0");
  const intStr = s.slice(0, s.length - maxScale) || "0";
  const fracStr = maxScale > 0 ? `.${s.slice(s.length - maxScale)}` : "";
  return `${sign}${intStr}${fracStr}`;
}

/**
 * Derive the gold-standard scalar rollup from a set of source rows.
 *
 * For each field:
 *  - Pick the **highest-rank** source type present that has a non-null value.
 *  - For `tax`, `fees`, `perShare`, `grossNative`: SUM across ALL rows of that winning rank
 *    (so multiple settlement documents for one event — split trade-order legs, or a dividend
 *    split across an ordinary + return-of-capital PDF — all contribute; a crucial correctness
 *    invariant). `perShare`/`grossNative` sum with full decimal precision (`sumDecimalExact`);
 *    `tax`/`fees` sum to cents (EUR amounts).
 *  - For `fxRate`: a grossNative-weighted average across rows of the winning rank (falls back
 *    to the first value when no row carries a positive weight) — summing an FX rate directly
 *    would be meaningless, but a gross-weighted average is the economically correct combined
 *    rate when two documents convert different native amounts.
 *  - For `executedPrice`, `venue`, `shares`, `nativeCurrency`: take the first/only value at the
 *    winning rank (they don't sum — see `SourceRow`'s field comments).
 *
 * Returns null on each field when no source row provides it.
 *
 * **`manual` protection:** if a `manual` source row exists, skip recomputing the
 * transaction's scalars entirely — the user's hand-edited values are authoritative.
 * (The caller checks this and skips the DB write for scalars when a manual row exists.)
 *
 * **No-regression invariant:** at most one row per economic component contributes at a given
 * rank unless a document is genuinely split — verified live against production data with zero
 * counterexamples before this summing was introduced. A normal single-document transaction has
 * exactly one non-null value at its winning rank, so SUM there is a no-op vs. the previous PICK.
 *
 * Idempotent and order-independent: re-running on the same source rows is a fixed point.
 */
export function recomputeRollup(rows: SourceRow[]): {
  tax: string | null;
  fees: string | null;
  executedPrice: string | null;
  fxRate: string | null;
  venue: string | null;
  perShare: string | null;
  shares: string | null;
  nativeCurrency: string | null;
  grossNative: string | null;
  hasManual: boolean;
  mergedTaxComponents: TaxComponents;
} {
  const hasManual = rows.some((r) => r.sourceType === "manual");

  type PickableField =
    | "tax"
    | "fees"
    | "executedPrice"
    | "fxRate"
    | "venue"
    | "perShare"
    | "shares"
    | "nativeCurrency"
    | "grossNative";

  // Find the winning rank for each scalar type.
  function winningRank(field: PickableField): number {
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

  /** Like `sumField`, but preserves full decimal precision (for perShare/grossNative). */
  function sumFieldExact(field: "perShare" | "grossNative", rank: number): string | null {
    if (rank < 0) return null;
    const values: string[] = [];
    for (const r of rows) {
      if ((SOURCE_RANK[r.sourceType] ?? 0) === rank && r[field] != null) values.push(r[field]!);
    }
    return values.length > 0 ? sumDecimalExact(values) : null;
  }

  function pickField(
    field: "executedPrice" | "venue" | "shares" | "nativeCurrency",
    rank: number,
  ): string | null {
    if (rank < 0) return null;
    for (const r of rows) {
      if ((SOURCE_RANK[r.sourceType] ?? 0) === rank && r[field] != null) return r[field]!;
    }
    return null;
  }

  /** grossNative-weighted average of fxRate across rows of the winning rank; falls back to the
   *  first fxRate value when no row at that rank carries a positive grossNative weight. */
  function fxRateField(rank: number): string | null {
    if (rank < 0) return null;
    let fallback: string | null = null;
    let weightedSum = 0;
    let weightTotal = 0;
    for (const r of rows) {
      if ((SOURCE_RANK[r.sourceType] ?? 0) !== rank || r.fxRate == null) continue;
      if (fallback === null) fallback = r.fxRate;
      const fx = parseFloat(r.fxRate);
      const weight = r.grossNative != null ? parseFloat(r.grossNative) : NaN;
      if (Number.isFinite(fx) && Number.isFinite(weight) && weight > 0) {
        weightedSum += fx * weight;
        weightTotal += weight;
      }
    }
    return weightTotal > 0 ? (weightedSum / weightTotal).toFixed(6) : fallback;
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
    fxRate: fxRateField(winningRank("fxRate")),
    venue: pickField("venue", winningRank("venue")),
    perShare: sumFieldExact("perShare", winningRank("perShare")),
    shares: pickField("shares", winningRank("shares")),
    nativeCurrency: pickField("nativeCurrency", winningRank("nativeCurrency")),
    grossNative: sumFieldExact("grossNative", winningRank("grossNative")),
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
