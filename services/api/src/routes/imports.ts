import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { portfolios, screenshotImports, transactions } from "@portfolio/db";
import { parsedTransactionSchema } from "@portfolio/schema";
import { requireUser } from "../plugins/auth.js";
import { parseCsv } from "../services/parsers/csv.js";
import {
  findOrCreateInstrument,
  marketForAssetClass,
} from "../services/instruments.js";

const csvBodySchema = z.object({ content: z.string().min(1) });
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
      const { content } = csvBodySchema.parse(request.body);
      const result = parseCsv(content);

      const [imp] = await app.db
        .insert(screenshotImports)
        .values({
          userId: id,
          portfolioId,
          parser: "csv",
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
      // Anything that isn't a CSV import (claude/ollama/gemini/...) is a screenshot.
      const source = imp.parser === "csv" ? "csv" : "screenshot";
      const created = [];

      for (let i = 0; i < drafts.length; i++) {
        const d = drafts[i];
        const symbol = d.ticker ?? d.isin ?? d.name ?? "UNKNOWN";

        const instrument = await findOrCreateInstrument(app.db, {
          symbol,
          market: marketForAssetClass(d.assetClass),
          assetClass: d.assetClass,
          unit: d.unit,
          currency: d.currency,
          name: d.name ?? symbol,
          isin: d.isin ?? null,
        });

        const [tx] = await app.db
          .insert(transactions)
          .values({
            portfolioId: imp.portfolioId,
            instrumentId: instrument.id,
            type: d.action,
            quantity: d.quantity,
            price: d.price,
            fees: d.fees,
            currency: d.currency,
            executedAt: d.executedAt,
            source,
            importId: imp.id,
            externalId: `import:${imp.id}:${i}`,
          })
          .returning();
        created.push(tx);
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
