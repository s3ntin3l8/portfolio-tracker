import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { asc, eq, ilike, or } from "drizzle-orm";
import { instruments } from "@portfolio/db";
import { instrumentInputSchema } from "@portfolio/schema";
import { findOrCreateInstrument } from "../services/instruments.js";
import { getMarketData } from "../services/market-data.js";

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const historyQuerySchema = z.object({ range: z.string().default("1y") });

export async function instrumentsRoute(app: FastifyInstance) {
  // Search instruments (shared reference data) for the manual-entry picker.
  app.get(
    "/instruments",
    { preHandler: app.authenticate },
    async (request) => {
      const { q, limit } = searchQuerySchema.parse(request.query);
      if (q) {
        return app.db
          .select()
          .from(instruments)
          .where(
            or(
              ilike(instruments.symbol, `%${q}%`),
              ilike(instruments.name, `%${q}%`),
            ),
          )
          .orderBy(asc(instruments.symbol))
          .limit(limit);
      }
      return app.db
        .select()
        .from(instruments)
        .orderBy(asc(instruments.symbol))
        .limit(limit);
    },
  );

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
      return getMarketData().getHistory(
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
  app.post(
    "/instruments",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const input = instrumentInputSchema.parse(request.body);
      const instrument = await findOrCreateInstrument(app.db, input);
      reply.code(201);
      return instrument;
    },
  );
}
