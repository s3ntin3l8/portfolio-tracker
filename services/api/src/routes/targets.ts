import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { allocationTargets } from "@portfolio/db";
import { allocationTargetSetSchema } from "@portfolio/schema";
import { requireUser } from "../plugins/auth.js";
import { ownedPortfolio } from "./helpers.js";

/**
 * Allocation target routes.
 *
 * Targets are stored in `allocation_targets` with a nullable `portfolioId`:
 *   - null   = aggregate / networth-level targets
 *   - non-null = per-portfolio targets (Sparplan instrument split, etc.)
 *
 * All PUT operations are atomic replace-whole-set (delete existing then insert new),
 * scoped to (userId, portfolioId, dimension). The sum-to-100 validation is enforced
 * at the Zod layer via `allocationTargetSetSchema`.
 *
 * Routes registered:
 *   GET  /networth/targets?dimension=
 *   PUT  /networth/targets
 *   GET  /portfolios/:portfolioId/targets?dimension=
 *   PUT  /portfolios/:portfolioId/targets
 */
export async function targetsRoute(app: FastifyInstance) {

  /** Map DB rows to the API response shape. */
  function toTargetWeights(rows: (typeof allocationTargets.$inferSelect)[]) {
    return rows.map((r) => ({
      key: r.targetKey,
      targetPct: Number(r.targetPct),
    }));
  }

  // ---------------------------------------------------------------------------
  // Aggregate (networth-level) targets — portfolioId = null
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: { dimension?: string } }>(
    "/networth/targets",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const dimension = request.query.dimension;
      if (!dimension) {
        return reply.code(400).send({ error: "dimension_required" });
      }
      const rows = await app.db
        .select()
        .from(allocationTargets)
        .where(
          and(
            eq(allocationTargets.userId, id),
            isNull(allocationTargets.portfolioId),
            eq(allocationTargets.dimension, dimension),
          ),
        );
      return toTargetWeights(rows);
    },
  );

  app.put("/networth/targets", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = requireUser(request);
    const parsed = allocationTargetSetSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", issues: parsed.error.issues });
    }
    const { dimension, targets } = parsed.data;

    await app.db.transaction(async (tx) => {
      // Delete existing targets for this (user, null-portfolio, dimension).
      await tx
        .delete(allocationTargets)
        .where(
          and(
            eq(allocationTargets.userId, id),
            isNull(allocationTargets.portfolioId),
            eq(allocationTargets.dimension, dimension),
          ),
        );
      if (targets.length > 0) {
        await tx.insert(allocationTargets).values(
          targets.map((t) => ({
            userId: id,
            portfolioId: null,
            dimension,
            targetKey: t.key,
            targetPct: String(t.targetPct),
          })),
        );
      }
    });

    // Return the newly saved set.
    const rows = await app.db
      .select()
      .from(allocationTargets)
      .where(
        and(
          eq(allocationTargets.userId, id),
          isNull(allocationTargets.portfolioId),
          eq(allocationTargets.dimension, dimension),
        ),
      );
    return toTargetWeights(rows);
  });

  // ---------------------------------------------------------------------------
  // Per-portfolio targets
  // ---------------------------------------------------------------------------

  app.get<{ Params: { portfolioId: string }; Querystring: { dimension?: string } }>(
    "/portfolios/:portfolioId/targets",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      const dimension = request.query.dimension;
      if (!dimension) {
        return reply.code(400).send({ error: "dimension_required" });
      }
      if (!(await ownedPortfolio(app, id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const rows = await app.db
        .select()
        .from(allocationTargets)
        .where(
          and(
            eq(allocationTargets.userId, id),
            eq(allocationTargets.portfolioId, portfolioId),
            eq(allocationTargets.dimension, dimension),
          ),
        );
      return toTargetWeights(rows);
    },
  );

  app.put<{ Params: { portfolioId: string } }>(
    "/portfolios/:portfolioId/targets",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = requireUser(request);
      const { portfolioId } = request.params;
      if (!(await ownedPortfolio(app, id, portfolioId))) {
        return reply.code(404).send({ error: "portfolio_not_found" });
      }
      const parsed = allocationTargetSetSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_input", issues: parsed.error.issues });
      }
      const { dimension, targets } = parsed.data;

      await app.db.transaction(async (tx) => {
        await tx
          .delete(allocationTargets)
          .where(
            and(
              eq(allocationTargets.userId, id),
              eq(allocationTargets.portfolioId, portfolioId),
              eq(allocationTargets.dimension, dimension),
            ),
          );
        if (targets.length > 0) {
          await tx.insert(allocationTargets).values(
            targets.map((t) => ({
              userId: id,
              portfolioId,
              dimension,
              targetKey: t.key,
              targetPct: String(t.targetPct),
            })),
          );
        }
      });

      const rows = await app.db
        .select()
        .from(allocationTargets)
        .where(
          and(
            eq(allocationTargets.userId, id),
            eq(allocationTargets.portfolioId, portfolioId),
            eq(allocationTargets.dimension, dimension),
          ),
        );
      return toTargetWeights(rows);
    },
  );
}
