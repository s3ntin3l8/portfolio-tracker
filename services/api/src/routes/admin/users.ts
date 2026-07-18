import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import {
  users,
  portfolios,
  transactions,
  documents,
  apiTokens,
  adminAuditLog,
} from "@portfolio/db";
import { deleteStorageObjectsByKey } from "../../storage/receipts.js";

export function registerUsersRoutes(app: FastifyInstance) {
  app.get(
    "/admin/users",
    {
      config: { rateLimit: { max: 40, timeWindow: "1 minute" } },
      preHandler: app.requireAdmin,
    },
    async () => {
      const rows = await app.db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          createdAt: users.createdAt,
          onboardingCompletedAt: users.onboardingCompletedAt,
          portfolioCount: sql<number>`count(distinct ${portfolios.id})`,
          transactionCount: sql<number>`count(distinct ${transactions.id})`,
          documentCount: sql<number>`count(distinct ${documents.id})`,
          storageBytes: sql<number>`coalesce((select sum(${documents.sizeBytes})
            from ${documents} where ${documents.userId} = ${users.id}), 0)`,
          tokenCount: sql<number>`count(distinct ${apiTokens.id})`,
        })
        .from(users)
        .leftJoin(portfolios, eq(portfolios.userId, users.id))
        .leftJoin(transactions, eq(transactions.portfolioId, portfolios.id))
        .leftJoin(documents, eq(documents.userId, users.id))
        .leftJoin(apiTokens, eq(apiTokens.userId, users.id))
        .groupBy(users.id)
        .orderBy(sql`${users.createdAt} desc`);

      return rows.map((r) => ({
        ...r,
        portfolioCount: Number(r.portfolioCount),
        transactionCount: Number(r.transactionCount),
        documentCount: Number(r.documentCount),
        storageBytes: Number(r.storageBytes),
        tokenCount: Number(r.tokenCount),
      }));
    },
  );

  app.post(
    "/admin/users/:id/revoke-tokens",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      preHandler: app.requireAdmin,
    },
    async (request) => {
      const { id } = request.params as { id: string };

      const [{ count }] = await app.db
        .select({ count: sql<number>`count(*)` })
        .from(apiTokens)
        .where(eq(apiTokens.userId, id));

      await app.db.delete(apiTokens).where(eq(apiTokens.userId, id));

      await app.db.insert(adminAuditLog).values({
        actorSub: request.user!.authSub,
        action: "revoke_user_tokens",
        target: id,
        meta: { revokedCount: Number(count) },
      });

      return { revoked: Number(count) };
    },
  );

  app.post(
    "/admin/users/:id/reset-onboarding",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      preHandler: app.requireAdmin,
    },
    async (request) => {
      const { id } = request.params as { id: string };

      await app.db.update(users).set({ onboardingCompletedAt: null }).where(eq(users.id, id));

      await app.db.insert(adminAuditLog).values({
        actorSub: request.user!.authSub,
        action: "reset_user_onboarding",
        target: id,
        meta: {},
      });

      return { reset: true };
    },
  );

  app.post(
    "/admin/users/:id/delete",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      preHandler: app.requireAdmin,
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      if (id === request.user!.id) {
        return reply.code(400).send({ error: "cannot_delete_self" });
      }

      const docs = await app.db
        .select({ id: documents.id, storageKey: documents.storageKey })
        .from(documents)
        .where(eq(documents.userId, id));

      if (docs.length > 0) {
        await deleteStorageObjectsByKey(app, docs, `admin-delete-user-${id}`);
      }

      await app.db.delete(users).where(eq(users.id, id));

      await app.db.insert(adminAuditLog).values({
        actorSub: request.user!.authSub,
        action: "delete_user",
        target: id,
        meta: { docCount: docs.length },
      });

      return { deleted: true };
    },
  );
}
