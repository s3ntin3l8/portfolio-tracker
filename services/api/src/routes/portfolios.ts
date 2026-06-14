import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { portfolios } from "@portfolio/db";
import { portfolioInputSchema } from "@portfolio/schema";
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
      .values({ userId: id, name: input.name, baseCurrency: input.baseCurrency })
      .returning();
    reply.code(201);
    return created;
  });
}
