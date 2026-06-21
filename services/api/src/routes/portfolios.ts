import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { accountHolders, portfolios } from "@portfolio/db";
import { portfolioInputSchema, portfolioPatchSchema } from "@portfolio/schema";
import { requireUser } from "../plugins/auth.js";
import { flattenJoinRow, flattenPortfolio } from "../lib/portfolio.js";
import { deleteReceiptsForPortfolio } from "../storage/receipts.js";

export async function portfoliosRoute(app: FastifyInstance) {
  // Confirm an account holder (if one is given) exists and belongs to the user, so a
  // portfolio can never link to someone else's holder. Returns true when id is null.
  async function holderOwnedOrNull(userId: string, holderId: string | null | undefined) {
    if (holderId == null) return true;
    const [h] = await app.db
      .select({ id: accountHolders.id })
      .from(accountHolders)
      .where(and(eq(accountHolders.id, holderId), eq(accountHolders.userId, userId)))
      .limit(1);
    return Boolean(h);
  }

  // List the authenticated user's portfolios, with holder-derived fields flattened in.
  app.get("/portfolios", { preHandler: app.authenticate }, async (request) => {
    const { id } = requireUser(request);
    const rows = await app.db
      .select()
      .from(portfolios)
      .leftJoin(accountHolders, eq(portfolios.accountHolderId, accountHolders.id))
      .where(eq(portfolios.userId, id));
    return rows.map(flattenJoinRow);
  });

  // Create a portfolio for the authenticated user.
  app.post("/portfolios", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = requireUser(request);
    const input = portfolioInputSchema.parse(request.body);
    if (!(await holderOwnedOrNull(id, input.accountHolderId))) {
      return reply.code(404).send({ error: "account_holder_not_found" });
    }
    const [created] = await app.db
      .insert(portfolios)
      .values({
        userId: id,
        name: input.name,
        baseCurrency: input.baseCurrency,
        accountHolderId: input.accountHolderId ?? null,
        brokerage: input.brokerage ?? null,
        accountNumber: input.accountNumber ?? null,
        includeInAggregate: input.includeInAggregate,
        cashCounted: input.cashCounted,
        documentRetention: input.documentRetention,
      })
      .returning();
    reply.code(201);
    return flattenPortfolio(created, await holderFor(created.accountHolderId));
  });

  // Rename / update a portfolio (owner only). Empty body is a no-op update.
  app.patch<{ Params: { portfolioId: string } }>(
    "/portfolios/:portfolioId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      const input = portfolioPatchSchema.parse(request.body);
      if (!(await holderOwnedOrNull(id, input.accountHolderId))) {
        return reply.code(404).send({ error: "account_holder_not_found" });
      }
      const [updated] = await app.db
        .update(portfolios)
        .set(input)
        .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, id)))
        .returning();
      if (!updated) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      return flattenPortfolio(updated, await holderFor(updated.accountHolderId));
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
      // Pre-query and delete storage objects before the portfolio row is removed,
      // since DB cascade removes document rows but not the storage objects (#231).
      await deleteReceiptsForPortfolio(app, portfolioId);
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

  // Fetch a single holder row (or null) to flatten a create/update response.
  async function holderFor(holderId: string | null) {
    if (holderId == null) return null;
    const [h] = await app.db
      .select()
      .from(accountHolders)
      .where(eq(accountHolders.id, holderId))
      .limit(1);
    return h ?? null;
  }
}
