import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import {
  transactions,
  trResolvedEvents,
  dismissedAnomalies,
} from "@portfolio/db";
import { transactionInputSchema } from "@portfolio/schema";
import { requireUser } from "../../plugins/auth.js";
import { enqueueRecompute } from "../../services/scheduler.js";
import { reassignTransactions } from "../../services/reassign.js";
import { mergeTransactions, previewMerge, MergeBlockedError } from "../../services/merge.js";
import { deleteReceiptsForTransactions } from "../../storage/receipts.js";
import type { PortfolioParams} from "./shared.js";
import { ownedPortfolio, bulkDeleteSchema } from "./shared.js";

export function registerCrudRoutes(app: FastifyInstance) {
  app.post<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/transactions",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      if (!(await ownedPortfolio(app, id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const input = transactionInputSchema.parse({
        ...(request.body as Record<string, unknown>),
        portfolioId,
      });
      const [created] = await app.db
        .insert(transactions)
        .values({
          portfolioId,
          instrumentId: input.instrumentId ?? null,
          type: input.type,
          quantity: input.quantity,
          price: input.price,
          fees: input.fees,
          tax: input.tax ?? null,
          fxRate: input.fxRate ?? null,
          perShare: input.perShare ?? null,
          shares: input.shares ?? null,
          nativeCurrency: input.nativeCurrency ?? null,
          grossNative: input.grossNative ?? null,
          description: input.description ?? null,
          tags: input.tags ?? null,
          currency: input.currency,
          executedAt: input.executedAt,
          source: input.source,
          externalId: input.externalId,
          kind: input.kind ?? null,
        })
        .returning();
      await enqueueRecompute(portfolioId, new Date(input.executedAt).toISOString().slice(0, 10));
      reply.code(201);
      return created;
    },
  );

  app.delete<{ Params: PortfolioParams & { txId: string } }>(
    "/portfolios/:portfolioId/transactions/:txId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId, txId } = request.params;
      if (!(await ownedPortfolio(app, id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const [deleted] = await app.db
        .delete(transactions)
        .where(and(eq(transactions.id, txId), eq(transactions.portfolioId, portfolioId)))
        .returning();
      if (!deleted) {
        return reply.code(404).send({ error: "transaction_not_found" });
      }
      await deleteReceiptsForTransactions(
        app,
        [deleted.id],
        deleted.importId ? [deleted.importId] : [],
      );
      await enqueueRecompute(portfolioId, deleted.executedAt.toISOString().slice(0, 10));
      return reply.code(204).send();
    },
  );

  app.post<{ Params: PortfolioParams; Body: { ids?: unknown } }>(
    "/portfolios/:portfolioId/transactions/bulk-delete",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      if (!(await ownedPortfolio(app, id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const { ids } = bulkDeleteSchema.parse(request.body);
      const deleted = await app.db
        .delete(transactions)
        .where(and(eq(transactions.portfolioId, portfolioId), inArray(transactions.id, ids)))
        .returning({ id: transactions.id, importId: transactions.importId });
      if (deleted.length > 0) {
        await deleteReceiptsForTransactions(
          app,
          deleted.map((d) => d.id),
          deleted.map((d) => d.importId).filter((x): x is string => x !== null),
        );
      }
      return { deleted: deleted.length };
    },
  );

  app.patch<{ Params: PortfolioParams & { txId: string } }>(
    "/portfolios/:portfolioId/transactions/:txId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId, txId } = request.params;
      if (!(await ownedPortfolio(app, id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const input = transactionInputSchema.parse({
        ...(request.body as Record<string, unknown>),
        portfolioId,
      });
      const [updated] = await app.db
        .update(transactions)
        .set({
          instrumentId: input.instrumentId ?? null,
          type: input.type,
          quantity: input.quantity,
          price: input.price,
          fees: input.fees,
          tax: input.tax ?? null,
          fxRate: input.fxRate ?? null,
          perShare: input.perShare ?? null,
          shares: input.shares ?? null,
          nativeCurrency: input.nativeCurrency ?? null,
          grossNative: input.grossNative ?? null,
          description: input.description ?? null,
          tags: input.tags ?? null,
          currency: input.currency,
          executedAt: input.executedAt,
          source: input.source,
          externalId: input.externalId,
          kind: input.kind ?? null,
        })
        .where(and(eq(transactions.id, txId), eq(transactions.portfolioId, portfolioId)))
        .returning();
      if (!updated) {
        return reply.code(404).send({ error: "transaction_not_found" });
      }
      await enqueueRecompute(portfolioId, updated.executedAt.toISOString().slice(0, 10));
      return updated;
    },
  );

  const statusBodySchema = z.object({
    status: z.enum(["normal", "archived", "cash_neutral"]),
  });
  app.patch<{ Params: PortfolioParams & { txId: string } }>(
    "/portfolios/:portfolioId/transactions/:txId/status",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId, txId } = request.params;
      if (!(await ownedPortfolio(app, id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const { status } = statusBodySchema.parse(request.body);
      const [updated] = await app.db
        .update(transactions)
        .set({ status })
        .where(and(eq(transactions.id, txId), eq(transactions.portfolioId, portfolioId)))
        .returning();
      if (!updated) {
        return reply.code(404).send({ error: "transaction_not_found" });
      }
      await enqueueRecompute(portfolioId, updated.executedAt.toISOString().slice(0, 10));
      return updated;
    },
  );

  const dismissAnomalySchema = z.object({
    transactionId: z.guid(),
    code: z.string().min(1),
  });
  app.post<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/anomalies/dismiss",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      if (!(await ownedPortfolio(app, id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const { transactionId, code } = dismissAnomalySchema.parse(request.body);
      const [tx] = await app.db
        .select({ id: transactions.id })
        .from(transactions)
        .where(and(eq(transactions.id, transactionId), eq(transactions.portfolioId, portfolioId)))
        .limit(1);
      if (!tx) {
        return reply.code(404).send({ error: "transaction_not_found" });
      }
      await app.db
        .insert(dismissedAnomalies)
        .values({ userId: id, portfolioId, transactionId, code })
        .onConflictDoNothing();
      return reply.code(204).send();
    },
  );
  app.delete<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/anomalies/dismiss",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      if (!(await ownedPortfolio(app, id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const { transactionId, code } = dismissAnomalySchema.parse(request.body);
      await app.db
        .delete(dismissedAnomalies)
        .where(
          and(
            eq(dismissedAnomalies.portfolioId, portfolioId),
            eq(dismissedAnomalies.transactionId, transactionId),
            eq(dismissedAnomalies.code, code),
          ),
        );
      return reply.code(204).send();
    },
  );

  const resolveDraftsSchema = z.object({
    ids: z.array(z.string().uuid()).min(1),
    action: z.enum(["confirm", "discard"]),
  });
  app.post<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/transactions/resolve-drafts",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      if (!(await ownedPortfolio(app, id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const { ids, action } = resolveDraftsSchema.parse(request.body);
      const nextStatus = action === "confirm" ? "normal" : "archived";
      const resolution = action === "confirm" ? "confirmed" : "discarded";

      const updated = await app.db
        .update(transactions)
        .set({ status: nextStatus })
        .where(
          and(
            eq(transactions.portfolioId, portfolioId),
            eq(transactions.status, "draft"),
            inArray(transactions.id, ids),
          ),
        )
        .returning({
          id: transactions.id,
          source: transactions.source,
          externalId: transactions.externalId,
          executedAt: transactions.executedAt,
        });

      const ledgerRows = updated
        .filter((r) => (r.source === "pytr" || r.source === "ibkr") && r.externalId)
        .map((r) => ({
          portfolioId,
          source: r.source as "pytr" | "ibkr",
          eventId: r.externalId as string,
          resolution,
        }));
      if (ledgerRows.length > 0) {
        await app.db.insert(trResolvedEvents).values(ledgerRows).onConflictDoNothing();
      }

      const days = new Set(updated.map((r) => r.executedAt.toISOString().slice(0, 10)));
      for (const day of days) await enqueueRecompute(portfolioId, day);

      return { updated: updated.length };
    },
  );

  const reassignSchema = z.object({
    ids: z.array(z.string().uuid()).min(1),
    targetPortfolioId: z.string().uuid(),
  });
  app.post<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/transactions/reassign",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      const { ids, targetPortfolioId } = reassignSchema.parse(request.body);
      if (portfolioId === targetPortfolioId) {
        return reply.code(400).send({ error: "same_portfolio" });
      }
      if (!(await ownedPortfolio(app, id, portfolioId)) || !(await ownedPortfolio(app, id, targetPortfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }

      const res = await reassignTransactions(app.db, {
        rowIds: ids,
        fromPortfolioId: portfolioId,
        toPortfolioId: targetPortfolioId,
      });
      for (const { portfolioId: pid, day } of res.recompute) await enqueueRecompute(pid, day);

      return {
        moved: res.moved,
        skippedConflicts: res.skippedConflicts,
        skippedLoans: res.skippedLoans,
      };
    },
  );

  app.get<{ Params: PortfolioParams; Querystring: { survivorId?: string; absorbedId?: string } }>(
    "/portfolios/:portfolioId/transactions/merge-preview",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      if (!(await ownedPortfolio(app, id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const query = z
        .object({ survivorId: z.uuid(), absorbedId: z.uuid() })
        .safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: "invalid_query" });

      const preview = await previewMerge(app.db, { portfolioId, ...query.data });
      return preview;
    },
  );

  const mergeSchema = z
    .object({ survivorId: z.uuid(), absorbedId: z.uuid() })
    .refine((v) => v.survivorId !== v.absorbedId, { message: "same_transaction" });
  app.post<{ Params: PortfolioParams }>(
    "/portfolios/:portfolioId/transactions/merge",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      if (!(await ownedPortfolio(app, id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const parsed = mergeSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      try {
        const result = await mergeTransactions(app.db, { portfolioId, ...parsed.data });
        for (const { portfolioId: pid, day } of result.recompute) await enqueueRecompute(pid, day);
        return { survivorId: result.survivorId };
      } catch (err) {
        if (err instanceof MergeBlockedError) {
          const status = err.reason === "not_found" ? 404 : 400;
          return reply.code(status).send({ error: `cannot_merge_${err.reason}` });
        }
        throw err;
      }
    },
  );
}
