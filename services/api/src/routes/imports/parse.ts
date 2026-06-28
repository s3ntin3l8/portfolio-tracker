import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, inArray, ne } from "drizzle-orm";
import { loans, portfolios, screenshotImports, transactions } from "@portfolio/db";
import type { ParsedTransaction } from "@portfolio/schema";
import { parsedTransactionSchema } from "@portfolio/schema";
import { requireUser } from "../../plugins/auth.js";
import { parseCsv } from "../../services/parsers/csv.js";
import { parseDkb } from "../../services/parsers/dkb.js";
import { detectDkbPdf, parseDkbPdf } from "../../services/parsers/dkb-pdf.js";
import { detectTrPdf, parseTrPdf } from "../../services/parsers/tr-pdf.js";
import { extractPdfText } from "../../services/parsers/pdf-text.js";
import { parseIbkr } from "../../services/parsers/ibkr.js";
import { parseCoinbase } from "../../services/parsers/coinbase.js";
import { parseTrCsv } from "../../services/parsers/tr-csv.js";
import { parseFlexXml } from "../../services/ibkr/flex-parse.js";
import { mapFlexToDrafts } from "../../services/ibkr/mapper.js";
import { detectCsvFormat } from "../../services/parsers/detect.js";
import { assignContentExternalIds, shortHash } from "../../services/parsers/hash.js";
import {
  classifyMatch,
  parserToTxSource,
  isEuParser,
} from "../../services/parsers/dedup.js";
import { findCommittedDuplicates } from "../../services/parsers/likely-duplicates.js";
import { getImportStrategy } from "../../services/import-settings.js";
import { storeReceipt, finalizeReceipts } from "../../storage/receipts.js";
import { materializeDrafts } from "../../services/materialize-drafts.js";
import { isCashMovementAction } from "../../services/pytr/mapper.js";
import {
  accountMismatchVerdict,
  accountsMatch,
  normalizeAccountNumber,
  ownedPortfolio,
} from "./helpers.js";

const materializeBodySchema = z.object({
  // Target portfolio the user picked/confirmed in the upload modal.
  portfolioId: z.string().uuid(),
  // Proceed past the account-mismatch guard (the file's detected account looks like it
  // belongs to a different portfolio than the one chosen). The web flow surfaces this as
  // an inline "Import anyway" re-confirm.
  acknowledgeAccountMismatch: z.boolean().default(false),
});

const csvBodySchema = z.object({
  content: z.string().min(1),
  // `auto` sniffs the content (default); otherwise force a specific parser: `dkb`
  // (German DKB depot/Girokonto), `ibkr` (Interactive Brokers Flex Trades CSV), `ibkr-xml`
  // (Interactive Brokers Activity Flex Statement XML — richer: dividends, cash, positions),
  // `coinbase`, `tr-csv` (Trade Republic transaction export), or `generic` (simple column CSV).
  format: z
    .enum(["auto", "generic", "dkb", "ibkr", "ibkr-xml", "coinbase", "tr-csv"])
    .default("auto"),
});

// Wrapper so the IBKR Activity Flex XML parser fits the CsvParseResult contract.
function parseIbkrFlex(content: string): ReturnType<typeof parseCsv> {
  try {
    const statements = parseFlexXml(content);
    if (statements.length === 0) return { drafts: [], errors: [] };
    // A single Activity Flex export always has one statement; take the first.
    const { drafts, errors } = mapFlexToDrafts(statements[0]!);
    const accountNumber = statements[0]?.accountId || undefined;
    return {
      drafts,
      errors: errors.map((e) => ({ line: e.line ?? 0, message: e.message })),
      accountNumber,
    };
  } catch (err) {
    return {
      drafts: [],
      errors: [{ line: 0, message: err instanceof Error ? err.message : "XML parse error" }],
    };
  }
}

const CSV_PARSERS = {
  dkb: parseDkb,
  ibkr: parseIbkr,
  "ibkr-xml": parseIbkrFlex,
  coinbase: parseCoinbase,
  "tr-csv": parseTrCsv,
  generic: parseCsv,
} as const;

// How a resolved format maps to the stored `parser` tag (DKB keeps its own; Trade
// Republic keeps its own so confirm resolves ISINs as an EU broker; IBKR XML gets its
// own so confirm routes it to source="ibkr" + EU ISIN resolution; the rest are "csv").
const PARSER_TAG: Record<string, "dkb" | "csv" | "tr-csv" | "ibkr"> = {
  dkb: "dkb",
  "tr-csv": "tr-csv",
  "ibkr-xml": "ibkr",
};

/** Accepted MIME types for screenshot/PDF imports. */
function isAcceptedMime(mimeType: string): boolean {
  return mimeType.startsWith("image/") || mimeType === "application/pdf";
}

/**
 * Registers the two upload/parse routes: POST /imports/csv and POST /imports/screenshot.
 * Both parse an uploaded file into draft transactions, run upload-time dedup/account
 * matching, and stage the drafts as a draft import — they never write transactions
 * (that's confirm.ts). Called directly from importsRoute (NOT app.register) so it shares
 * the same encapsulation context — the handlers depend on app.authenticate, app.db,
 * app.screenshotParser, app.storage and app.httpErrors.
 */
export function registerParseImportRoutes(app: FastifyInstance) {
  /** Look up a non-discarded import for the same user matching any of the given content
   * hashes. Scoped per-user so the same file cannot be re-imported across different
   * portfolios. Accepts multiple hashes so the PDF path can match both the text-layer hash
   * (the forward key, #216) and the legacy raw-byte hash of pre-#216 imports. */
  async function existingImport(userId: string, contentHash: string | string[]) {
    const hashes = Array.isArray(contentHash) ? contentHash : [contentHash];
    const [row] = await app.db
      .select()
      .from(screenshotImports)
      .where(
        and(
          eq(screenshotImports.userId, userId),
          inArray(screenshotImports.contentHash, hashes),
          ne(screenshotImports.status, "discarded"),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Does this import still have any live records pointing at it? A confirmed import whose
   *  transactions (and financed-gold loans) have all since been deleted is effectively gone —
   *  its file-level dedup row would otherwise block re-importing the same file forever (the
   *  confirm-time cross-source backstop, not this guard, is the authoritative duplicate
   *  protection now). Checks both `transactions` and `loans`, which carry `importId`. */
  async function importHasLiveRecords(importId: string): Promise<boolean> {
    const [tx] = await app.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.importId, importId))
      .limit(1);
    if (tx) return true;
    const [loan] = await app.db
      .select({ id: loans.id })
      .from(loans)
      .where(eq(loans.importId, importId))
      .limit(1);
    return Boolean(loan);
  }

  /**
   * Resolve whether a content-hash–matched prior import should still short-circuit this
   * upload. Returns the import to reuse for the dedup response, or null when the upload
   * should proceed and re-parse fresh. It proceeds (returning null) in two cases:
   *   - **force** — the user explicitly asked to re-import (e.g. some, not all, of the
   *     earlier transactions were deleted and they want them back). Survivors are caught
   *     again at confirm time, where `acknowledgeDuplicates` lets them drop or keep them.
   *   - **stale** — a *confirmed* import whose transactions/loans have all been deleted, so
   *     nothing real is left to dedup against. Detected automatically, no user action needed.
   * In both cases the matched row is marked `discarded` so the (per-user, status≠discarded)
   * `existingImport` lookup won't keep matching it and re-block the fresh draft we create.
   */
  async function resolveReuse(
    existing: Awaited<ReturnType<typeof existingImport>> | null,
    force: boolean,
  ): Promise<Awaited<ReturnType<typeof existingImport>> | null> {
    if (!existing) return null;
    const supersede =
      force || (existing.status === "confirmed" && !(await importHasLiveRecords(existing.id)));
    if (!supersede) return existing;
    // Discard the matched row — and any other rows with the same (userId, contentHash) that
    // may exist from a pre-migration TOCTOU race (fix 4.4). The unique index (fix 4.1)
    // prevents new duplicates, but old data may have them.
    await app.db
      .update(screenshotImports)
      .set({ status: "discarded" })
      .where(
        existing.contentHash
          ? and(
              eq(screenshotImports.userId, existing.userId),
              eq(screenshotImports.contentHash, existing.contentHash),
              ne(screenshotImports.status, "discarded"),
            )
          : eq(screenshotImports.id, existing.id),
      );
    return null;
  }

  /** Read the `force` re-import override from the request query (`?force=true`). Used by
   *  both upload endpoints so the override works uniformly across JSON (CSV) and multipart
   *  (screenshot/PDF) bodies without threading it through either body shape. */
  function forceFromQuery(query: unknown): boolean {
    const f = (query as { force?: unknown } | null)?.force;
    return f === true || f === "true" || f === "1";
  }

  /**
   * Find the portfolio whose accountNumber matches the detected value. Returns null when
   * no account number was detected, no portfolio has one, or more than one portfolio
   * matches (ambiguous → no prefill). Uses {@link accountsMatch} so IBAN-vs-depot still routes.
   */
  async function matchAccountNumber(
    userId: string,
    detected: string | null | undefined,
  ): Promise<string | null> {
    if (!normalizeAccountNumber(detected)) return null;
    const rows = await app.db
      .select({ id: portfolios.id, accountNumber: portfolios.accountNumber })
      .from(portfolios)
      .where(eq(portfolios.userId, userId));
    const matches = rows.filter((p) => accountsMatch(p.accountNumber, detected));
    return matches.length === 1 ? (matches[0]?.id ?? null) : null;
  }

  /** The user's only portfolio id, or null when they have zero or several. Used as the
   * fallback target for upload-time duplicate flagging when no account match prefilled one. */
  async function soleOwnedPortfolioId(userId: string): Promise<string | null> {
    const rows = await app.db
      .select({ id: portfolios.id })
      .from(portfolios)
      .where(eq(portfolios.userId, userId))
      .limit(2);
    return rows.length === 1 ? rows[0].id : null;
  }

  /**
   * Flag drafts that economically match transactions already committed to `portfolioId`
   * (#196 cross-format dedup, hardened in #217), so the review screen can pre-deselect them.
   * Best-effort: instruments aren't resolved yet at upload, so identity falls back to the
   * draft's ISIN → WKN → normalised name. Matching is tolerant (action class, ±1 day,
   * quantity/price within tolerance) and **count-aware** — each committed row flags at most
   * one draft, so two legitimate identical same-day buys against an empty history are never
   * both suppressed. Mutates drafts in place, adding `likelyDuplicate: { kind, source, executedAt, matchedTransactionId }`.
   *
   * `importParser` is the import's parser tag (e.g. "csv", "dkb", "screenshot") used to
   * classify each match as "enrichment" (different source + file upload / taxComponents) vs
   * plain "duplicate" (same source or no new value) — so the review screen can badge them
   * differently and the confirm flow can auto-apply enrichments without a blocking 409.
   *
   * This pass is advisory (it only pre-deselects / badges in the UI). The authoritative
   * backstop runs at confirm time against the resolved instrumentId — see the cross-source
   * check there.
   */
  async function annotateLikelyDuplicates(
    drafts: ParsedTransaction[],
    portfolioId: string | null,
    importParser: string,
  ): Promise<void> {
    if (!portfolioId || drafts.length === 0) return;

    // A screenshot/PDF upload carries a document; a CSV/XML upload doesn't (even if it's
    // technically stored as a receipt, it brings no visual document or tax detail). Keyed
    // off the *tx source* so deterministic-PDF parsers (dkb-pdf/tr-pdf → "pdf") count too,
    // matching the /duplicates preview route — see classifyMatch's single-conversion contract.
    const incomingTxSource = parserToTxSource(importParser);
    const importIsFileUpload =
      incomingTxSource === "screenshot" || incomingTxSource === "pdf";

    for (const { draftIndex, matched } of await findCommittedDuplicates(
      app.db,
      portfolioId,
      drafts,
    )) {
      const draft = drafts[draftIndex];
      const hasTaxComponents =
        draft.taxComponents && Object.keys(draft.taxComponents).length > 0;
      const draftHasEnrichment = importIsFileUpload || !!hasTaxComponents;
      const kind = classifyMatch(importParser, matched.source ?? "csv", draftHasEnrichment);
      (drafts[draftIndex] as Record<string, unknown>).likelyDuplicate = {
        kind,
        source: matched.source,
        executedAt: matched.executedAt,
        matchedTransactionId: matched.id,
      };
    }
  }

  /**
   * Phase 2 unification: when a *deterministic* parser (CSV/DKB-PDF/TR-PDF/IBKR) resolves an
   * unambiguous target portfolio at upload, write the drafts straight into the transactions
   * table as `status='draft'` rows (the same pipeline sync uses) instead of staging them for
   * the review screen. The import row becomes a provenance/document anchor (status confirmed).
   * Mirrors the confirm route's source/isEu/cash-boundary handling so behavior is identical
   * to "upload → confirm", minus the review click. Returns the materialized count.
   */
  async function materializeResolvedDrafts(opts: {
    imp: { id: string };
    drafts: ParsedTransaction[];
    parserTag: string;
    targetPortfolioId: string;
  }): Promise<{ materialized: number; excludedCashMovements: number }> {
    const { imp, drafts, parserTag, targetPortfolioId } = opts;
    const [pf] = await app.db
      .select({
        cashCounted: portfolios.cashCounted,
        documentRetention: portfolios.documentRetention,
      })
      .from(portfolios)
      .where(eq(portfolios.id, targetPortfolioId))
      .limit(1);

    // Cash-boundary filter (#326), same as confirm: a cash-outside portfolio drops genuine
    // cash movements from a TR settlement PDF so they don't manufacture phantom flows.
    let toWrite = drafts;
    let excludedCashMovements = 0;
    if (parserTag === "tr-pdf" && pf && !pf.cashCounted) {
      const before = toWrite.length;
      toWrite = toWrite.filter((d) => !isCashMovementAction(d.action));
      excludedCashMovements = before - toWrite.length;
    }

    const res = await materializeDrafts(app, {
      drafts: toWrite,
      targetPortfolioId,
      source: parserToTxSource(parserTag) as "csv" | "pdf" | "ibkr" | "screenshot",
      importId: imp.id,
      status: "draft",
      isEu: isEuParser(parserTag),
    });

    // The import has produced its transactions — close it (anchor, not a review item)
    // BEFORE finalizing receipts. Receipt finalization (storage re-key) is best-effort and
    // non-transactional, so a hiccup there must not leave a completed import stuck in 'draft'
    // while its drafts already exist in the table.
    await app.db
      .update(screenshotImports)
      .set({ portfolioId: targetPortfolioId, status: "confirmed" })
      .where(eq(screenshotImports.id, imp.id));

    // Finalize the staged receipt now (retain per portfolio setting) — the old confirm-time
    // finalization no longer runs for this path. Best-effort: per-doc failures already log
    // inside finalizeReceipts; guard the bulk path too so it can't unwind a confirmed import.
    try {
      await finalizeReceipts(app, {
        importId: imp.id,
        portfolioId: targetPortfolioId,
        retain: pf?.documentRetention ?? false,
      });
    } catch (err) {
      app.log.warn(
        { err, importId: imp.id },
        "finalizeReceipts failed after materialize (non-fatal) — import stays confirmed",
      );
    }

    return { materialized: res.written.length, excludedCashMovements };
  }

  // Parse a CSV into draft transactions and store them as a draft import.
  // Portfolio is NOT required at upload time — it is supplied at confirm time.
  app.post(
    "/imports/csv",
    { preHandler: app.authenticate, bodyLimit: 5 * 1024 * 1024 },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { content, format } = csvBodySchema.parse(request.body);
      const force = forceFromQuery(request.query);
      const contentHash = shortHash(content);

      request.log.info(
        { requestedFormat: format, bytes: content.length },
        "csv import started",
      );

      // Re-upload guard: return the existing non-discarded import instead of creating
      // a duplicate draft row. Scoped per-user so the same file is blocked regardless
      // of which portfolio it was previously imported into. Discarded imports are ignored.
      // `resolveReuse` lets the upload through (re-parsing fresh) when the user forced a
      // re-import, or when a confirmed import's transactions were all deleted (#229).
      const existing = await resolveReuse(await existingImport(id, contentHash), force);
      if (existing) {
        const isDraft = existing.status === "draft";
        const parsed = isDraft
          ? ((existing.parsedJson ?? {}) as {
              drafts?: unknown[];
              errors?: unknown[];
              accountNumber?: string | null;
            })
          : null;
        const matchedPortfolioId = isDraft
          ? await matchAccountNumber(id, parsed?.accountNumber)
          : null;
        request.log.info(
          { importId: existing.id, status: existing.status },
          "csv import deduplicated",
        );
        reply.code(200);
        return {
          importId: existing.id,
          // Return drafts only for existing draft imports (so the user can review them).
          // Confirmed imports have nothing to review — empty drafts signals alreadyConfirmed.
          drafts: isDraft && parsed && Array.isArray(parsed.drafts) ? parsed.drafts : [],
          contracts: [] as unknown[],
          errors: isDraft && parsed && Array.isArray(parsed.errors) ? parsed.errors : [],
          alreadyExists: isDraft,
          alreadyConfirmed: !isDraft,
          matchedPortfolioId,
        };
      }

      const resolved = format === "auto" ? detectCsvFormat(content) : format;
      request.log.debug({ resolved, parser: PARSER_TAG[resolved] ?? "csv" }, "csv format detected");
      const result = CSV_PARSERS[resolved](content);
      // Assign deterministic content-hash externalIds to drafts that don't already
      // have a stable parser-supplied id (DKB booking refs, IBKR trade ids, etc.).
      // Must happen at parse time so partial-confirm batches reproduce the same ids.
      assignContentExternalIds(result.drafts, "csv");
      for (const e of result.errors) {
        request.log.debug({ line: e.line, message: e.message }, "csv row rejected");
      }

      // Account auto-detect (DKB CSV exposes IBAN/Depotnummer; other formats don't).
      const detected = result.accountNumber ?? null;
      const matchedPortfolioId = await matchAccountNumber(id, detected);
      // Candidate portfolio for duplicate flagging: the account-matched one, else the
      // user's sole portfolio (the unambiguous default the review picker will land on).
      const candidate = matchedPortfolioId ?? (await soleOwnedPortfolioId(id));
      await annotateLikelyDuplicates(result.drafts, candidate, PARSER_TAG[resolved] ?? "csv");
      const accountMismatch = candidate
        ? await accountMismatchVerdict(app, id, detected, candidate)
        : null;

      // onConflictDoNothing handles the TOCTOU race where two concurrent identical uploads
      // both pass the existingImport check before either inserts (fix 4.1). When it fires,
      // we fetch the winning row and use its id for the response.
      let imp = (await app.db
        .insert(screenshotImports)
        .values({
          userId: id,
          // Store the account-matched portfolio so the draft review page pre-selects it.
          // Overwritten at confirm time with whatever the user chose in the review picker.
          portfolioId: matchedPortfolioId ?? null,
          parser: PARSER_TAG[resolved] ?? "csv",
          // `result` carries `accountNumber` (DKB) so re-upload + confirm can re-match.
          parsedJson: result,
          contentHash,
          status: "draft",
        })
        .onConflictDoNothing()
        .returning())[0];

      if (!imp) {
        // Race: another upload of the same file won. Find its row.
        const [existing] = await app.db
          .select()
          .from(screenshotImports)
          .where(
            and(
              eq(screenshotImports.userId, id),
              eq(screenshotImports.contentHash, contentHash),
              ne(screenshotImports.status, "discarded"),
            ),
          )
          .limit(1);
        if (!existing) throw app.httpErrors.internalServerError("import race recovery failed");
        imp = existing;
      }

      // Stage the raw CSV for potential post-confirm retention (#231).
      // Best-effort: a storage failure never breaks the parse (see receipts.ts).
      await storeReceipt(app, {
        userId: id,
        importId: imp.id,
        buf: Buffer.from(content, "utf8"),
        mimeType: "text/csv",
        originalFilename: null,
        source: PARSER_TAG[resolved] ?? "csv",
      });

      // Always stage (no auto-materialize): the user picks/confirms a target portfolio in the
      // upload modal — pre-selected from `suggestedPortfolioId` (account match, else the sole
      // portfolio) — and the materialize endpoint writes the drafts. This makes portfolio
      // assignment a conscious confirm even when an account matched (the mismatch guard still
      // re-confirms when the file points at a *different* portfolio than the one chosen).
      request.log.info(
        { importId: imp.id, drafts: result.drafts.length, errors: result.errors.length, matchedPortfolioId },
        "csv parse complete",
      );
      reply.code(201);
      return {
        importId: imp.id,
        drafts: result.drafts,
        contracts: [] as unknown[],
        errors: result.errors,
        matchedPortfolioId,
        suggestedPortfolioId: candidate,
        accountMismatch,
      };
    },
  );

  // Parse a screenshot or PDF into draft transactions and store them as a draft import.
  // The raw file is read from a multipart upload, parsed, then discarded (never persisted)
  // — privacy by default. Portfolio is NOT required at upload time; supplied at confirm time.
  app.post(
    "/imports/screenshot",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      if (!app.screenshotParser.isConfigured()) {
        request.log.warn(
          { provider: app.screenshotParser.name },
          "screenshot parser not configured",
        );
        return reply.code(503).send({ error: "screenshot_parser_not_configured" });
      }

      // Read the uploaded file part from the multipart body.
      let part;
      try {
        part = await request.file();
      } catch {
        // Not a multipart request at all.
        return reply.code(400).send({ error: "no_file" });
      }
      if (!part) return reply.code(400).send({ error: "no_file" });

      const mimeType = part.mimetype || "image/png";
      if (!isAcceptedMime(mimeType)) {
        // Drain the stream to avoid ECONNRESET before we send the error.
        await part.toBuffer().catch(() => {});
        return reply.code(415).send({ error: "unsupported_media_type" });
      }

      let buf: Buffer;
      try {
        buf = await part.toBuffer();
      } catch (err) {
        if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
          return reply.code(413).send({ error: "file_too_large", limitMb: 25 });
        }
        throw err;
      }

      // Raw-byte hash: the base64 representation so dedup semantics are preserved across
      // both the old JSON path and the new multipart path (existing draft rows used base64
      // hashes). Keep this formula verbatim — it's the backward-compat lookup key below.
      const rawHash = shortHash(buf.toString("base64"));

      // For PDFs with a text layer, hash the *normalized extracted text* instead of the raw
      // bytes (#216): a re-export / re-download of the same statement differs at the byte
      // level (embedded /ID, XMP timestamps, compression) but carries an identical text
      // layer, so byte hashing fails to dedup it. Extracted once here and reused by the DKB
      // fast-path below. Empty text (image-only/scanned) or a parse error falls back to the
      // raw-byte hash for both store and lookup.
      let pdfText: string | null = null;
      let contentHash = rawHash;
      if (mimeType === "application/pdf") {
        try {
          const text = await extractPdfText(buf);
          const normalized = text.replace(/\s+/g, " ").trim();
          if (normalized) {
            pdfText = text;
            contentHash = shortHash(normalized);
          }
        } catch (err) {
          request.log.warn({ err }, "pdf text extraction for dedup failed; using raw-byte hash");
        }
      }

      request.log.info({ mimeType, bytes: buf.length }, "screenshot import started");

      // Re-upload guard: same document already imported and not discarded → return it.
      // Scoped per-user so the same document can't be re-parsed into a different portfolio.
      // Two-tier lookup: match the forward text-layer hash *and* the legacy raw-byte hash,
      // so byte-identical re-uploads of imports created before #216 still dedup.
      // `resolveReuse` lets it through (force re-import, or a confirmed import whose records
      // were all deleted) — see the CSV path (#229).
      const existing = await resolveReuse(
        await existingImport(id, [contentHash, rawHash]),
        forceFromQuery(request.query),
      );
      if (existing) {
        const isDraft = existing.status === "draft";
        const storedParsed = isDraft
          ? ((existing.parsedJson ?? {}) as {
              drafts?: unknown[];
              contracts?: unknown[];
              errors?: unknown[];
              accountNumber?: string | null;
            })
          : null;
        const matchedPortfolioId = isDraft
          ? await matchAccountNumber(id, storedParsed?.accountNumber)
          : null;
        request.log.info(
          { importId: existing.id, status: existing.status },
          "screenshot import deduplicated",
        );
        reply.code(200);
        return {
          importId: existing.id,
          drafts:
            isDraft && storedParsed && Array.isArray(storedParsed.drafts)
              ? storedParsed.drafts
              : [],
          contracts:
            isDraft && storedParsed && Array.isArray(storedParsed.contracts)
              ? storedParsed.contracts
              : [],
          errors:
            isDraft && storedParsed && Array.isArray(storedParsed.errors)
              ? storedParsed.errors
              : [],
          alreadyExists: isDraft,
          alreadyConfirmed: !isDraft,
          matchedPortfolioId,
        };
      }

      let parsed;
      // Admin-configured first choice (global): "parser_first" runs the deterministic
      // broker parser before vision; "vision_only" skips it so every PDF/image goes
      // straight to the vision-LLM. CSV imports use their own path and are unaffected.
      const importStrategy = await getImportStrategy(app.db);
      // Track which deterministic parser produced the drafts so the confirm endpoint can
      // derive the correct `transactions.source` ("pdf") and `isEu` ISIN-resolution flag.
      // Stays at the vision-parser name when the fast-path doesn't match or falls through.
      let parserTag = app.screenshotParser.name;
      // Deterministic fast-path for DKB securities PDFs (Wertpapierabrechnung /
      // Dividendengutschrift / Ausschüttung): parse the text layer exactly — no LLM call,
      // no billing, no data egress. Falls through to vision for any non-DKB / scanned PDF.
      if (importStrategy === "parser_first" && mimeType === "application/pdf") {
        try {
          // Reuse the text already extracted for the dedup hash above (it's the same buffer).
          const text = pdfText ?? (await extractPdfText(buf));
          if (detectDkbPdf(text)) {
            const { drafts: dkbDrafts, accountNumber: dkbAccount } = parseDkbPdf(text);
            if (dkbDrafts.length > 0) {
              request.log.info({ drafts: dkbDrafts.length }, "DKB PDF parsed deterministically");
              parsed = { drafts: dkbDrafts, contracts: [], accountNumber: dkbAccount };
              parserTag = "dkb-pdf";
            }
          } else if (detectTrPdf(text)) {
            // TR settlement PDFs: deterministic parse — same fast-path as DKB.
            // Cost-information / order-confirmation docs return false from detectTrPdf.
            const { drafts: trDrafts, errors: trErrors } = parseTrPdf(text);
            if (trDrafts.length > 0) {
              request.log.info({ drafts: trDrafts.length }, "TR PDF parsed deterministically");
              parsed = { drafts: trDrafts, contracts: [], accountNumber: null };
              parserTag = "tr-pdf";
              if (trErrors.length > 0) {
                request.log.warn({ errors: trErrors }, "TR PDF parse had errors");
              }
            }
          }
        } catch (err) {
          request.log.warn({ err }, "DKB/TR PDF text parse failed; falling back to vision");
        }
      }
      try {
        parsed ??= await app.screenshotParser.parse({ data: buf, mimeType }, request.log);
      } catch (err) {
        // Extract the provider HTTP status from the thrown message (e.g. "claude_vision_error_429")
        // and surface it in the response so the client can display a meaningful per-file reason.
        const message = (err as Error)?.message ?? "";
        const m = /vision_error_(\d+)$/.exec(message);
        request.log.error({ err }, "screenshot parse failed");
        return reply.code(502).send({
          error: "screenshot_parse_failed",
          reason: "provider_error",
          provider: app.screenshotParser.name,
          providerStatus: m ? Number(m[1]) : null,
        });
      }

      const { drafts, contracts, accountNumber: detectedAccountNumber } = parsed;
      const scored = [
        ...drafts.map((d) => d.confidence),
        ...contracts.map((c) => c.confidence),
      ];
      const confidence =
        scored.length > 0
          ? String(scored.reduce((s, c) => s + c, 0) / scored.length)
          : null;
      // Assign content-hash externalIds before storing so subset-confirm is safe.
      assignContentExternalIds(drafts, "screenshot");
      // Store accountNumber inside parsedJson so the dedup branch can also match on re-upload.
      const result = {
        drafts,
        contracts,
        errors: [] as { line: number; message: string }[],
        accountNumber: detectedAccountNumber ?? null,
      };

      const matchedPortfolioId = await matchAccountNumber(id, detectedAccountNumber);
      // Candidate portfolio for duplicate flagging: account-matched, else the sole portfolio.
      const candidate = matchedPortfolioId ?? (await soleOwnedPortfolioId(id));
      await annotateLikelyDuplicates(result.drafts, candidate, parserTag);
      const accountMismatch = candidate
        ? await accountMismatchVerdict(app, id, detectedAccountNumber, candidate)
        : null;

      // onConflictDoNothing handles the TOCTOU race (fix 4.1) — see the CSV path above.
      let imp = (await app.db
        .insert(screenshotImports)
        .values({
          userId: id,
          // Store the account-matched portfolio so the draft review page pre-selects it.
          // Overwritten at confirm time with whatever the user chose in the review picker.
          portfolioId: matchedPortfolioId ?? null,
          // Use the deterministic parser tag ("dkb-pdf"/"tr-pdf") when the fast-path
          // matched, so confirm can derive source="pdf" and correct ISIN resolution.
          parser: parserTag,
          parsedJson: result,
          confidence,
          contentHash,
          status: "draft",
        })
        .onConflictDoNothing()
        .returning())[0];

      if (!imp) {
        const [existing] = await app.db
          .select()
          .from(screenshotImports)
          .where(
            and(
              eq(screenshotImports.userId, id),
              eq(screenshotImports.contentHash, contentHash),
              ne(screenshotImports.status, "discarded"),
            ),
          )
          .limit(1);
        if (!existing) throw app.httpErrors.internalServerError("import race recovery failed");
        imp = existing;
      }

      // Stage the raw file for potential post-confirm retention (#231).
      // Best-effort: a storage failure never breaks the parse (see receipts.ts).
      await storeReceipt(app, {
        userId: id,
        importId: imp.id,
        buf,
        mimeType,
        originalFilename: part.filename ?? null,
        source: parserTag,
      });

      // Always stage (no auto-materialize): the user confirms a target portfolio in the upload
      // modal — pre-selected from `suggestedPortfolioId` (account match, else the sole
      // portfolio) — then the materialize endpoint writes the drafts as `status='draft'` rows
      // carrying their per-draft confidence. The mismatch guard re-confirms when the detected
      // account points at a different portfolio than the one chosen. Gold contracts keep the
      // confirm path (they become loans, not draft transactions).
      request.log.info(
        { importId: imp.id, drafts: result.drafts.length, contracts: result.contracts.length, confidence, matchedPortfolioId },
        "screenshot parse stored",
      );
      reply.code(201);
      return {
        importId: imp.id,
        drafts: result.drafts,
        contracts: result.contracts,
        errors: result.errors,
        matchedPortfolioId,
        suggestedPortfolioId: candidate,
        accountMismatch,
      };
    },
  );

  // Materialize a staged import's drafts into the chosen portfolio as `status='draft'` rows.
  // This is the "confirm portfolio" step of the upload flow: parse staged the drafts (+ the
  // detected account number); the user picked a portfolio; we write the drafts here. Reads
  // the stored `parsedJson.drafts` — it NEVER re-parses (so a vision screenshot's LLM call is
  // not repeated on an account-mismatch acknowledge). Gold contracts keep the confirm path.
  app.post<{ Params: { importId: string } }>(
    "/imports/:importId/materialize",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId, acknowledgeAccountMismatch } = materializeBodySchema.parse(
        request.body,
      );

      const [imp] = await app.db
        .select()
        .from(screenshotImports)
        .where(
          and(
            eq(screenshotImports.id, request.params.importId),
            eq(screenshotImports.userId, id),
          ),
        )
        .limit(1);
      if (!imp) return reply.code(404).send({ error: "import_not_found" });
      if (imp.status === "confirmed") {
        return reply.code(409).send({ error: "already_confirmed" });
      }

      const parsed = (imp.parsedJson ?? {}) as {
        drafts?: unknown[];
        contracts?: unknown[];
        accountNumber?: string | null;
      };
      // Coerce the stored drafts through the schema — JSON round-trips `executedAt` as a
      // string, but the writer needs a Date (same coercion the confirm route's body does).
      const drafts = z
        .array(parsedTransactionSchema)
        .parse(Array.isArray(parsed.drafts) ? parsed.drafts : []);
      const contracts = Array.isArray(parsed.contracts) ? parsed.contracts : [];
      // Gold cicilan contracts become loans, not draft transactions — they stay on the
      // confirm path (POST /imports/:id/confirm), which owns the loan + leg machinery.
      if (contracts.length > 0) {
        return reply.code(400).send({ error: "use_confirm_for_contracts" });
      }
      if (drafts.length === 0) {
        return reply.code(400).send({ error: "nothing_to_materialize" });
      }

      const targetPortfolio = await ownedPortfolio(app, id, portfolioId);
      if (!targetPortfolio) return reply.code(404).send({ error: "portfolio_not_found" });

      // Account-mismatch guard (#197): if the file's detected account looks like it belongs to
      // a different portfolio than the chosen one, refuse until acknowledged. pytr is exempt
      // (sync is always bound to its connection's portfolio) but never reaches this route.
      if (!acknowledgeAccountMismatch && imp.parser !== "pytr") {
        const mismatch = await accountMismatchVerdict(app, id, parsed.accountNumber, portfolioId);
        if (mismatch) {
          request.log.info(
            { importId: imp.id, kind: mismatch.kind },
            "materialize blocked: account mismatch",
          );
          return reply.code(409).send({ error: "account_mismatch", ...mismatch });
        }
      }

      const mat = await materializeResolvedDrafts({
        imp,
        drafts,
        parserTag: imp.parser ?? "csv",
        targetPortfolioId: portfolioId,
      });
      request.log.info(
        { importId: imp.id, materialized: mat.materialized, portfolioId },
        "import materialized as drafts",
      );
      reply.code(201);
      return {
        importId: imp.id,
        materialized: true,
        portfolioId,
        materializedCount: mat.materialized,
        excludedCashMovements: mat.excludedCashMovements,
      };
    },
  );
}
