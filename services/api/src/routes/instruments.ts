import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { asc, ilike, or } from "drizzle-orm";
import { instruments } from "@portfolio/db";
import { instrumentInputSchema } from "@portfolio/schema";
import { findOrCreateInstrument } from "../services/instruments.js";

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

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
