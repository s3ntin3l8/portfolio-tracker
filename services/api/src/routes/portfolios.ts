import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { portfolios } from "@portfolio/db";
import { portfolioInputSchema } from "@portfolio/schema";
import { requireUser } from "../plugins/auth.js";

// Partial of the create schema: the rename/settings PATCH may touch a subset.
const portfolioPatchSchema = portfolioInputSchema.partial();

export async function portfoliosRoute(app: FastifyInstance) {
  // List the authenticated user's portfolios.
  app.get("/portfolios", { preHandler: app.authenticate }, async (request) => {
    const { id } = requireUser(request);
    return app.db.select().from(portfolios).where(eq(portfolios.userId, id));
  });

  // Create a portfolio for the authenticated user.
  app.post("/portfolios", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = requireUser(request);
    const input = portfolioInputSchema.parse(request.body);
    const [created] = await app.db
      .insert(portfolios)
      .values({ userId: id, name: input.name, baseCurrency: input.baseCurrency })
      .returning();
    reply.code(201);
    return created;
  });

  // Rename / update a portfolio (owner only). Empty body is a no-op update.
  app.patch<{ Params: { portfolioId: string } }>(
    "/portfolios/:portfolioId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      const input = portfolioPatchSchema.parse(request.body);
      const [updated] = await app.db
        .update(portfolios)
        .set(input)
        .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, id)))
        .returning();
      if (!updated) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      return updated;
    },
  );

  // Delete a portfolio (owner only). Transactions and daily snapshots cascade;
  // screenshot imports keep their history with portfolio_id set null.
  app.delete<{ Params: { portfolioId: string } }>(
    "/portfolios/:portfolioId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      const [deleted] = await app.db
        .delete(portfolios)
        .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, id)))
        .returning();
      if (!deleted) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      return reply.code(204).send();
    },
  );
}
