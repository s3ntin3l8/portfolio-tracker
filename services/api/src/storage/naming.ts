/**
 * Structured document naming — the single source of truth for all three surfaces:
 *   1. App download filename (Content-Disposition returned by document-url endpoints)
 *   2. Bucket storage keys (applied at confirm time in finalizeReceipts)
 *   3. Bulk zip archive entry names (GET /portfolios/:id/documents/export)
 *
 * Two scopes:
 *   - "transaction" — the doc is linked to exactly one transaction (TR postbox docs).
 *     Name: `{YYYY-MM-DD}_{portfolioSlug}_{type}_{symbol}{ext}`
 *     Key:  `receipts/{userId}/{portfolioSlug}/{YYYY}/{date}_{type}_{symbol}_{shortId}{ext}`
 *
 *   - "statement" — the doc covers many transactions (DKB/CSV/screenshot imports) or
 *     the transaction link is not available.
 *     Name: `{YYYY-MM}_{portfolioSlug}_statement_{source}{ext}`
 *     Key:  `receipts/{userId}/{portfolioSlug}/{period}_statement_{source}_{shortId}{ext}`
 *
 * `shortId` = first 8 chars of the document UUID — keeps keys unique without being opaque.
 */

import { eq, inArray, min } from "drizzle-orm";
import { transactions, portfolios, instruments } from "@portfolio/db";
import type { FastifyInstance } from "fastify";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "@portfolio/db";

// ---- Types ------------------------------------------------------------------

export type NamingScope = "transaction" | "statement";

export interface TransactionNamingParts {
  scope: "transaction";
  portfolioSlug: string;
  date: string;     // YYYY-MM-DD
  year: string;     // YYYY (derived from date — kept to avoid re-parsing)
  type: string;     // buy | sell | dividend | …
  symbol: string;   // instrument ticker
  ext: string;      // .pdf | .png | …
  docId: string;    // first 8 chars of document uuid
}

export interface StatementNamingParts {
  scope: "statement";
  portfolioSlug: string;
  period: string;   // YYYY-MM
  source: string;   // friendly source label (see SOURCE_LABELS)
  ext: string;
  docId: string;
}

export type NamingParts = TransactionNamingParts | StatementNamingParts;

// ---- Helpers ----------------------------------------------------------------

/**
 * Friendly source label for the statement scope.
 * `pytr` → `tr`, vision-based parsers → `screenshot`, everything else verbatim.
 */
const SOURCE_LABELS: Record<string, string> = {
  pytr: "tr",
  "tr-csv": "tr",
  claude: "screenshot",
  ollama: "screenshot",
  gemini: "screenshot",
  openrouter: "screenshot",
};

function friendlySource(source: string | null | undefined): string {
  if (!source) return "document";
  return SOURCE_LABELS[source] ?? source;
}

/**
 * Sanitise a single name segment (portfolio slug, symbol, type …):
 *   - Trim whitespace
 *   - Replace runs of non-alphanumeric chars (except `-`) with a single `-`
 *   - Collapse leading/trailing hyphens
 *   - Cap at 64 chars
 *
 * Distinct from `sanitiseFilename` in receipts.ts (which targets a whole path basename).
 */
export function slug(s: string): string {
  return s
    .trim()
    .replace(/[^\w-]+/g, "-")   // non-word runs → single hyphen
    .replace(/-{2,}/g, "-")     // collapse runs of hyphens
    .replace(/^-+|-+$/g, "")   // strip leading/trailing
    .slice(0, 64)
    || "document";
}

/** Extension derived from mimeType. Exported for use in receipts.ts. */
export function extFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    "application/pdf": ".pdf",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "text/csv": ".csv",
    "text/plain": ".txt",
  };
  return map[mimeType] ?? "";
}

// ---- Name / key builders -----------------------------------------------------

/**
 * Build the user-facing download filename from naming parts.
 *
 * Examples:
 *   transaction → `2024-03-15_Mandiri-Sekuritas_buy_BBCA.pdf`
 *   statement   → `2024-03_DKB-Depot_statement_dkb.pdf`
 */
export function buildDocumentName(parts: NamingParts): string {
  if (parts.scope === "transaction") {
    const { date, portfolioSlug, type, symbol, ext } = parts;
    return `${date}_${portfolioSlug}_${slug(type)}_${symbol}${ext}`;
  }
  const { period, portfolioSlug, source, ext } = parts;
  return `${period}_${portfolioSlug}_statement_${source}${ext}`;
}

/**
 * Build the structured bucket storage key from naming parts.
 * Always unique because `shortDocId` (first 8 chars of doc uuid) is appended.
 *
 * Examples:
 *   transaction → `receipts/{uid}/Mandiri-Sekuritas/2024/2024-03-15_buy_BBCA_a1b2c3d4.pdf`
 *   statement   → `receipts/{uid}/DKB-Depot/2024-03_statement_dkb_a1b2c3d4.pdf`
 */
export function buildStructuredKey(userId: string, parts: NamingParts): string {
  if (parts.scope === "transaction") {
    const { portfolioSlug, year, date, type, symbol, docId, ext } = parts;
    return `receipts/${userId}/${portfolioSlug}/${year}/${date}_${slug(type)}_${symbol}_${docId}${ext}`;
  }
  const { portfolioSlug, period, source, docId, ext } = parts;
  return `receipts/${userId}/${portfolioSlug}/${period}_statement_${source}_${docId}${ext}`;
}

// ---- Metadata resolution ----------------------------------------------------

type AppLikeDb = Pick<FastifyInstance, "db">;

function db(app: AppLikeDb): PostgresJsDatabase<typeof schema> {
  return app.db as PostgresJsDatabase<typeof schema>;
}

export interface DocumentForNaming {
  id: string;
  mimeType: string;
  source: string | null;
  storedAt: Date;
  importId: string | null;
  transactionId: string | null;
}

/** A document plus an optional explicit transaction scope (per-leg download endpoints). */
export interface NamingRequest {
  doc: DocumentForNaming;
  /** Force "transaction" scope for this tx even when `doc.transactionId` is null. */
  txId?: string;
}

/** Pre-resolved inputs `computeNamingParts` needs — no DB access. */
export interface NamingContext {
  portfolioName: string | null;
  /** The resolved transaction for the doc's effective tx id, or null ⇒ statement scope. */
  tx: { type: string; executedAt: Date; instrumentId: string | null } | null;
  /** The resolved instrument ticker for `tx.instrumentId`, if the instrument exists. */
  instrumentSymbol: string | null;
  /** Earliest `executedAt` across the doc's import (statement scope), if any. */
  importMinDate: Date | null;
}

/**
 * Pure naming logic — given the document and its pre-resolved context, produce the
 * `NamingParts`. No DB access, so it's trivially testable and callable in a batch loop.
 * Transaction scope when a linked transaction exists; statement scope otherwise.
 */
export function computeNamingParts(doc: DocumentForNaming, ctx: NamingContext): NamingParts {
  const ext = extFromMime(doc.mimeType);
  const shortId = doc.id.replace(/-/g, "").slice(0, 8);
  const portfolioSlug = ctx.portfolioName ? slug(ctx.portfolioName) : "portfolio";

  if (ctx.tx) {
    // Transaction scope: type + executedAt + instrument symbol.
    const symbol =
      ctx.tx.instrumentId && ctx.instrumentSymbol ? slug(ctx.instrumentSymbol) : "unknown";
    const dt = ctx.tx.executedAt;
    const date = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
    return {
      scope: "transaction",
      portfolioSlug,
      date,
      year: String(dt.getUTCFullYear()),
      type: ctx.tx.type,
      symbol,
      ext,
      docId: shortId,
    };
  }

  // Statement scope: period from the earliest transaction in this import, else storedAt.
  const dt = (doc.importId ? ctx.importMinDate : null) ?? doc.storedAt;
  const d = new Date(dt);
  const period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return {
    scope: "statement",
    portfolioSlug,
    period,
    source: friendlySource(doc.source),
    ext,
    docId: shortId,
  };
}

/** Batch-resolved metadata for a set of naming requests sharing one portfolio. */
export interface DocumentNamingMetadata {
  portfolioName: string | null;
  txById: Map<string, { type: string; executedAt: Date; instrumentId: string | null }>;
  instrumentSymbolById: Map<string, string>;
  importMinDateById: Map<string, Date>;
}

/**
 * Resolve the naming metadata for many documents at once — a fixed number of queries
 * (portfolio name, transactions, instruments, import min-dates) regardless of how many
 * documents are passed. Replaces the per-document query waterfall when naming a batch
 * (e.g. `finalizeReceipts` re-keying every staged doc of an import).
 */
export async function gatherDocumentMetadata(
  app: AppLikeDb,
  requests: NamingRequest[],
  portfolioId: string,
): Promise<DocumentNamingMetadata> {
  const [portfolio] = await db(app)
    .select({ name: portfolios.name })
    .from(portfolios)
    .where(eq(portfolios.id, portfolioId))
    .limit(1);
  const portfolioName = portfolio?.name ?? null;

  const txById = new Map<string, { type: string; executedAt: Date; instrumentId: string | null }>();
  const instrumentSymbolById = new Map<string, string>();
  const importMinDateById = new Map<string, Date>();

  const effectiveTxIds = [
    ...new Set(
      requests
        .map((r) => r.txId ?? r.doc.transactionId)
        .filter((x): x is string => x != null),
    ),
  ];
  if (effectiveTxIds.length > 0) {
    const txRows = await db(app)
      .select({
        id: transactions.id,
        type: transactions.type,
        executedAt: transactions.executedAt,
        instrumentId: transactions.instrumentId,
      })
      .from(transactions)
      .where(inArray(transactions.id, effectiveTxIds));
    for (const tx of txRows) {
      txById.set(tx.id, { type: tx.type, executedAt: tx.executedAt, instrumentId: tx.instrumentId });
    }

    const instrumentIds = [
      ...new Set(
        txRows.map((tx) => tx.instrumentId).filter((x): x is string => x != null),
      ),
    ];
    if (instrumentIds.length > 0) {
      const instRows = await db(app)
        .select({ id: instruments.id, symbol: instruments.symbol })
        .from(instruments)
        .where(inArray(instruments.id, instrumentIds));
      for (const inst of instRows) instrumentSymbolById.set(inst.id, inst.symbol);
    }
  }

  const importIds = [
    ...new Set(requests.map((r) => r.doc.importId).filter((x): x is string => x != null)),
  ];
  if (importIds.length > 0) {
    const minRows = await db(app)
      .select({ importId: transactions.importId, minDate: min(transactions.executedAt) })
      .from(transactions)
      .where(inArray(transactions.importId, importIds))
      .groupBy(transactions.importId);
    for (const r of minRows) {
      if (r.importId && r.minDate != null) importMinDateById.set(r.importId, new Date(r.minDate));
    }
  }

  return { portfolioName, txById, instrumentSymbolById, importMinDateById };
}

/** Build the per-document naming context from pre-fetched batch metadata. */
export function namingContextFor(
  req: NamingRequest,
  meta: DocumentNamingMetadata,
): NamingContext {
  const effectiveTxId = req.txId ?? req.doc.transactionId ?? null;
  const tx = effectiveTxId ? (meta.txById.get(effectiveTxId) ?? null) : null;
  const instrumentSymbol = tx?.instrumentId
    ? (meta.instrumentSymbolById.get(tx.instrumentId) ?? null)
    : null;
  const importMinDate = req.doc.importId
    ? (meta.importMinDateById.get(req.doc.importId) ?? null)
    : null;
  return { portfolioName: meta.portfolioName, tx, instrumentSymbol, importMinDate };
}

/**
 * Resolve naming parts for a single document from the database. Thin wrapper over the
 * batch loader + pure `computeNamingParts`, kept for single-doc callers (download endpoints).
 *
 * @param portfolioId  Explicit portfolio id (may not be set on the doc row yet if called
 *                     before finalizeReceipts sets it — callers always have it in scope).
 * @param txId         Optional transaction id to force "transaction" scope for per-tx
 *                     download endpoints (even when the doc's transactionId is null).
 */
export async function gatherDocumentNaming(
  app: AppLikeDb,
  params: {
    doc: DocumentForNaming;
    portfolioId: string;
    txId?: string;
  },
): Promise<NamingParts> {
  const req: NamingRequest = { doc: params.doc, txId: params.txId };
  const meta = await gatherDocumentMetadata(app, [req], params.portfolioId);
  return computeNamingParts(params.doc, namingContextFor(req, meta));
}
