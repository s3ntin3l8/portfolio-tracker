import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { userPreferences } from "@portfolio/db";
import { userPreferencesSchema } from "@portfolio/schema";
export async function preferencesRoute(app: FastifyInstance) {
  app.get("/me/preferences", { preHandler: app.authenticate }, async (request) => {
    const id = request.userId;
    const [prefs] = await app.db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, id))
      .limit(1);
    request.timingName = "GET /me/preferences";
    request.timingMeta = {};
    return {
      dashboardPeriod: prefs?.dashboardPeriod ?? "max",
      dashboardKpis: prefs?.dashboardKpis ?? null,
      costBasisMode: prefs?.costBasisMode ?? "purchase_price",
      taxRegime: prefs?.taxRegime ?? "DE",
      benchmarkSymbol: prefs?.benchmarkSymbol ?? null,
      riskFreeRate: prefs?.riskFreeRate ? Number(prefs.riskFreeRate) : null,
      retirementAge: prefs?.retirementAge ?? null,
    };
  });

  app.put("/me/preferences", { preHandler: app.authenticate }, async (request) => {
    const id = request.userId;
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
        benchmarkSymbol: body.benchmarkSymbol ?? null,
        riskFreeRate: body.riskFreeRate != null ? String(body.riskFreeRate) : null,
        retirementAge: body.retirementAge ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: {
          ...(body.dashboardPeriod !== undefined ? { dashboardPeriod: body.dashboardPeriod } : {}),
          ...(body.dashboardKpis !== undefined ? { dashboardKpis: body.dashboardKpis } : {}),
          ...(body.costBasisMode !== undefined ? { costBasisMode: body.costBasisMode } : {}),
          ...(body.taxRegime !== undefined ? { taxRegime: body.taxRegime } : {}),
          ...(body.benchmarkSymbol !== undefined
            ? { benchmarkSymbol: body.benchmarkSymbol || null }
            : {}),
          ...(body.riskFreeRate !== undefined
            ? { riskFreeRate: body.riskFreeRate != null ? String(body.riskFreeRate) : null }
            : {}),
          ...(body.retirementAge !== undefined ? { retirementAge: body.retirementAge } : {}),
          updatedAt: now,
        },
      })
      .returning();
    return {
      dashboardPeriod: updated?.dashboardPeriod ?? "max",
      dashboardKpis: updated?.dashboardKpis ?? null,
      costBasisMode: updated?.costBasisMode ?? "purchase_price",
      taxRegime: updated?.taxRegime ?? "DE",
      benchmarkSymbol: updated?.benchmarkSymbol ?? null,
      riskFreeRate: updated?.riskFreeRate ? Number(updated.riskFreeRate) : null,
      retirementAge: updated?.retirementAge ?? null,
    };
  });
}
