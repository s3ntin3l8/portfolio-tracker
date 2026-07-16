import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { corporateActions } from "@portfolio/db";
import { corporateActionInputSchema } from "@portfolio/schema";

export async function corporateActionsRoute(app: FastifyInstance) {
  // Record a corporate action (split/bonus/rights) for an instrument. Shared
  // reference data — applied to every holder's derived holdings. Admin-gated (a bogus
  // split/ratio corrupts every holder's quantities and cost basis).
  app.post("/corporate-actions", { preHandler: app.requireAdmin }, async (request, reply) => {
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
  });

  // Update a corporate action (type / ratio / ex-date / terms). Reference data —
  // edits flow through to every holder's derived holdings. Admin-gated (same reasoning
  // as the POST above).
  app.patch<{ Params: { id: string } }>(
    "/corporate-actions/:id",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const input = corporateActionInputSchema.partial().parse(request.body);
      const values: Partial<typeof corporateActions.$inferInsert> = {};
      if (input.type !== undefined) values.type = input.type;
      if (input.ratio !== undefined) values.ratio = input.ratio;
      if (input.exDate !== undefined) values.exDate = input.exDate.toISOString().slice(0, 10);
      if (input.terms !== undefined) values.terms = input.terms ?? null;
      if (Object.keys(values).length === 0) {
        reply.code(400);
        return { error: "no fields to update" };
      }
      const [updated] = await app.db
        .update(corporateActions)
        .set(values)
        .where(eq(corporateActions.id, request.params.id))
        .returning();
      if (!updated) {
        reply.code(404);
        return { error: "not found" };
      }
      return updated;
    },
  );

  // Delete a corporate action. Admin-gated (same reasoning as POST/PATCH above).
  app.delete<{ Params: { id: string } }>(
    "/corporate-actions/:id",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const [deleted] = await app.db
        .delete(corporateActions)
        .where(eq(corporateActions.id, request.params.id))
        .returning();
      if (!deleted) {
        reply.code(404);
        return { error: "not found" };
      }
      reply.code(204);
      return null;
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
