import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, ne } from "drizzle-orm";
import {
  loans,
  portfolios,
  screenshotImports,
  transactions,
  trResolvedEvents,
} from "@portfolio/db";
import {
  parsedGoldContractSchema,
  parsedTransactionSchema,
  type AssetClass,
} from "@portfolio/schema";
import { requireUser } from "../plugins/auth.js";
import {
  buildContractLegs,
  goldInstrumentForContract,
} from "../services/parsers/gold-contract.js";
import { parseCsv } from "../services/parsers/csv.js";
import { parseDkb } from "../services/parsers/dkb.js";
import { parseIbkr } from "../services/parsers/ibkr.js";
import { parseCoinbase } from "../services/parsers/coinbase.js";
import { detectCsvFormat } from "../services/parsers/detect.js";
import { assignContentExternalIds, shortHash } from "../services/parsers/hash.js";
import {
  findOrCreateInstrument,
  marketForAssetClass,
  marketForEuInstrument,
} from "../services/instruments.js";
import { getMarketData } from "../services/market-data.js";
import { resolveCryptoIsin, PRICEABLE_FOREIGN_MARKETS, isIdxEtfSymbol } from "@portfolio/market-data";

const csvBodySchema = z.object({
  content: z.string().min(1),
  // `auto` sniffs the content (default); otherwise force a specific parser: `dkb`
  // (German DKB depot/Girokonto), `ibkr` (Interactive Brokers Flex Trades), `coinbase`,
  // or `generic` (the simple column CSV).
  format: z
    .enum(["auto", "generic", "dkb", "ibkr", "coinbase"])
    .default("auto"),
});

const CSV_PARSERS = {
  dkb: parseDkb,
  ibkr: parseIbkr,
  coinbase: parseCoinbase,
  generic: parseCsv,
} as const;

// How a resolved format maps to the stored `parser` tag (DKB keeps its own; the
// broker presets are all CSV-sourced).
const PARSER_TAG: Record<string, "dkb" | "csv"> = { dkb: "dkb" };
/** Accepted MIME types for screenshot/PDF imports. */
function isAcceptedMime(mimeType: string): boolean {
  return mimeType.startsWith("image/") || mimeType === "application/pdf";
}
const confirmBodySchema = z.object({
  // Target portfolio — required when the import was uploaded without one (upload-first
  // flow). Falls back to `imp.portfolioId` for pytr and legacy uploads that stored one.
  portfolioId: z.string().uuid().optional(),
  // At least one of `transactions` / `contracts` must be present.
  transactions: z.array(parsedTransactionSchema).default([]),
  // Financed gold-purchase contracts (Pegadaian/Galeri24 cicilan). Each becomes a
  // loan row plus its derived legs.
  contracts: z.array(parsedGoldContractSchema).default([]),
});

export async function importsRoute(app: FastifyInstance) {
  async function ownedPortfolio(userId: string, portfolioId: string) {
    const [p] = await app.db
      .select()
      .from(portfolios)
      .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
      .limit(1);
    return p ?? null;
  }

  /** Look up a non-discarded import for the same (userId, contentHash). Scoped per-user
   * so the same file cannot be re-imported across different portfolios. */
  async function existingImport(userId: string, contentHash: string) {
    const [row] = await app.db
      .select()
      .from(screenshotImports)
      .where(
        and(
          eq(screenshotImports.userId, userId),
          eq(screenshotImports.contentHash, contentHash),
          ne(screenshotImports.status, "discarded"),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Normalize an account number for comparison: strip non-alphanumerics, lowercase.
   * Returns null when the input is empty/null so two blank values never match.
   */
  function normalizeAccountNumber(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const n = raw.replace(/[^a-z0-9]/gi, "").toLowerCase();
    return n || null;
  }

  /**
   * Find the portfolio whose accountNumber matches the detected value (exact normalized
   * match). Returns null when no account number was detected, no portfolio has one, or
   * more than one portfolio matches (ambiguous → no prefill).
   */
  async function matchAccountNumber(
    userId: string,
    detected: string | null | undefined,
  ): Promise<string | null> {
    const normalizedDetected = normalizeAccountNumber(detected);
    if (!normalizedDetected) return null;
    const rows = await app.db
      .select({ id: portfolios.id, accountNumber: portfolios.accountNumber })
      .from(portfolios)
      .where(eq(portfolios.userId, userId));
    const matches = rows.filter(
      (p) => normalizeAccountNumber(p.accountNumber) === normalizedDetected,
    );
    return matches.length === 1 ? (matches[0]?.id ?? null) : null;
  }

  // Parse a CSV into draft transactions and store them as a draft import.
  // Portfolio is NOT required at upload time — it is supplied at confirm time.
  app.post(
    "/imports/csv",
    { preHandler: app.authenticate, bodyLimit: 5 * 1024 * 1024 },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { content, format } = csvBodySchema.parse(request.body);
      const contentHash = shortHash(content);

      request.log.info(
        { requestedFormat: format, bytes: content.length },
        "csv import started",
      );

      // Re-upload guard: return the existing non-discarded import instead of creating
      // a duplicate draft row. Scoped per-user so the same file is blocked regardless
      // of which portfolio it was previously imported into. Discarded imports are ignored.
      const existing = await existingImport(id, contentHash);
      if (existing) {
        const isDraft = existing.status === "draft";
        const parsed = isDraft
          ? ((existing.parsedJson ?? {}) as { drafts?: unknown[]; errors?: unknown[] })
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

      const [imp] = await app.db
        .insert(screenshotImports)
        .values({
          userId: id,
          // portfolioId is deliberately omitted — resolved at confirm time.
          parser: PARSER_TAG[resolved] ?? "csv",
          parsedJson: result,
          contentHash,
          status: "draft",
        })
        .returning();

      request.log.info(
        { importId: imp.id, drafts: result.drafts.length, errors: result.errors.length },
        "csv parse complete",
      );
      reply.code(201);
      return { importId: imp.id, drafts: result.drafts, contracts: [] as unknown[], errors: result.errors };
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

      // Hash the base64 representation so dedup semantics are preserved across both the
      // old JSON path and the new multipart path (existing draft rows used base64 hashes).
      const contentHash = shortHash(buf.toString("base64"));

      request.log.info({ mimeType, bytes: buf.length }, "screenshot import started");

      // Re-upload guard: same image already imported and not discarded → return it.
      // Scoped per-user so the same document can't be re-parsed into a different portfolio.
      const existing = await existingImport(id, contentHash);
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
      try {
        parsed = await app.screenshotParser.parse({ data: buf, mimeType }, request.log);
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

      const [imp] = await app.db
        .insert(screenshotImports)
        .values({
          userId: id,
          // portfolioId is deliberately omitted — resolved at confirm time.
          parser: app.screenshotParser.name,
          parsedJson: result,
          confidence,
          contentHash,
          status: "draft",
        })
        .returning();

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

  // List the current user's imports (newest first) — id, status, parser, draft count.
  app.get("/imports", { preHandler: app.authenticate }, async (request) => {
    const { id } = requireUser(request);
    const rows = await app.db
      .select()
      .from(screenshotImports)
      .where(eq(screenshotImports.userId, id))
      .orderBy(desc(screenshotImports.createdAt));
    return rows.map((r) => {
      const parsed = (r.parsedJson ?? {}) as { drafts?: unknown[] };
      return {
        id: r.id,
        portfolioId: r.portfolioId,
        parser: r.parser,
        status: r.status,
        confidence: r.confidence,
        count: Array.isArray(parsed.drafts) ? parsed.drafts.length : 0,
        createdAt: r.createdAt,
      };
    });
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
      // For a pytr draft, durably record its events as discarded so the next sync doesn't
      // re-stage them (the collector would otherwise resurface them indefinitely).
      let resolvedEventsRecorded = 0;
      if (imp.parser === "pytr" && imp.portfolioId) {
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
                eventId,
                resolution: "discarded",
              })),
            )
            .onConflictDoNothing();
          resolvedEventsRecorded = ids.length;
        }
      }
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
      await app.db
        .update(screenshotImports)
        .set({ status: "discarded" })
        .where(eq(screenshotImports.id, imp.id));
      request.log.info({ importId: imp.id, removedTransactions: removed.length }, "import undone");
      return { removed: removed.length };
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

  // Confirm an import: write the (possibly edited) drafts as transactions.
  app.post<{ Params: { importId: string } }>(
    "/imports/:importId/confirm",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
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
      if (!imp) {
        return reply.code(404).send({ error: "import_not_found" });
      }
      if (imp.status === "confirmed") {
        return reply.code(409).send({ error: "already_confirmed" });
      }

      const { transactions: drafts, contracts, portfolioId: bodyPortfolioId } = confirmBodySchema.parse(
        request.body,
      );
      if (drafts.length === 0 && contracts.length === 0) {
        return reply.code(400).send({ error: "nothing_to_confirm" });
      }
      // Resolve the target portfolio: prefer the request body, fall back to what was
      // stored on the import (pytr always has one; legacy uploads may too). New-style
      // uploads have no stored portfolio so body is required.
      const targetPortfolioId = bodyPortfolioId ?? imp.portfolioId;
      if (!targetPortfolioId) {
        return reply.code(400).send({ error: "portfolio_required" });
      }
      if (!(await ownedPortfolio(id, targetPortfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const isDkb = imp.parser === "dkb";
      const isPytr = imp.parser === "pytr";
      // pytr is its own source; DKB exports are CSV too; otherwise a screenshot.
      const source = isPytr
        ? "pytr"
        : imp.parser === "csv" || isDkb
          ? "csv"
          : "screenshot";
      // DKB and Trade Republic are both EU/ISIN brokers — identical instrument resolution.
      const isEu = isDkb || isPytr;

      request.log.info(
        { importId: imp.id, parser: imp.parser, source, txDrafts: drafts.length, contracts: contracts.length },
        "confirm started",
      );

      // Resolve EU broker (DKB/Trade Republic) ISINs to a ticker/market/currency once
      // each (best-effort, cached). OpenFIGI is keyless; failures and unknown ISINs fall
      // back to Xetra/ISIN/EUR.
      const isinCache = new Map<
        string,
        { symbol: string; market: string; currency: string; assetClass: AssetClass } | null
      >();
      async function resolveEuIsin(isin: string) {
        if (isinCache.has(isin)) {
          request.log.debug({ isin }, "isin cache hit");
          return isinCache.get(isin)!;
        }
        let resolved: {
          symbol: string;
          market: string;
          currency: string;
          assetClass: AssetClass;
        } | null = null;
        // Trade Republic books crypto under synthetic `XF…` ISINs that OpenFIGI can't resolve;
        // recognise those first and route them to CoinGecko (priced in the broker's EUR).
        const crypto = resolveCryptoIsin(isin);
        if (crypto) {
          resolved = { ...crypto, currency: "EUR" };
        } else {
          request.log.debug({ isin, via: "openfigi" }, "isin lookup");
          try {
            const md = await getMarketData();
            const [hit] = await md.search(isin);
            if (hit) {
              resolved = {
                symbol: hit.symbol,
                market: hit.market,
                currency: hit.currency,
                assetClass: hit.assetClass,
              };
            }
          } catch (err) {
            // best-effort; never block a confirm on discovery
            request.log.warn({ isin, err }, "isin resolve failed");
          }
        }
        if (resolved) {
          request.log.debug(
            { isin, symbol: resolved.symbol, market: resolved.market, assetClass: resolved.assetClass },
            "isin resolved",
          );
        }
        isinCache.set(isin, resolved);
        return resolved;
      }

      // Pass 1 — resolve each draft's instrument (best-effort, may hit the network). Done
      // OUTSIDE the transaction so a slow OpenFIGI/provider lookup never holds a DB tx open.
      const resolved: { draft: (typeof drafts)[number]; instrumentId: string | null }[] = [];
      for (const d of drafts) {
        // Cash movements (deposit/withdrawal/interest) have no instrument.
        const isCash =
          d.action === "deposit" || d.action === "withdrawal" || d.action === "interest";
        let instrumentId: string | null = null;

        if (!isCash) {
          let symbol = d.ticker ?? d.isin ?? d.name ?? "UNKNOWN";
          let market = isEu
            ? marketForEuInstrument(d.assetClass)
            : marketForAssetClass(d.assetClass ?? "equity");
          let instrumentCurrency = d.currency;
          let assetClass = d.assetClass ?? "equity";

          // IDX KIK ETFs read "Reksa Dana" in screenshots so the parser tags them
          // mutual_fund. Their ticker reveals the truth — reclassify so they group under
          // ETFs, not reksa dana. Gated on !isEu + market === "IDX" so EU mutual funds
          // whose symbols might match the pattern are never touched. (#120)
          if (!isEu && assetClass === "mutual_fund" && market === "IDX" && isIdxEtfSymbol(symbol))
            assetClass = "etf";

          if (isEu && d.isin) {
            const r = await resolveEuIsin(d.isin);
            if (r) {
              // Always adopt the resolved ticker and asset class. Adopt the venue + currency
              // only when resolution lands on a market our providers price directly that
              // differs from the broker's Xetra/EUR default — US stocks (USD via Twelve Data)
              // and crypto (EUR via CoinGecko). Otherwise keep the Xetra/EUR pin: DKB/Trade
              // Republic execute on Xetra, and OpenFIGI's first listing for a EUR fund is
              // often another venue that no provider covers / defaults to USD (PR #130).
              symbol = r.symbol;
              assetClass = r.assetClass;
              if (PRICEABLE_FOREIGN_MARKETS.has(r.market)) {
                market = r.market;
                instrumentCurrency = r.currency;
              }
            }
          }

          const instrument = await findOrCreateInstrument(app.db, {
            symbol,
            market,
            assetClass,
            unit: d.unit ?? "shares",
            currency: instrumentCurrency,
            name: d.name ?? symbol,
            isin: d.isin ?? null,
            wkn: d.wkn ?? null,
          });
          instrumentId = instrument.id;
          request.log.debug({ symbol, market, instrumentId }, "instrument resolved");
        }
        resolved.push({ draft: d, instrumentId });
      }

      // Pass 2 — write the transactions and reconcile the import atomically.
      const parsed = (imp.parsedJson ?? {}) as {
        drafts?: { externalId?: string | null }[];
        errors?: { eventId?: string; severity?: string }[];
        seenEventIds?: string[];
      };
      let attempted = 0;
      let finalStatus: "draft" | "confirmed" = "draft";
      const created = await app.db.transaction(async (tx) => {
        const written: (typeof transactions.$inferSelect)[] = [];
        for (let i = 0; i < resolved.length; i++) {
          const { draft: d, instrumentId } = resolved[i];
          attempted++;
          const externalId = d.externalId ?? `import:${imp.id}:${i}`;
          const [row] = await tx
            .insert(transactions)
            .values({
              portfolioId: targetPortfolioId,
              instrumentId,
              type: d.action,
              quantity: d.quantity,
              price: d.price,
              fees: d.fees,
              tax: d.tax ?? null,
              executedPrice: d.executedPrice ?? null,
              fxRate: d.fxRate ?? null,
              venue: d.venue ?? null,
              documentRefs: d.documentRefs ?? null,
              kind: d.kind ?? null,
              description: d.description ?? null,
              // The cash leg is always in the transaction's own currency (EUR for DKB),
              // independent of where the instrument is listed/priced.
              currency: d.currency,
              executedAt: d.executedAt,
              source,
              importId: imp.id,
              externalId,
              savingsPlanId: d.savingsPlanId ?? null,
            })
            .onConflictDoNothing()
            .returning();
          if (row) written.push(row);
          else request.log.debug({ externalId }, "duplicate skipped");
        }

        // Financed gold contracts: create the gold instrument + loan, then insert
        // the derived legs (buy, drawdown, admin/discount fees, due installments),
        // all linked by loanId so the outstanding balance derives in @portfolio/core.
        const now = new Date();
        for (let ci = 0; ci < contracts.length; ci++) {
          const c = contracts[ci];
          const gold = goldInstrumentForContract(c);
          const instrument = await findOrCreateInstrument(tx, {
            symbol: gold.symbol,
            market: gold.market,
            assetClass: "gold",
            unit: "grams",
            currency: c.currency,
            name: gold.name,
            isin: null,
          });
          const [loan] = await tx
            .insert(loans)
            .values({
              portfolioId: targetPortfolioId,
              instrumentId: instrument.id,
              importId: imp.id,
              contractNo: c.contractNo ?? null,
              provider: c.provider ?? "GALERI24",
              purchasePrice: c.purchasePrice,
              downPayment: c.downPayment,
              adminFee: c.adminFee,
              discount: c.discount,
              principal: c.principal,
              marginTotal: c.marginTotal,
              tenorMonths: c.tenorMonths,
              monthlyInstallment: c.monthlyInstallment,
              startDate: c.startDate.toISOString().slice(0, 10),
              schedule: c.schedule.map((r) => ({
                n: r.n,
                dueDate: r.dueDate.toISOString().slice(0, 10),
                pokok: r.pokok,
                sewaModal: r.sewaModal,
                angsuran: r.angsuran,
                sisaPokok: r.sisaPokok,
              })),
              costBasisMode: c.costBasisMode,
              currency: c.currency,
            })
            .returning();

          const legs = buildContractLegs(c, now);
          for (let li = 0; li < legs.length; li++) {
            const leg = legs[li];
            attempted++;
            const externalId = `import:${imp.id}:loan:${ci}:${li}`;
            const [row] = await tx
              .insert(transactions)
              .values({
                portfolioId: targetPortfolioId,
                instrumentId: leg.role === "gold_buy" ? instrument.id : null,
                type: leg.type,
                quantity: leg.quantity,
                price: leg.price,
                fees: leg.fees,
                currency: leg.currency,
                executedAt: leg.executedAt,
                source,
                importId: imp.id,
                loanId: loan.id,
                externalId,
              })
              .onConflictDoNothing()
              .returning();
            if (row) written.push(row);
            else request.log.debug({ externalId }, "duplicate skipped");
          }
        }

        const staged = Array.isArray(parsed.drafts) ? parsed.drafts : [];
        const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
        const confirmedExtIds = new Set(
          drafts.map((d) => d.externalId).filter((x): x is string => Boolean(x)),
        );

        if (imp.parser === "pytr") {
          // Record confirmed events durably so a later manual deletion doesn't resurface them.
          if (confirmedExtIds.size) {
            await tx
              .insert(trResolvedEvents)
              .values(
                [...confirmedExtIds].map((eventId) => ({
                  portfolioId: targetPortfolioId,
                  eventId,
                  resolution: "confirmed",
                })),
              )
              .onConflictDoNothing();
          }
          // Pass-based confirm: keep the import open while drafts or *actionable* issues
          // remain (ignorable `info` issues don't hold it open); close it otherwise.
          const remaining = staged.filter(
            (d) => !(d.externalId && confirmedExtIds.has(d.externalId)),
          );
          const remainingErrors = errors.filter(
            (e) => !(e.eventId && confirmedExtIds.has(e.eventId)),
          );
          const remainingAttention = remainingErrors.filter((e) => e.severity === "attention");

          if (remaining.length > 0 || remainingAttention.length > 0) {
            await tx
              .update(screenshotImports)
              .set({ portfolioId: targetPortfolioId, parsedJson: { ...parsed, drafts: remaining, errors: remainingErrors } })
              .where(eq(screenshotImports.id, imp.id));
            finalStatus = "draft";
          } else {
            // Closing: record any leftover (ignorable) issues as resolved so the next sync
            // doesn't re-surface them.
            const leftover = remainingErrors
              .map((e) => e.eventId)
              .filter((x): x is string => Boolean(x));
            if (leftover.length) {
              await tx
                .insert(trResolvedEvents)
                .values(
                  leftover.map((eventId) => ({
                    portfolioId: targetPortfolioId,
                    eventId,
                    resolution: "discarded",
                  })),
                )
                .onConflictDoNothing();
            }
            await tx
              .update(screenshotImports)
              .set({ portfolioId: targetPortfolioId, status: "confirmed" })
              .where(eq(screenshotImports.id, imp.id));
            finalStatus = "confirmed";
          }
        } else {
          // Other importers (CSV/screenshot/DKB): pass-based prune when drafts carry stable
          // ids, else all-or-nothing — unchanged behaviour, no durable ledger.
          const everyHasId = staged.length > 0 && staged.every((d) => Boolean(d.externalId));
          const remaining = everyHasId
            ? staged.filter((d) => !(d.externalId && confirmedExtIds.has(d.externalId)))
            : [];
          if (everyHasId && remaining.length > 0) {
            await tx
              .update(screenshotImports)
              .set({ portfolioId: targetPortfolioId, parsedJson: { ...parsed, drafts: remaining } })
              .where(eq(screenshotImports.id, imp.id));
            finalStatus = "draft";
          } else {
            await tx
              .update(screenshotImports)
              .set({ portfolioId: targetPortfolioId, status: "confirmed" })
              .where(eq(screenshotImports.id, imp.id));
            finalStatus = "confirmed";
          }
        }
        return written;
      });

      request.log.info(
        {
          importId: imp.id,
          attempted,
          written: created.length,
          skippedDuplicates: attempted - created.length,
          finalStatus,
        },
        "confirm complete",
      );
      reply.code(201);
      return { confirmed: created.length, transactions: created };
    },
  );
}
