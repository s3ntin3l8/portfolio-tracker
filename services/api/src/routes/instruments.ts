import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { asc, eq, ilike, or } from "drizzle-orm";
import { instruments, providerSettings } from "@portfolio/db";
import { instrumentInputSchema } from "@portfolio/schema";
import { findOrCreateInstrument } from "../services/instruments.js";
import { getMarketData, goldSources } from "../services/market-data.js";

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const lookupQuerySchema = z.object({ q: z.string().trim().min(1) });
const historyQuerySchema = z.object({ range: z.string().default("1y") });

export async function instrumentsRoute(app: FastifyInstance) {
  // Search instruments (shared reference data) for the manual-entry picker.
  app.get("/instruments", { preHandler: app.authenticate }, async (request) => {
    const { q, limit } = searchQuerySchema.parse(request.query);
    if (q) {
      return app.db
        .select()
        .from(instruments)
        .where(or(ilike(instruments.symbol, `%${q}%`), ilike(instruments.name, `%${q}%`)))
        .orderBy(asc(instruments.symbol))
        .limit(limit);
    }
    return app.db.select().from(instruments).orderBy(asc(instruments.symbol)).limit(limit);
  });

  // Discover instruments from market-data providers (ticker/name search or ISIN
  // resolution) to auto-fill the manual-entry form. Complements `GET /instruments`,
  // which only matches already-saved reference data. Provider failures degrade to [].
  app.get("/instruments/lookup", { preHandler: app.authenticate }, async (request) => {
    const { q } = lookupQuerySchema.parse(request.query);
    try {
      const md = await getMarketData();
      return await md.search(q);
    } catch (err) {
      request.log.warn({ err }, "instrument lookup failed");
      return [];
    }
  });

  // Selectable gold buyback sources (Antam, and any other configured gold provider) for the
  // manual-entry form's gold flow. Each maps to the `market` to stamp on the instrument so
  // quotes route to the right provider. Registry-driven — no UI change when a source is added.
  app.get("/instruments/gold-sources", { preHandler: app.authenticate }, async () => {
    const rows = await app.db
      .select({
        provider: providerSettings.provider,
        enabled: providerSettings.enabled,
        priority: providerSettings.priority,
      })
      .from(providerSettings);
    return goldSources(rows);
  });

  // Fetch a single instrument by id.
  app.get<{ Params: { id: string } }>(
    "/instruments/:id",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const [inst] = await app.db
        .select()
        .from(instruments)
        .where(eq(instruments.id, request.params.id))
        .limit(1);
      if (!inst) return reply.code(404).send({ error: "instrument_not_found" });
      return inst;
    },
  );

  // Price history (candles) for an instrument's detail chart.
  app.get<{ Params: { id: string } }>(
    "/instruments/:id/history",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { range } = historyQuerySchema.parse(request.query);
      const [inst] = await app.db
        .select()
        .from(instruments)
        .where(eq(instruments.id, request.params.id))
        .limit(1);
      if (!inst) return reply.code(404).send({ error: "instrument_not_found" });
      const md = await getMarketData();
      return md.getHistory(
        {
          symbol: inst.symbol,
          market: inst.market,
          assetClass: inst.assetClass,
          currency: inst.currency,
        },
        range,
      );
    },
  );

  // Find-or-create an instrument by its (market, symbol) identity.
  app.post("/instruments", { preHandler: app.authenticate }, async (request, reply) => {
    const input = instrumentInputSchema.parse(request.body);
    const instrument = await findOrCreateInstrument(app.db, input);
    reply.code(201);
    return instrument;
  });
}
