import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import {
  providerSettings,
  visionProviderSettings,
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
  VISION_PROVIDER_REGISTRY,
  resolveVisionProviderConfig,
  resolveVisionCredentials,
  invalidateScreenshotParser,
} from "../services/screenshot-parser.js";
import {
  refreshAntamBuyback,
  refreshGaleri24Buyback,
  refreshNav,
} from "../services/scrapers/store.js";
import {
  JOB_DESCRIPTORS,
  getActiveBoss,
  triggerJob,
} from "../services/scheduler.js";

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
      const desc = PROVIDER_REGISTRY.find((d) => d.id === p.id);
      const keySource: "db" | "env" | null =
        hasKey || hasUrl
          ? "db"
          : desc?.keyEnvVar && process.env[desc.keyEnvVar]
          ? "env"
          : null;
      return { ...p, hasKey, keyHint, hasUrl, keySource, usage: usage[p.id] ?? null };
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

  // ─── Vision LLM provider config ──────────────────────────────────────────

  /**
   * Query the vision provider registry, overlaid with DB settings and credentials.
   * Credentials use the "vision:" namespace in `provider_credentials`
   * (e.g. "vision:gemini"). No secrets are returned — only hasKey/keyHint/hasUrl.
   */
  async function listVisionProviders() {
    const [rows, credRows] = await Promise.all([
      app.db
        .select({
          provider: visionProviderSettings.provider,
          enabled: visionProviderSettings.enabled,
          priority: visionProviderSettings.priority,
        })
        .from(visionProviderSettings),
      app.db
        .select({
          provider: providerCredentials.provider,
          apiKeyEnc: providerCredentials.apiKeyEnc,
          urlOverride: providerCredentials.urlOverride,
        })
        .from(providerCredentials)
        .then((rs) => rs.filter((r) => r.provider.startsWith("vision:"))),
    ]);

    const credMap = new Map(
      credRows.map((r) => [r.provider.slice("vision:".length), r]),
    );
    const credentials = await resolveVisionCredentials();

    return resolveVisionProviderConfig(rows, credentials).map((p) => {
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
      const vDesc = VISION_PROVIDER_REGISTRY.find((d) => d.id === p.id);
      const keySource: "db" | "env" | null =
        hasKey || hasUrl
          ? "db"
          : vDesc?.keyEnvVar && process.env[vDesc.keyEnvVar]
          ? "env"
          : null;
      return { ...p, hasKey, keyHint, hasUrl, keySource };
    });
  }

  function visionProvidersResponse(
    providers: Awaited<ReturnType<typeof listVisionProviders>>,
  ) {
    return { providers, encryptionEnabled: app.encryption.isEnabled };
  }

  // The merged vision-provider config (registry defaults overlaid with DB overrides).
  app.get("/admin/vision-providers", { preHandler: app.requireAdmin }, async () =>
    visionProvidersResponse(await listVisionProviders()),
  );

  // Upsert enable/priority for one or more vision providers, then hot-reload the parser.
  app.patch(
    "/admin/vision-providers",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const updates = providerSettingsUpdateSchema.parse(request.body);
      const knownIds = new Set(VISION_PROVIDER_REGISTRY.map((d) => d.id));
      const unknown = updates.filter((u) => !knownIds.has(u.id));
      if (unknown.length > 0) {
        return reply
          .code(400)
          .send({ error: "unknown_provider", ids: unknown.map((u) => u.id) });
      }
      for (const u of updates) {
        await app.db
          .insert(visionProviderSettings)
          .values({ provider: u.id, enabled: u.enabled, priority: u.priority })
          .onConflictDoUpdate({
            target: visionProviderSettings.provider,
            set: { enabled: u.enabled, priority: u.priority, updatedAt: new Date() },
          });
      }
      await app.db.insert(adminAuditLog).values({
        actorSub: request.user!.authSub,
        action: "update_vision_providers",
        target: updates.map((u) => u.id).join(","),
        meta: updates.reduce<Record<string, unknown>>(
          (acc, u) => ({ ...acc, [u.id]: { enabled: u.enabled, priority: u.priority } }),
          {},
        ),
      });
      invalidateScreenshotParser();
      return visionProvidersResponse(await listVisionProviders());
    },
  );

  // Set or rotate an API key / URL for a vision provider (namespaced as "vision:<id>").
  app.put(
    "/admin/vision-providers/:id/credential",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      if (!app.encryption.isEnabled) {
        return reply.code(503).send({ error: "encryption_required" });
      }
      const { id } = request.params as { id: string };
      if (!VISION_PROVIDER_REGISTRY.some((d) => d.id === id)) {
        return reply.code(404).send({ error: "unknown_provider" });
      }
      const body = providerCredentialSchema.parse(request.body);
      const namespacedId = `vision:${id}`;
      const apiKeyEnc = body.apiKey ? app.encryption.encryptString(body.apiKey) : null;

      await app.db
        .insert(providerCredentials)
        .values({
          provider: namespacedId,
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

      const keyHint = body.apiKey
        ? body.apiKey.length >= 4
          ? `••••${body.apiKey.slice(-4)}`
          : "••••"
        : undefined;
      await app.db.insert(adminAuditLog).values({
        actorSub: request.user!.authSub,
        action: "set_credential",
        target: namespacedId,
        meta: { keyHint: keyHint ?? null, hasUrl: Boolean(body.urlOverride) },
      });

      invalidateScreenshotParser();
      return visionProvidersResponse(await listVisionProviders());
    },
  );

  // Clear the DB credential for a vision provider; falls back to the env key.
  app.delete(
    "/admin/vision-providers/:id/credential",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!VISION_PROVIDER_REGISTRY.some((d) => d.id === id)) {
        return reply.code(404).send({ error: "unknown_provider" });
      }
      const namespacedId = `vision:${id}`;
      await app.db
        .delete(providerCredentials)
        .where(eq(providerCredentials.provider, namespacedId));
      await app.db.insert(adminAuditLog).values({
        actorSub: request.user!.authSub,
        action: "clear_credential",
        target: namespacedId,
        meta: null,
      });
      invalidateScreenshotParser();
      return visionProvidersResponse(await listVisionProviders());
    },
  );

  // ─── DB statistics (#140) ────────────────────────────────────────────────

  /**
   * Database size, per-table row counts (estimated) and sizes, plus an honest "not
   * used" entry for object storage (screenshots are parsed in-memory and discarded).
   *
   * PGlite guard: `pg_database_size` / `pg_total_relation_size` / `pg_stat_user_tables`
   * are Postgres catalog functions not available under PGlite (used in tests).
   * Returns nulls when `NODE_ENV === "test"` so the route stays testable.
   */
  app.get("/admin/stats", { preHandler: app.requireAdmin }, async () => {
    // The key user-data tables whose size we surface in the UI. Admin/config tables
    // (provider_settings, audit_log, etc.) are omitted — they stay small by design.
    const TABLES = [
      "users",
      "portfolios",
      "instruments",
      "transactions",
      "screenshot_imports",
      "prices",
      "last_prices",
      "fx_rates",
      "portfolio_snapshots",
      "dividend_events",
      "corporate_actions",
      "loans",
      "tr_connections",
      "tr_resolved_events",
    ] as const;

    let dbSizeBytes: number | null = null;
    let tableStats: { name: string; rows: number | null; sizeBytes: number | null }[] = [];

    if (process.env.NODE_ENV !== "test") {
      try {
        // DB total size
        const [{ size }] = await app.db.execute<{ size: string }>(
          sql`SELECT pg_database_size(current_database()) AS size`,
        );
        dbSizeBytes = Number(size);

        // Per-table: estimated live rows + total size (table + indexes + toast).
        // pg_stat_user_tables.n_live_tup is refreshed by autovacuum — exact after
        // VACUUM ANALYZE, otherwise a fast estimate. ANALYZE is scheduled nightly.
        const rows = await app.db.execute<{
          tablename: string;
          n_live_tup: string;
          total_bytes: string;
        }>(
          sql`SELECT
                t.tablename,
                COALESCE(s.n_live_tup, 0) AS n_live_tup,
                pg_total_relation_size(quote_ident(t.tablename)::regclass) AS total_bytes
              FROM pg_tables t
              LEFT JOIN pg_stat_user_tables s USING (tablename)
              WHERE t.schemaname = 'public'
                AND t.tablename = ANY(${TABLES})
              ORDER BY total_bytes DESC`,
        );

        tableStats = TABLES.map((name) => {
          const row = rows.find((r) => r.tablename === name);
          return {
            name,
            rows: row ? Number(row.n_live_tup) : 0,
            sizeBytes: row ? Number(row.total_bytes) : 0,
          };
        });
      } catch {
        // Catalog query failed (e.g. insufficient permissions or very early boot).
        // Return nulls rather than 500 — the UI will display "unavailable".
      }
    }

    return {
      db: {
        sizeBytes: dbSizeBytes,
        tables: tableStats,
      },
      objectStorage: {
        configured: false,
        note: "Screenshots are parsed in-memory and discarded; no blob storage is used.",
      },
    };
  });

  // ─── Background jobs panel (#105 + Slice 5) ──────────────────────────────

  /**
   * List all known background job queues with their schedule and last-run status.
   *
   * When pg-boss is unavailable (PGlite / test env / pre-boot) the live fields
   * are null and `schedulerAvailable: false` is set — the UI shows a note instead
   * of error.
   *
   * #105 multi-replica note: last-run data is read from the shared Postgres `pgboss`
   * schema, so it reflects all replicas. However, in-process cache invalidation
   * (invalidateMarketData / invalidateScreenshotParser) only fires on the replica
   * that handles the trigger request. LISTEN/NOTIFY fan-out is the fix; deferred
   * until the deployment scales past one replica.
   */
  app.get("/admin/jobs", { preHandler: app.requireAdmin }, async () => {
    const boss = getActiveBoss();
    const schedulerAvailable = boss !== null;

    type JobRow = {
      name: string;
      lastRunAt: string | null;
      lastStatus: "completed" | "failed" | null;
    };

    let liveRows: JobRow[] = [];
    if (schedulerAvailable) {
      try {
        const queueNames: string[] = JOB_DESCRIPTORS.map((j) => j.name);
        const rows = await app.db.execute<{
          name: string;
          last_completed: string | null;
          last_failed: string | null;
        }>(sql`
          SELECT
            name,
            MAX(completedon) FILTER (WHERE state = 'completed') AS last_completed,
            MAX(completedon) FILTER (WHERE state = 'failed')    AS last_failed
          FROM pgboss.job
          WHERE name = ANY(${queueNames})
            AND completedon > NOW() - INTERVAL '30 days'
          GROUP BY name
        `);
        liveRows = rows.map((r) => {
          const c = r.last_completed ? new Date(r.last_completed).toISOString() : null;
          const f = r.last_failed ? new Date(r.last_failed).toISOString() : null;
          // Whichever is more recent determines the display status.
          if (!c && !f) return { name: r.name, lastRunAt: null, lastStatus: null };
          const lastRunAt = c && f ? (c > f ? c : f) : (c ?? f);
          const lastStatus: "completed" | "failed" = c && (!f || c >= f) ? "completed" : "failed";
          return { name: r.name, lastRunAt, lastStatus };
        });
      } catch {
        // pgboss schema may not exist yet (first boot before scheduler started).
        // Fall through with empty liveRows.
      }
    }

    const liveMap = new Map(liveRows.map((r) => [r.name, r]));

    const jobs = JOB_DESCRIPTORS.map((d) => ({
      name: d.name,
      label: d.label,
      description: d.description,
      cron: d.cron,
      lastRunAt: liveMap.get(d.name)?.lastRunAt ?? null,
      lastStatus: liveMap.get(d.name)?.lastStatus ?? null,
    }));

    return { schedulerAvailable, jobs };
  });

  // Manually enqueue a job immediately (admin "run now" button).
  app.post(
    "/admin/jobs/:name/trigger",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const { name } = request.params as { name: string };
      const knownNames = new Set<string>(JOB_DESCRIPTORS.map((j) => j.name));
      if (!knownNames.has(name)) {
        return reply.code(404).send({ error: "unknown_job" });
      }

      const result = await triggerJob(name);
      if (!result.queued) {
        return reply.code(503).send({ error: "scheduler_unavailable" });
      }

      await app.db.insert(adminAuditLog).values({
        actorSub: request.user!.authSub,
        action: "trigger_job",
        target: name,
        meta: null,
      });

      return { queued: true, name };
    },
  );
}
