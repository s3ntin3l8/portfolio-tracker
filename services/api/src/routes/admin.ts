import type { FastifyInstance } from "fastify";
import { providerSettings } from "@portfolio/db";
import { providerSettingsUpdateSchema } from "@portfolio/schema";
import {
  PROVIDER_REGISTRY,
  resolveProviderConfig,
  invalidateMarketData,
  flushUsage,
  getProviderUsage,
} from "../services/market-data.js";
import { refreshAntamBuyback, refreshNav } from "../services/scrapers/store.js";

/**
 * Admin-only server configuration. Today: the market-data provider chain (enable/disable
 * + fallback priority), overlaying the env-derived registry defaults via `provider_settings`
 * (see #102). API keys still come from env (see #106). Every handler is gated by
 * `app.requireAdmin` (Authentik admin group). No secrets are ever returned — `configured`
 * only reports whether a provider's env key/url is present.
 */
export async function adminRoute(app: FastifyInstance) {
  async function listProviders() {
    const rows = await app.db
      .select({
        provider: providerSettings.provider,
        enabled: providerSettings.enabled,
        priority: providerSettings.priority,
      })
      .from(providerSettings);
    // Persist any pending call tally, then attach per-provider usage (live quota where the
    // provider exposes one, else our local counter; memoised ~60s server-side).
    await flushUsage();
    const usage = await getProviderUsage();
    return resolveProviderConfig(rows).map((p) => ({
      ...p,
      usage: usage[p.id] ?? null,
    }));
  }

  // The merged provider config (registry defaults overlaid with DB overrides), ordered.
  app.get("/admin/providers", { preHandler: app.requireAdmin }, () =>
    listProviders(),
  );

  // Upsert enable/priority for one or more providers, then hot-reload the service.
  app.patch(
    "/admin/providers",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const updates = providerSettingsUpdateSchema.parse(request.body);
      const knownIds = new Set(PROVIDER_REGISTRY.map((d) => d.id));
      const unknown = updates.filter((u) => !knownIds.has(u.id));
      if (unknown.length > 0) {
        return reply
          .code(400)
          .send({ error: "unknown_provider", ids: unknown.map((u) => u.id) });
      }
      for (const u of updates) {
        await app.db
          .insert(providerSettings)
          .values({ provider: u.id, enabled: u.enabled, priority: u.priority })
          .onConflictDoUpdate({
            target: providerSettings.provider,
            set: {
              enabled: u.enabled,
              priority: u.priority,
              updatedAt: new Date(),
            },
          });
      }
      // Drop the cached MarketDataService so the next request/job rebuilds the chain.
      invalidateMarketData();
      return listProviders();
    },
  );

  // Run the built-in scrapers now and cache the results, instead of waiting for the
  // scheduler's cron. Handy right after a deploy to populate scraped_quotes immediately.
  // Each scraper handles its own failures, so a dead source just yields null / 0 here.
  app.post("/admin/market-data/scrape", { preHandler: app.requireAdmin }, async () => {
    const antamBuyback = await refreshAntamBuyback(app.db);
    const navFunds = await refreshNav(app.db);
    return { antamBuyback, navFunds };
  });
}
