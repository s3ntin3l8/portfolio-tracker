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
  image: z.string().min(1), // base64-encoded image bytes
  mimeType: z.string().default("image/png"),
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

  // Fetch a draft import (owner only).
  app.get<{ Params: { importId: string } }>(
    "/imports/:importId",
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
      if (!imp) return reply.code(404).send({ error: "import_not_found" });
      return imp;
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
      // DKB exports are CSV too; anything that isn't a CSV/DKB import is a screenshot.
      const source = imp.parser === "csv" || isDkb ? "csv" : "screenshot";
      const created = [];

      // Resolve DKB ISINs to a ticker/market/currency once each (best-effort, cached).
      // OpenFIGI is keyless; failures and unknown ISINs fall back to Xetra/ISIN/EUR.
      const isinCache = new Map<
        string,
        { symbol: string; market: string; currency: string; assetClass: AssetClass } | null
      >();
      async function resolveDkbIsin(isin: string) {
        if (isinCache.has(isin)) return isinCache.get(isin)!;
        let resolved: {
          symbol: string;
          market: string;
          currency: string;
          assetClass: AssetClass;
        } | null = null;
        try {
          const [hit] = await getMarketData().search(isin);
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
        isinCache.set(isin, resolved);
        return resolved;
      }

      for (let i = 0; i < drafts.length; i++) {
        const d = drafts[i];

        // Cash movements (deposit/withdrawal) have no instrument.
        const isCash = d.action === "deposit" || d.action === "withdrawal";
        let instrumentId: string | null = null;

        if (!isCash) {
          let symbol = d.ticker ?? d.isin ?? d.name ?? "UNKNOWN";
          let market = isDkb
            ? marketForEuInstrument(d.assetClass)
            : marketForAssetClass(d.assetClass ?? "equity");
          let instrumentCurrency = d.currency;
          let assetClass = d.assetClass ?? "equity";

          if (isDkb && d.isin) {
            const r = await resolveDkbIsin(d.isin);
            if (r) {
              symbol = r.symbol;
              market = r.market;
              instrumentCurrency = r.currency;
              assetClass = r.assetClass;
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

        const [tx] = await app.db
          .insert(transactions)
          .values({
            portfolioId: imp.portfolioId,
            instrumentId,
            type: d.action,
            quantity: d.quantity,
            price: d.price,
            fees: d.fees,
            // The cash leg is always in the transaction's own currency (EUR for DKB),
            // independent of where the instrument is listed/priced.
            currency: d.currency,
            executedAt: d.executedAt,
            source,
            importId: imp.id,
            externalId: d.externalId ?? `import:${imp.id}:${i}`,
          })
          .onConflictDoNothing()
          .returning();
        if (tx) created.push(tx);
      }

      await app.db
        .update(screenshotImports)
        .set({ status: "confirmed" })
        .where(eq(screenshotImports.id, imp.id));

      reply.code(201);
      return { confirmed: created.length, transactions: created };
    },
  );
}
