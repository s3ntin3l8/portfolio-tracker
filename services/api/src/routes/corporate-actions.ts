import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { corporateActions } from "@portfolio/db";
import { corporateActionInputSchema } from "@portfolio/schema";

export async function corporateActionsRoute(app: FastifyInstance) {
  // Record a corporate action (split/bonus/rights) for an instrument. Shared
  // reference data — applied to every holder's derived holdings.
  app.post(
    "/corporate-actions",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const input = corporateActionInputSchema.parse(request.body);
      const [created] = await app.db
        .insert(corporateActions)
        .values({
          instrumentId: input.instrumentId,
          type: input.type,
          ratio: input.ratio,
          exDate: input.exDate.toISOString().slice(0, 10),
          terms: input.terms ?? null,
        })
        .returning();
      reply.code(201);
      return created;
    },
  );

  // List an instrument's corporate actions.
  app.get<{ Params: { instrumentId: string } }>(
    "/instruments/:instrumentId/corporate-actions",
    { preHandler: app.authenticate },
    async (request) => {
      return app.db
        .select()
        .from(corporateActions)
        .where(eq(corporateActions.instrumentId, request.params.instrumentId));
    },
  );
}
