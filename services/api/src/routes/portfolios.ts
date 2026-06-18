import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { portfolios } from "@portfolio/db";
import { portfolioInputSchema, portfolioPatchSchema } from "@portfolio/schema";
import { requireUser } from "../plugins/auth.js";

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
      .values({
        userId: id,
        name: input.name,
        baseCurrency: input.baseCurrency,
        portfolioType: input.portfolioType,
        // Birth year only applies to child portfolios.
        birthYear: input.portfolioType === "child" ? (input.birthYear ?? null) : null,
        brokerage: input.brokerage ?? null,
        accountHolder: input.accountHolder ?? null,
        accountNumber: input.accountNumber ?? null,
        includeInAggregate: input.includeInAggregate,
      })
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
      // Flipping a portfolio back to "standard" clears any stored birth year so it
      // can't leak into the forecast.
      const patch =
        input.portfolioType === "standard" ? { ...input, birthYear: null } : input;
      const [updated] = await app.db
        .update(portfolios)
        .set(patch)
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
