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

import { min } from "drizzle-orm";
import { transactions, portfolios, instruments } from "@portfolio/db";
import type { FastifyInstance } from "fastify";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
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

/**
 * Resolve naming parts for a document from the database.
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
  const { doc, portfolioId, txId } = params;
  const ext = extFromMime(doc.mimeType);
  const shortId = doc.id.replace(/-/g, "").slice(0, 8);

  // Portfolio slug — load the portfolio name.
  const [portfolio] = await db(app)
    .select({ name: portfolios.name })
    .from(portfolios)
    .where(eq(portfolios.id, portfolioId))
    .limit(1);
  const portfolioSlug = portfolio ? slug(portfolio.name) : "portfolio";

  // Resolve the transaction id to use for the transaction scope.
  const effectiveTxId = txId ?? doc.transactionId ?? null;

  if (effectiveTxId) {
    // Transaction scope: load type + executedAt + instrument symbol.
    const [tx] = await db(app)
      .select({
        type: transactions.type,
        executedAt: transactions.executedAt,
        instrumentId: transactions.instrumentId,
      })
      .from(transactions)
      .where(eq(transactions.id, effectiveTxId))
      .limit(1);

    if (tx) {
      let symbol = "unknown";
      if (tx.instrumentId) {
        const [inst] = await db(app)
          .select({ symbol: instruments.symbol })
          .from(instruments)
          .where(eq(instruments.id, tx.instrumentId))
          .limit(1);
        if (inst) symbol = slug(inst.symbol);
      }

      const dt = tx.executedAt;
      const date = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
      const year = String(dt.getUTCFullYear());

      return {
        scope: "transaction",
        portfolioSlug,
        date,
        year,
        type: tx.type,
        symbol,
        ext,
        docId: shortId,
      };
    }
  }

  // Statement scope: derive period from the earliest transaction executedAt in this import,
  // falling back to storedAt if the import has no transactions yet.
  let period: string;

  if (doc.importId) {
    const [earliest] = await db(app)
      .select({ minDate: min(transactions.executedAt) })
      .from(transactions)
      .where(eq(transactions.importId, doc.importId));

    const dt = earliest?.minDate ?? doc.storedAt;
    const d = new Date(dt);
    period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  } else {
    const d = doc.storedAt;
    period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  return {
    scope: "statement",
    portfolioSlug,
    period,
    source: friendlySource(doc.source),
    ext,
    docId: shortId,
  };
}
