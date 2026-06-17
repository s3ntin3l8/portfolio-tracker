import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { portfolios, screenshotImports, transactions } from "@portfolio/db";
import { parsedTransactionSchema, type AssetClass } from "@portfolio/schema";
import { requireUser } from "../plugins/auth.js";
import { parseCsv } from "../services/parsers/csv.js";
import { parseDkb } from "../services/parsers/dkb.js";
import { parseIbkr } from "../services/parsers/ibkr.js";
import { parseCoinbase } from "../services/parsers/coinbase.js";
import { detectCsvFormat } from "../services/parsers/detect.js";
import {
  findOrCreateInstrument,
  marketForAssetClass,
  marketForEuInstrument,
} from "../services/instruments.js";
import { getMarketData } from "../services/market-data.js";
import { resolveCryptoIsin, PRICEABLE_FOREIGN_MARKETS } from "@portfolio/market-data";

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
const screenshotBodySchema = z.object({
  image: z.string().min(1), // base64-encoded document bytes (image or PDF)
  mimeType: z
    .string()
    .default("image/png")
    .refine(
      (m) => m.startsWith("image/") || m === "application/pdf",
      "unsupported_media_type",
    ),
});
const confirmBodySchema = z.object({
  transactions: z.array(parsedTransactionSchema).min(1),
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

  // Parse a CSV into draft transactions and store them as a draft import.
  app.post<{ Params: { portfolioId: string } }>(
    "/portfolios/:portfolioId/imports/csv",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      if (!(await ownedPortfolio(id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const { content, format } = csvBodySchema.parse(request.body);
      const resolved = format === "auto" ? detectCsvFormat(content) : format;
      const result = CSV_PARSERS[resolved](content);

      const [imp] = await app.db
        .insert(screenshotImports)
        .values({
          userId: id,
          portfolioId,
          parser: PARSER_TAG[resolved] ?? "csv",
          parsedJson: result,
          status: "draft",
        })
        .returning();

      reply.code(201);
      return { importId: imp.id, drafts: result.drafts, errors: result.errors };
    },
  );

  // Parse a screenshot into draft transactions and store them as a draft import.
  // The raw image is parsed then discarded (never persisted) — privacy by default.
  app.post<{ Params: { portfolioId: string } }>(
    "/portfolios/:portfolioId/imports/screenshot",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      if (!(await ownedPortfolio(id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      if (!app.screenshotParser.isConfigured()) {
        return reply.code(503).send({ error: "screenshot_parser_not_configured" });
      }

      const { image, mimeType } = screenshotBodySchema.parse(request.body);
      let drafts;
      try {
        drafts = await app.screenshotParser.parse({
          data: Buffer.from(image, "base64"),
          mimeType,
        });
      } catch (err) {
        request.log.error({ err }, "screenshot parse failed");
        return reply.code(502).send({ error: "screenshot_parse_failed" });
      }

      const confidence =
        drafts.length > 0
          ? String(drafts.reduce((s, d) => s + d.confidence, 0) / drafts.length)
          : null;
      const result = { drafts, errors: [] as { line: number; message: string }[] };

      const [imp] = await app.db
        .insert(screenshotImports)
        .values({
          userId: id,
          portfolioId,
          parser: app.screenshotParser.name,
          parsedJson: result,
          confidence,
          status: "draft",
        })
        .returning();

      reply.code(201);
      return { importId: imp.id, drafts: result.drafts, errors: result.errors };
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
      await app.db
        .update(screenshotImports)
        .set({ status: "discarded" })
        .where(eq(screenshotImports.id, imp.id));
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
      await app.db
        .update(screenshotImports)
        .set({ status: "discarded" })
        .where(eq(screenshotImports.id, imp.id));
      return { removed: removed.length };
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
        errors?: { line: number; message: string }[];
      };
      return {
        id: imp.id,
        portfolioId: imp.portfolioId,
        parser: imp.parser,
        status: imp.status,
        drafts: Array.isArray(parsed.drafts) ? parsed.drafts : [],
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
      if (!imp || !imp.portfolioId) {
        return reply.code(404).send({ error: "import_not_found" });
      }
      if (imp.status === "confirmed") {
        return reply.code(409).send({ error: "already_confirmed" });
      }

      const { transactions: drafts } = confirmBodySchema.parse(request.body);
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

      // Resolve EU broker (DKB/Trade Republic) ISINs to a ticker/market/currency once
      // each (best-effort, cached). OpenFIGI is keyless; failures and unknown ISINs fall
      // back to Xetra/ISIN/EUR.
      const isinCache = new Map<
        string,
        { symbol: string; market: string; currency: string; assetClass: AssetClass } | null
      >();
      async function resolveEuIsin(isin: string) {
        if (isinCache.has(isin)) return isinCache.get(isin)!;
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
          } catch {
            // best-effort; never block a confirm on discovery
          }
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
          });
          instrumentId = instrument.id;
        }
        resolved.push({ draft: d, instrumentId });
      }

      // Pass 2 — write the transactions and reconcile the import atomically.
      const parsed = (imp.parsedJson ?? {}) as {
        drafts?: { externalId?: string | null }[];
        errors?: { eventId?: string }[];
        seenEventIds?: string[];
      };
      const created = await app.db.transaction(async (tx) => {
        const written: (typeof transactions.$inferSelect)[] = [];
        for (let i = 0; i < resolved.length; i++) {
          const { draft: d, instrumentId } = resolved[i];
          const [row] = await tx
            .insert(transactions)
            .values({
              portfolioId: imp.portfolioId!,
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
              externalId: d.externalId ?? `import:${imp.id}:${i}`,
              savingsPlanId: d.savingsPlanId ?? null,
            })
            .onConflictDoNothing()
            .returning();
          if (row) written.push(row);
        }

        // Pass-based confirm: when every staged draft has a stable id (the pytr collector),
        // keep the row open with the un-confirmed remainder so the user can confirm in passes;
        // close it only once nothing is left. Importers without stable ids (CSV/screenshot)
        // keep the all-or-nothing behaviour.
        const staged = Array.isArray(parsed.drafts) ? parsed.drafts : [];
        const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
        const everyHasId = staged.length > 0 && staged.every((d) => Boolean(d.externalId));
        const confirmedExtIds = new Set(
          drafts.map((d) => d.externalId).filter((x): x is string => Boolean(x)),
        );
        const remaining = everyHasId
          ? staged.filter((d) => !(d.externalId && confirmedExtIds.has(d.externalId)))
          : [];
        // Drop issues the user just mapped + confirmed (their event id is now a transaction).
        const remainingErrors = errors.filter(
          (e) => !(e.eventId && confirmedExtIds.has(e.eventId)),
        );

        if (everyHasId && (remaining.length > 0 || remainingErrors.length > 0)) {
          await tx
            .update(screenshotImports)
            .set({ parsedJson: { ...parsed, drafts: remaining, errors: remainingErrors } })
            .where(eq(screenshotImports.id, imp.id));
        } else {
          await tx
            .update(screenshotImports)
            .set({ status: "confirmed" })
            .where(eq(screenshotImports.id, imp.id));
        }
        return written;
      });

      reply.code(201);
      return { confirmed: created.length, transactions: created };
    },
  );
}
