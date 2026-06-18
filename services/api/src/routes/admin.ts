import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  providerSettings,
  providerCredentials,
  adminAuditLog,
} from "@portfolio/db";
import {
  providerSettingsUpdateSchema,
  providerCredentialSchema,
} from "@portfolio/schema";
import {
  PROVIDER_REGISTRY,
  resolveProviderConfig,
  resolveCredentials,
  invalidateMarketData,
  flushUsage,
  getProviderUsage,
} from "../services/market-data.js";
import {
  refreshAntamBuyback,
  refreshGaleri24Buyback,
  refreshNav,
} from "../services/scrapers/store.js";

/**
 * Admin-only server configuration (requires the Authentik admin group via
 * `app.requireAdmin`). Today: market-data provider chain (enable/disable, fallback
 * priority, API keys), an audit log, and the scraper trigger.
 *
 * No secrets are ever returned — responses show `hasKey`/`keyHint` only.
 * Writing keys requires `app.encryption.isEnabled` (refuses with 503 when off).
 */
export async function adminRoute(app: FastifyInstance) {
  // ─── Provider list helper ────────────────────────────────────────────────

  async function listProviders() {
    const [rows, credRows] = await Promise.all([
      app.db
        .select({
          provider: providerSettings.provider,
          enabled: providerSettings.enabled,
          priority: providerSettings.priority,
        })
        .from(providerSettings),
      app.db
        .select({
          provider: providerCredentials.provider,
          apiKeyEnc: providerCredentials.apiKeyEnc,
          urlOverride: providerCredentials.urlOverride,
        })
        .from(providerCredentials),
    ]);

    // Build the resolved-secrets map for accurate `configured` status
    const credMap = new Map<string, { apiKeyEnc: string | null; urlOverride: string | null }>(
      credRows.map((r) => [r.provider, r]),
    );
    const credentials = await resolveCredentials();

    // Persist any pending call tally, then attach per-provider usage.
    await flushUsage();
    const usage = await getProviderUsage();

    return resolveProviderConfig(rows, PROVIDER_REGISTRY, credentials).map((p) => {
      const cred = credMap.get(p.id);
      const hasKey = Boolean(cred?.apiKeyEnc);
      let keyHint: string | null = null;
      if (hasKey && cred?.apiKeyEnc) {
        try {
          const plain = app.encryption.decryptString(cred.apiKeyEnc);
          keyHint = plain.length >= 4 ? `••••${plain.slice(-4)}` : "••••";
        } catch {
          keyHint = "••••";
        }
      }
      const hasUrl = Boolean(cred?.urlOverride);
      return { ...p, hasKey, keyHint, hasUrl, usage: usage[p.id] ?? null };
    });
  }

  function providersResponse(providers: Awaited<ReturnType<typeof listProviders>>) {
    return { providers, encryptionEnabled: app.encryption.isEnabled };
  }

  // ─── Market-data provider enable/disable + priority ──────────────────────

  // The merged provider config (registry defaults overlaid with DB overrides), ordered,
  // with per-provider usage and credential status.
  app.get("/admin/providers", { preHandler: app.requireAdmin }, async () =>
    providersResponse(await listProviders()),
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
        return reply.code(400).send({ error: "unknown_provider", ids: unknown.map((u) => u.id) });
      }
      for (const u of updates) {
        await app.db
          .insert(providerSettings)
          .values({ provider: u.id, enabled: u.enabled, priority: u.priority })
          .onConflictDoUpdate({
            target: providerSettings.provider,
            set: { enabled: u.enabled, priority: u.priority, updatedAt: new Date() },
          });
      }
      await app.db.insert(adminAuditLog).values({
        actorSub: request.user!.authSub,
        action: "update_providers",
        target: updates.map((u) => u.id).join(","),
        meta: updates.reduce<Record<string, unknown>>(
          (acc, u) => ({ ...acc, [u.id]: { enabled: u.enabled, priority: u.priority } }),
          {},
        ),
      });
      // Drop the cached MarketDataService so the next request/job rebuilds the chain.
      invalidateMarketData();
      return providersResponse(await listProviders());
    },
  );

  // ─── Per-provider credential management ──────────────────────────────────

  // Set or rotate the API key / URL override for a provider. Requires encryption to be
  // enabled (DB_ENCRYPTION_KEY set) — writing plaintext secrets to the DB is unsafe.
  // Response: same shape as GET /admin/providers so the UI can refresh in one round trip.
  app.put(
    "/admin/providers/:id/credential",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      if (!app.encryption.isEnabled) {
        return reply.code(503).send({ error: "encryption_required" });
      }
      const { id } = request.params as { id: string };
      if (!PROVIDER_REGISTRY.some((d) => d.id === id)) {
        return reply.code(404).send({ error: "unknown_provider" });
      }
      const body = providerCredentialSchema.parse(request.body);
      const apiKeyEnc = body.apiKey ? app.encryption.encryptString(body.apiKey) : null;

      await app.db
        .insert(providerCredentials)
        .values({
          provider: id,
          ...(apiKeyEnc !== null ? { apiKeyEnc } : {}),
          ...(body.urlOverride !== undefined ? { urlOverride: body.urlOverride } : {}),
        })
        .onConflictDoUpdate({
          target: providerCredentials.provider,
          set: {
            ...(apiKeyEnc !== null ? { apiKeyEnc } : {}),
            ...(body.urlOverride !== undefined ? { urlOverride: body.urlOverride } : {}),
            updatedAt: new Date(),
          },
        });

      // Audit: record action but never the key value
      const keyHint =
        body.apiKey
          ? body.apiKey.length >= 4
            ? `••••${body.apiKey.slice(-4)}`
            : "••••"
          : undefined;
      await app.db.insert(adminAuditLog).values({
        actorSub: request.user!.authSub,
        action: "set_credential",
        target: id,
        meta: { keyHint: keyHint ?? null, hasUrl: Boolean(body.urlOverride) },
      });

      invalidateMarketData();
      return providersResponse(await listProviders());
    },
  );

  // Clear the DB credential for a provider; falls back to the env key/url.
  app.delete(
    "/admin/providers/:id/credential",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!PROVIDER_REGISTRY.some((d) => d.id === id)) {
        return reply.code(404).send({ error: "unknown_provider" });
      }
      await app.db
        .delete(providerCredentials)
        .where(eq(providerCredentials.provider, id));
      await app.db.insert(adminAuditLog).values({
        actorSub: request.user!.authSub,
        action: "clear_credential",
        target: id,
        meta: null,
      });
      invalidateMarketData();
      return providersResponse(await listProviders());
    },
  );

  // ─── Audit log ───────────────────────────────────────────────────────────

  // Recent admin actions (newest first, capped to 100 entries for the UI).
  app.get("/admin/audit", { preHandler: app.requireAdmin }, async () => {
    const rows = await app.db
      .select()
      .from(adminAuditLog)
      .orderBy(adminAuditLog.at)
      .limit(100);
    return rows.reverse();
  });

  // ─── Scraper trigger ─────────────────────────────────────────────────────

  // Run the built-in scrapers now and cache the results, instead of waiting for the
  // scheduler's cron. Handy right after a deploy to populate scraped_quotes immediately.
  // Each scraper handles its own failures, so a dead source just yields null / 0 here.
  app.post("/admin/market-data/scrape", { preHandler: app.requireAdmin }, async () => {
    const antamBuyback = await refreshAntamBuyback(app.db);
    const galeri24Buyback = await refreshGaleri24Buyback(app.db);
    const navFunds = await refreshNav(app.db);
    return { antamBuyback, galeri24Buyback, navFunds };
  });
}
