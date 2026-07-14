import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { userPreferences } from "@portfolio/db";
import { userPreferencesSchema } from "@portfolio/schema";
import { requireUser } from "../plugins/auth.js";
import { logTiming } from "../lib/timing.js";

export async function preferencesRoute(app: FastifyInstance) {
  app.get(
    "/me/preferences",
    { preHandler: app.authenticate },
    async (request) => {
      const t0 = performance.now();
      const { id } = requireUser(request);
      const [prefs] = await app.db
        .select()
        .from(userPreferences)
        .where(eq(userPreferences.userId, id))
        .limit(1);
      const durationMs = performance.now() - t0;
      logTiming(request, "GET /me/preferences", durationMs, {});
      return {
        dashboardPeriod: prefs?.dashboardPeriod ?? "max",
        dashboardKpis: prefs?.dashboardKpis ?? null,
        // Defaults here mirror the column defaults so a user with NO row at all (the
        // common case pre-this-change) sees byte-for-byte the same German tax +
        // purchase_price P&L as before — nothing shifts until they pick a chip.
        costBasisMode: prefs?.costBasisMode ?? "purchase_price",
        taxRegime: prefs?.taxRegime ?? "DE",
      };
    },
  );

  app.put(
    "/me/preferences",
    { preHandler: app.authenticate },
    async (request) => {
      const { id } = requireUser(request);
      const body = userPreferencesSchema.parse(request.body);
      const now = new Date();
      const [updated] = await app.db
        .insert(userPreferences)
        .values({
          userId: id,
          dashboardPeriod: body.dashboardPeriod ?? "max",
          dashboardKpis: body.dashboardKpis ?? null,
          costBasisMode: body.costBasisMode ?? "purchase_price",
          taxRegime: body.taxRegime ?? "DE",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: userPreferences.userId,
          set: {
            // Only overwrite fields actually sent in this PUT — lets the Settings
            // "Tax code" chip and the Tax-page regime toggle each write just their
            // own field without clobbering the other (same pattern for cost basis).
            ...(body.dashboardPeriod !== undefined
              ? { dashboardPeriod: body.dashboardPeriod }
              : {}),
            ...(body.dashboardKpis !== undefined
              ? { dashboardKpis: body.dashboardKpis }
              : {}),
            ...(body.costBasisMode !== undefined
              ? { costBasisMode: body.costBasisMode }
              : {}),
            ...(body.taxRegime !== undefined ? { taxRegime: body.taxRegime } : {}),
            updatedAt: now,
          },
        })
        .returning();
      return {
        dashboardPeriod: updated?.dashboardPeriod ?? "max",
        dashboardKpis: updated?.dashboardKpis ?? null,
        costBasisMode: updated?.costBasisMode ?? "purchase_price",
        taxRegime: updated?.taxRegime ?? "DE",
      };
    },
  );
}
