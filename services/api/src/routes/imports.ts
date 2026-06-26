import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  instruments,
  loans,
  portfolios,
  screenshotImports,
  transactions,
  transactionSources,
  trResolvedEvents,
} from "@portfolio/db";
import {
  parsedTransactionSchema,
  type ImportIssue,
  type ParsedTransaction,
} from "@portfolio/schema";
import { requireUser } from "../plugins/auth.js";
import { parseCsv } from "../services/parsers/csv.js";
import { parseDkb } from "../services/parsers/dkb.js";
import { detectDkbPdf, parseDkbPdf } from "../services/parsers/dkb-pdf.js";
import { detectTrPdf, parseTrPdf } from "../services/parsers/tr-pdf.js";
import { enrichTransactionFromDrafts } from "../services/enrichment.js";
import { extractPdfText } from "../services/parsers/pdf-text.js";
import { parseIbkr } from "../services/parsers/ibkr.js";
import { parseCoinbase } from "../services/parsers/coinbase.js";
import { parseTrCsv } from "../services/parsers/tr-csv.js";
import { parseFlexXml } from "../services/ibkr/flex-parse.js";
import { mapFlexToDrafts } from "../services/ibkr/mapper.js";
import { detectCsvFormat } from "../services/parsers/detect.js";
import { assignContentExternalIds, shortHash } from "../services/parsers/hash.js";
import { findCrossSourceDuplicates, classifyMatch, parserToTxSource } from "../services/parsers/dedup.js";
import { getImportStrategy } from "../services/import-settings.js";
import {
  storeReceipt,
  finalizeReceipts,
  deleteReceiptsForImport,
  getDocumentForImport,
  getDocumentSummaryForImport,
  retainDocumentForTransaction,
} from "../storage/receipts.js";
import { gatherDocumentNaming, buildDocumentName } from "../storage/naming.js";
import { accountMismatchVerdict, accountsMatch, normalizeAccountNumber, ownedPortfolio } from "./imports/helpers.js";
import { registerConfirmImportRoute } from "./imports/confirm.js";

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
// Batch hard-delete of discarded imports. Mirrors transactions' bulk-delete so the
// web "clear all" fires one request instead of N parallel DELETE /clear calls (which
// trip the global rate limiter — issue surfaced after a bulk import undo).
const bulkClearSchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
});

/** Best-effort instrument identity for upload-time dedup, before instruments are resolved:
 *  prefer ISIN, then WKN, then a normalised name. Returns null when nothing is available. */
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

export async function importsRoute(app: FastifyInstance) {
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
    const rows = await app.db
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

    const committed = rows.map((r) => ({
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

    // A screenshot/PDF upload carries a document; a CSV upload doesn't (even if it's
    // technically stored as a receipt, it brings no visual document or tax detail).
    const importIsFileUpload = importParser === "screenshot";

    for (const { draftIndex, matched } of findCrossSourceDuplicates(draftCandidates, committed)) {
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
      await annotateLikelyDuplicates(result.drafts, candidate, "screenshot");
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
        accountMismatch,
      };
    },
  );

  async function ownedImport(userId: string, importId: string) {
    const [imp] = await app.db
      .select()
      .from(screenshotImports)
      .where(
        and(
          eq(screenshotImports.id, importId),
          eq(screenshotImports.userId, userId),
        ),
      )
      .limit(1);
    return imp ?? null;
  }

  // List the current user's imports (newest first) — id, status, parser, draft count,
  // and document summary if one has been retained (#231).
  app.get("/imports", { preHandler: app.authenticate }, async (request) => {
    const { id } = requireUser(request);
    const rows = await app.db
      .select()
      .from(screenshotImports)
      .where(eq(screenshotImports.userId, id))
      .orderBy(desc(screenshotImports.createdAt));
    return Promise.all(
      rows.map(async (r) => {
        const parsed = (r.parsedJson ?? {}) as { drafts?: unknown[] };
        const document = r.status === "confirmed"
          ? await getDocumentSummaryForImport(app, r.id)
          : null;
        return {
          id: r.id,
          portfolioId: r.portfolioId,
          parser: r.parser,
          status: r.status,
          confidence: r.confidence,
          count: Array.isArray(parsed.drafts) ? parsed.drafts.length : 0,
          createdAt: r.createdAt,
          document,
        };
      }),
    );
  });

  // Safety net: aggregate event types that reached the importer but have no mapping yet
  // (TR `unmapped_event_type` / `unparseable_event`), so a future gap is self-announcing on
  // the dashboard + admin panel instead of buried in a single import's errors JSON. Grouped
  // by event type (falling back to the message for the null-eventType / unparseable case),
  // scoped to the user's non-discarded imports, most-frequent first.
  app.get("/imports/unmapped-types", { preHandler: app.authenticate }, async (request) => {
    const { id } = requireUser(request);
    const rows = await app.db
      .select()
      .from(screenshotImports)
      .where(eq(screenshotImports.userId, id))
      .orderBy(desc(screenshotImports.createdAt));
    const byKey = new Map<
      string,
      {
        eventType: string | null;
        code: NonNullable<ImportIssue["code"]>;
        message: string;
        count: number;
        lastSeen: Date;
        sample: ImportIssue["raw"] | null;
      }
    >();
    for (const r of rows) {
      if (r.status === "discarded") continue;
      const parsed = (r.parsedJson ?? {}) as { errors?: ImportIssue[] };
      for (const e of parsed.errors ?? []) {
        if (e.code !== "unmapped_event_type" && e.code !== "unparseable_event") continue;
        const key = `${e.code}:${e.eventType ?? e.message}`;
        const existing = byKey.get(key);
        if (existing) {
          existing.count += 1;
          if (r.createdAt > existing.lastSeen) existing.lastSeen = r.createdAt;
        } else {
          byKey.set(key, {
            eventType: e.eventType ?? null,
            code: e.code,
            message: e.message,
            count: 1,
            lastSeen: r.createdAt,
            sample: e.raw ?? null,
          });
        }
      }
    }
    return Array.from(byKey.values()).sort((a, b) => b.count - a.count);
  });

  // Discard a draft import (draft → discarded). Confirmed imports are undone via DELETE.
  app.post<{ Params: { importId: string } }>(
    "/imports/:importId/discard",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const imp = await ownedImport(id, request.params.importId);
      if (!imp) return reply.code(404).send({ error: "import_not_found" });
      if (imp.status === "confirmed") {
        return reply.code(409).send({ error: "already_confirmed" });
      }
      // For pytr/ibkr drafts, durably record events as discarded so the next sync doesn't
      // re-stage them (the collector would otherwise resurface them indefinitely).
      let resolvedEventsRecorded = 0;
      const isSyncParser = (imp.parser === "pytr" || imp.parser === "ibkr") && imp.portfolioId;
      if (isSyncParser) {
        const source = imp.parser as "pytr" | "ibkr";
        const parsed = (imp.parsedJson ?? {}) as {
          drafts?: { externalId?: string | null }[];
          errors?: { eventId?: string | null }[];
        };
        const ids = [
          ...(parsed.drafts ?? []).map((d) => d.externalId),
          ...(parsed.errors ?? []).map((e) => e.eventId),
        ].filter((x): x is string => Boolean(x));
        if (ids.length) {
          await app.db
            .insert(trResolvedEvents)
            .values(
              ids.map((eventId) => ({
                portfolioId: imp.portfolioId!,
                source,
                eventId,
                resolution: "discarded",
              })),
            )
            .onConflictDoNothing();
          resolvedEventsRecorded = ids.length;
        }
      }
      // Clean up any staged/retained documents before marking discarded (#231).
      await deleteReceiptsForImport(app, imp.id);
      await app.db
        .update(screenshotImports)
        .set({ status: "discarded" })
        .where(eq(screenshotImports.id, imp.id));
      request.log.info(
        { importId: imp.id, parser: imp.parser, resolvedEventsRecorded },
        "import discarded",
      );
      reply.code(204);
      return null;
    },
  );

  // Undo an import: remove any transactions it wrote, then mark it discarded.
  app.delete<{ Params: { importId: string } }>(
    "/imports/:importId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const imp = await ownedImport(id, request.params.importId);
      if (!imp) return reply.code(404).send({ error: "import_not_found" });
      const removed = await app.db
        .delete(transactions)
        .where(eq(transactions.importId, imp.id))
        .returning();
      // Remove any loans the import created (transactions referencing them are gone).
      await app.db.delete(loans).where(eq(loans.importId, imp.id));
      // Clean up any staged/retained documents for this import (#231).
      await deleteReceiptsForImport(app, imp.id);
      await app.db
        .update(screenshotImports)
        .set({ status: "discarded" })
        .where(eq(screenshotImports.id, imp.id));
      request.log.info({ importId: imp.id, removedTransactions: removed.length }, "import undone");
      return { removed: removed.length };
    },
  );

  // Batch hard-delete of discarded imports — one request for the web "clear all" instead
  // of N parallel DELETE /clear calls. Scoped to the user and to discarded rows; ids that
  // aren't owned-and-discarded are silently skipped (same forgiving contract as the
  // transactions bulk-delete). Returns how many rows were actually removed.
  app.post<{ Body: { ids?: unknown } }>(
    "/imports/bulk-clear",
    { preHandler: app.authenticate },
    async (request) => {
      const { id } = requireUser(request);
      const { ids } = bulkClearSchema.parse(request.body);
      const cleared = await app.db
        .delete(screenshotImports)
        .where(
          and(
            eq(screenshotImports.userId, id),
            eq(screenshotImports.status, "discarded"),
            inArray(screenshotImports.id, ids),
          ),
        )
        .returning({ id: screenshotImports.id });
      request.log.info({ requested: ids.length, cleared: cleared.length }, "imports bulk-cleared");
      return { cleared: cleared.length };
    },
  );

  // Hard-delete a discarded import row. Only works on discarded rows (which provably have
  // no child transactions/loans — both FK columns are onDelete:"set null"). Safe vs TR
  // sync: trResolvedEvents has no FK to screenshot_imports; events are written before the
  // row is discarded, so deleting the row doesn't resurface them.
  app.delete<{ Params: { importId: string } }>(
    "/imports/:importId/clear",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const imp = await ownedImport(id, request.params.importId);
      if (!imp) return reply.code(404).send({ error: "import_not_found" });
      if (imp.status !== "discarded") {
        return reply.code(409).send({ error: "not_discarded" });
      }
      await app.db.delete(screenshotImports).where(eq(screenshotImports.id, imp.id));
      request.log.info({ importId: imp.id }, "import cleared");
      reply.code(204);
      return null;
    },
  );

  // Fetch a single import with its parsed drafts (owner only) — powers reviewing an
  // already-staged draft (e.g. a Trade Republic sync) from the import history.
  app.get<{ Params: { importId: string } }>(
    "/imports/:importId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const imp = await ownedImport(id, request.params.importId);
      if (!imp) return reply.code(404).send({ error: "import_not_found" });
      const parsed = (imp.parsedJson ?? {}) as {
        drafts?: unknown[];
        contracts?: unknown[];
        errors?: { line: number; message: string }[];
      };
      return {
        id: imp.id,
        portfolioId: imp.portfolioId,
        parser: imp.parser,
        status: imp.status,
        drafts: Array.isArray(parsed.drafts) ? parsed.drafts : [],
        contracts: Array.isArray(parsed.contracts) ? parsed.contracts : [],
        errors: Array.isArray(parsed.errors) ? parsed.errors : [],
      };
    },
  );

  // Preview-check: run the economic duplicate analysis for a specific target portfolio
  // and return per-draft annotations (kind: "enrichment" | "duplicate", matchedTransactionId,
  // etc.). Does NOT persist anything — lets the review screen show badges immediately after
  // the user selects/changes the portfolio, before the user clicks Confirm.
  app.post<{ Params: { importId: string } }>(
    "/imports/:importId/duplicates",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const imp = await ownedImport(id, request.params.importId);
      if (!imp) return reply.code(404).send({ error: "import_not_found" });

      const { portfolioId } = z.object({ portfolioId: z.string().uuid() }).parse(request.body);
      if (!(await ownedPortfolio(app, id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }

      const parsed = (imp.parsedJson ?? {}) as { drafts?: ParsedTransaction[] };
      const drafts: ParsedTransaction[] = Array.isArray(parsed.drafts) ? parsed.drafts : [];
      if (drafts.length === 0) return { annotations: [] };

      const rows = await app.db
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

      const committed = rows.map((r) => ({
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

      const incomingSource = parserToTxSource(imp.parser ?? "csv");
      const importIsFileUpload = incomingSource === "screenshot";
      const isoDay = (v: Date | string) =>
        (v instanceof Date ? v.toISOString() : new Date(v).toISOString()).slice(0, 10);

      const annotations = findCrossSourceDuplicates(draftCandidates, committed).map(
        ({ draftIndex, matched }) => {
          const d = drafts[draftIndex];
          const hasTaxComponents = d.taxComponents && Object.keys(d.taxComponents).length > 0;
          const draftHasEnrichment = importIsFileUpload || !!hasTaxComponents;
          const kind = classifyMatch(incomingSource, matched.source ?? "csv", draftHasEnrichment);
          return {
            draftIndex,
            kind,
            matchedTransactionId: matched.id,
            matchedSource: matched.source,
            matchedExecutedAt: isoDay(matched.executedAt),
            name: d.name ?? d.isin ?? d.ticker ?? null,
            action: d.action,
            quantity: d.quantity,
            executedAt: isoDay(d.executedAt),
          };
        },
      );

      return { annotations };
    },
  );

  // Confirm an import: write the (possibly edited) drafts as transactions (./imports/confirm.ts).
  registerConfirmImportRoute(app);

  // Enrich existing confirmed transactions with richer detail from an import's drafts.
  // Used when a draft matches a committed transaction (409 duplicate_transactions) and
  // the user chooses "Enrich existing" instead of "Import anyway" or "Skip".
  // Each {draftIndex, targetTransactionId} pair folds the draft onto the target tx.
  // POST /imports/:importId/enrich
  //
  // Body carries the FULL draft payload + targetTransactionId — NOT a draftIndex.
  //
  // Why: the 409 confirm response's draftIndex indexes the submitted confirm-subset
  // (`resolved`, which excludes likelyDuplicate rows), but storedDrafts =
  // imp.parsedJson.drafts is the full set — different arrays. A passed-through draftIndex
  // would fold the WRONG draft.  Sending the draft payload the frontend already holds
  // removes the ambiguity entirely.
  const enrichBodySchema = z.object({
    portfolioId: z.string().uuid().optional(),
    enrichments: z
      .array(
        z.object({
          draft: parsedTransactionSchema,
          targetTransactionId: z.string().uuid(),
        }),
      )
      .min(1),
  });

  app.post<{ Params: { importId: string } }>(
    "/imports/:importId/enrich",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const imp = await ownedImport(id, request.params.importId);
      if (!imp) return reply.code(404).send({ error: "import_not_found" });

      const { portfolioId: bodyPortfolioId, enrichments } = enrichBodySchema.parse(request.body);
      const targetPortfolioId = bodyPortfolioId ?? imp.portfolioId;
      if (!targetPortfolioId) {
        return reply.code(400).send({ error: "portfolio_required" });
      }
      if (!(await ownedPortfolio(app, id, targetPortfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }

      const source = imp.parser === "pytr"
        ? "pytr"
        : (imp.parser === "dkb-pdf" || imp.parser === "tr-pdf")
          ? "pdf"
          : imp.parser === "csv" || imp.parser === "dkb" || imp.parser === "tr-csv"
            ? "csv"
            : "screenshot";
      const isEnrichPdf = imp.parser === "dkb-pdf" || imp.parser === "tr-pdf";

      let enriched = 0;
      const skipped: number[] = [];
      const portfolio = await ownedPortfolio(app, id, targetPortfolioId);
      const retain = portfolio?.documentRetention ?? false;

      // Track whether we've already linked the staged document (one doc per import, 1:1 case).
      let documentLinked = false;

      for (let i = 0; i < enrichments.length; i++) {
        const { draft, targetTransactionId } = enrichments[i];

        // IDOR: verify the target transaction belongs to the user's portfolio.
        const [targetTx] = await app.db
          .select({ id: transactions.id, portfolioId: transactions.portfolioId })
          .from(transactions)
          .where(eq(transactions.id, targetTransactionId))
          .limit(1);
        if (!targetTx || targetTx.portfolioId !== targetPortfolioId) {
          skipped.push(i);
          continue;
        }

        await enrichTransactionFromDrafts(
          targetTransactionId,
          app.db,
          [draft],
          { importId: imp.id, importSource: source },
        );

        // Link and retain the staged PDF to the target transaction so it surfaces in the
        // transaction-detail view. Single-doc-per-import: only link on the first enrichment.
        if (retain && !documentLinked) {
          const docId = await retainDocumentForTransaction(app, {
            importId: imp.id,
            transactionId: targetTransactionId,
            portfolioId: targetPortfolioId,
          });
          if (docId) documentLinked = true;
        }

        enriched++;
      }

      // If retention is off (or no enrichments retained a doc), clean up any remaining staged
      // document for this import — the /enrich path previously left docs staged indefinitely.
      await finalizeReceipts(app, {
        importId: imp.id,
        portfolioId: targetPortfolioId,
        retain,
      });

      // For DKB/TR-PDF imports: link every source row to the retained document so the
      // per-source download button works (mirrors the confirm path).
      if (isEnrichPdf && retain) {
        try {
          const retainedDoc = await getDocumentForImport(app, imp.id);
          if (retainedDoc) {
            await app.db
              .update(transactionSources)
              .set({ documentId: retainedDoc.id })
              .where(
                and(
                  eq(transactionSources.importId, imp.id),
                  isNull(transactionSources.documentId),
                ),
              );
            request.log.debug(
              { importId: imp.id, docId: retainedDoc.id },
              "enrich: linked PDF source rows to retained document",
            );
          }
        } catch (err) {
          request.log.warn({ err }, "enrich: failed to link PDF source rows to document (non-fatal)");
        }
      }

      request.log.info(
        { importId: imp.id, enriched, skipped: skipped.length, documentLinked },
        "enrich complete",
      );
      return { enriched, skipped };
    },
  );

  // Return a signed URL for the retained source document of an import (#231).
  // IDOR guard: only the document owner can obtain a URL.
  app.get<{ Params: { importId: string } }>(
    "/imports/:importId/document-url",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const imp = await ownedImport(id, request.params.importId);
      if (!imp) return reply.code(404).send({ error: "import_not_found" });

      const doc = await getDocumentForImport(app, imp.id);
      if (!doc) return reply.code(404).send({ error: "document_not_found" });

      // IDOR guard: verify document ownership explicitly (belt-and-suspenders).
      if (doc.userId !== id) return reply.code(403).send({ error: "forbidden" });

      // Build a structured, date-first download filename (statement scope for imports).
      let filename: string | null = doc.originalFilename;
      if (doc.portfolioId) {
        try {
          const parts = await gatherDocumentNaming(app, { doc, portfolioId: doc.portfolioId });
          filename = buildDocumentName(parts);
        } catch {
          // Non-fatal: fall back to originalFilename.
        }
      }

      const url = await app.storage.getSignedUrl(doc.storageKey, undefined, {
        downloadName: filename ?? undefined,
      });
      return { url, filename, mimeType: doc.mimeType };
    },
  );
}
