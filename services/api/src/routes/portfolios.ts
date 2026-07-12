import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { accountHolders, portfolios, transactions } from "@portfolio/db";
import { portfolioInputSchema, portfolioPatchSchema } from "@portfolio/schema";
import { requireUser } from "../plugins/auth.js";
import { flattenPortfolio } from "../lib/portfolio.js";
import { mapPool } from "../lib/promise-pool.js";
import { deleteReceiptsForPortfolio } from "../storage/receipts.js";
import { valuePortfolioCached } from "../services/valuation.js";
import { getMarketData } from "../services/market-data.js";

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
  // Each row carries `transactionCount` (a cheap correlated count over the indexed
  // portfolioId) so the delete-confirm UI can state how much data it will remove.
  app.get("/portfolios", { preHandler: app.authenticate }, async (request) => {
    const { id } = requireUser(request);
    const rows = await app.db
      .select({
        portfolio: portfolios,
        holder: accountHolders,
        transactionCount: sql<number>`(select count(*)::int from ${transactions}
          where ${transactions.portfolioId} = ${portfolios.id})`,
      })
      .from(portfolios)
      .leftJoin(accountHolders, eq(portfolios.accountHolderId, accountHolders.id))
      .where(eq(portfolios.userId, id));
    return rows.map((r) => ({
      ...flattenPortfolio(r.portfolio, r.holder),
      transactionCount: Number(r.transactionCount),
    }));
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
        iban: input.iban ?? null,
        includeInAggregate: input.includeInAggregate,
        cashCounted: input.cashCounted,
        allowNegativeCash: input.allowNegativeCash,
        documentRetention: input.documentRetention,
        taxAllowanceAnnual: input.taxAllowanceAnnual ?? null,
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
      // Ownership check FIRST: deleteReceiptsForPortfolio deletes storage objects for
      // any portfolioId with no userId scope of its own, so it must never run before
      // we've confirmed the caller owns this portfolio.
      const [owned] = await app.db
        .select({ id: portfolios.id })
        .from(portfolios)
        .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, id)))
        .limit(1);
      if (!owned) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      // Pre-query and delete storage objects before the portfolio row is removed,
      // since DB cascade removes document rows but not the storage objects (#231).
      await deleteReceiptsForPortfolio(app, portfolioId);
      await app.db
        .delete(portfolios)
        .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, id)));
      return reply.code(204).send();
    },
  );

  // Live net-worth for every portfolio the user owns — one request instead of N summary calls.
  // Each portfolio is valued against its own base currency so no FX conversion is needed.
  app.get("/portfolios/values", { preHandler: app.authenticate }, async (request) => {
    const { id } = requireUser(request);
    const pfs = await app.db
      .select({ id: portfolios.id, baseCurrency: portfolios.baseCurrency, cashCounted: portfolios.cashCounted })
      .from(portfolios)
      .where(eq(portfolios.userId, id));

    const marketData = await getMarketData();
    // Each portfolio's valuation is independent — bounded-concurrency instead of a
    // serial `for` await (a user with many portfolios paid one full valuation's worth
    // of DB round trips per portfolio, one at a time). Capped at 4 in flight to stay
    // well under the postgres-js pool (`max: 10` in db/client.ts, shared with pg-boss's
    // own `max: 5`) rather than an unbounded Promise.all that could saturate it.
    const results = await mapPool(pfs, 4, async (p) => {
      const { summary } = await valuePortfolioCached(
        app.db,
        marketData,
        app.config.MARKET_DATA_TTL_MS,
        p.id,
        p.baseCurrency,
        undefined,
        p.cashCounted,
      );
      return { id: p.id, netWorth: summary.netWorth };
    });
    return results;
  });

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
