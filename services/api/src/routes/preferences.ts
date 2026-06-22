import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { userPreferences } from "@portfolio/db";
import { userPreferencesSchema } from "@portfolio/schema";
import { requireUser } from "../plugins/auth.js";

export async function preferencesRoute(app: FastifyInstance) {
  app.get(
    "/me/preferences",
    { preHandler: app.authenticate },
    async (request) => {
      const { id } = requireUser(request);
      const [prefs] = await app.db
        .select()
        .from(userPreferences)
        .where(eq(userPreferences.userId, id))
        .limit(1);
      return {
        dashboardPeriod: prefs?.dashboardPeriod ?? "max",
        dashboardKpis: prefs?.dashboardKpis ?? null,
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
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: userPreferences.userId,
          set: {
            ...(body.dashboardPeriod !== undefined
              ? { dashboardPeriod: body.dashboardPeriod }
              : {}),
            ...(body.dashboardKpis !== undefined
              ? { dashboardKpis: body.dashboardKpis }
              : {}),
            updatedAt: now,
          },
        })
        .returning();
      return {
        dashboardPeriod: updated?.dashboardPeriod ?? "max",
        dashboardKpis: updated?.dashboardKpis ?? null,
      };
    },
  );
}
