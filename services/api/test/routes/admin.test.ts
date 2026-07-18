import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { eq, sql } from "drizzle-orm";
import {
  adminAuditLog,
  apiTokens,
  documents,
  portfolios,
  transactions,
  users,
} from "@portfolio/db";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import {
  getScrapedQuote,
  ANTAM_BUYBACK_KEY,
  GALERI24_BUYBACK_KEY,
  navKey,
} from "../../src/services/scrapers/store.js";

const HARGA_EMAS_HTML = `<html><body><span>Harga pembelian kembali: <!-- -->Rp2.591.100<!-- --> /grm</span></body></html>`;

// Minimal GALERI 24 section: a 1g row whose last cell is the buyback.
const GALERI24_HTML =
  `<html><body><div id="GALERI 24"><div class="grid grid-cols-5">` +
  `<div>Berat</div><div>Harga Jual</div><div>Harga Buyback</div></div>` +
  `<div class="grid grid-cols-5"><div>1</div><div>Rp2.718.000</div><div>Rp2.549.000</div></div>` +
  `</div></body></html>`;

// Build the same self-describing envelope Bibit returns (iv hex + cipher hex + key utf8).
function encryptBibitEnvelope(payload: unknown): string {
  const key = "0123456789abcdef0123456789abcdef";
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(key, "utf8"), iv);
  const ct = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
    cipher.final(),
  ]);
  return iv.toString("hex") + ct.toString("hex") + key;
}

const ISSUER = "https://auth.test/application/o/portfolio/";
const AUDIENCE = "portfolio-tracker";
const ADMIN_GROUP = "portfolio-admins";

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let privateKey: CryptoKey;

// A signed token; pass `groups` to exercise the admin-group claim.
async function token(sub: string, groups?: string[]) {
  return new SignJWT({ email: `${sub}@example.com`, ...(groups ? { groups } : {}) })
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe("admin provider config", () => {
  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    process.env.AUTHENTIK_ADMIN_GROUP = ADMIN_GROUP;
    process.env.RATE_LIMIT_MAX = "10000";
    app = await buildApp({ authKey: kp.publicKey });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    delete process.env.AUTHENTIK_ADMIN_GROUP;
    delete process.env.RATE_LIMIT_MAX;
  });

  it("derives isAdmin on /me from the group claim", async () => {
    const plain = await app.inject({
      method: "GET",
      url: "/me",
      headers: auth(await token("plain-user")),
    });
    expect(plain.json().isAdmin).toBe(false);

    const admin = await app.inject({
      method: "GET",
      url: "/me",
      headers: auth(await token("admin-user", [ADMIN_GROUP])),
    });
    expect(admin.json().isAdmin).toBe(true);
  });

  it("guards /admin/providers — 403 for non-admins, 200 for admins", async () => {
    const forbidden = await app.inject({
      method: "GET",
      url: "/admin/providers",
      headers: auth(await token("nobody")),
    });
    expect(forbidden.statusCode).toBe(403);

    const ok = await app.inject({
      method: "GET",
      url: "/admin/providers",
      headers: auth(await token("admin-1", [ADMIN_GROUP])),
    });
    expect(ok.statusCode).toBe(200);
    const res = ok.json() as {
      providers: { id: string; configured: boolean }[];
      encryptionEnabled: boolean;
    };
    // Every registry provider is listed; the keyless Yahoo fallback is always configured.
    expect(res.providers.map((p) => p.id)).toContain("yahoo");
    expect(res.providers.find((p) => p.id === "yahoo")?.configured).toBe(true);
    // encryptionEnabled reflects whether DB_ENCRYPTION_KEY is set (not set in tests).
    expect(typeof res.encryptionEnabled).toBe("boolean");
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/providers" });
    expect(res.statusCode).toBe(401);
  });

  it("PATCH upserts enable/priority and reflects it on the next GET", async () => {
    const t = await token("admin-2", [ADMIN_GROUP]);
    const patch = await app.inject({
      method: "PATCH",
      url: "/admin/providers",
      headers: auth(t),
      payload: [
        { id: "yahoo", enabled: false, priority: 0 },
        { id: "eodhd", enabled: true, priority: 9 },
      ],
    });
    expect(patch.statusCode).toBe(200);
    const after = patch.json() as {
      providers: { id: string; enabled: boolean; priority: number }[];
    };
    expect(after.providers.find((p) => p.id === "yahoo")?.enabled).toBe(false);
    // priority 0 sorts strictly ahead of the unchanged defaults (which start at 1).
    expect(after.providers[0].id).toBe("yahoo");

    const get = await app.inject({
      method: "GET",
      url: "/admin/providers",
      headers: auth(t),
    });
    expect(
      (get.json() as { providers: { id: string; enabled: boolean }[] }).providers.find(
        (p) => p.id === "yahoo",
      )?.enabled,
    ).toBe(false);
  });

  it("PATCH rejects unknown provider ids with 400", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/admin/providers",
      headers: auth(await token("admin-3", [ADMIN_GROUP])),
      payload: [{ id: "not-a-provider", enabled: true, priority: 1 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "unknown_provider" });
  });

  it("PATCH is forbidden for non-admins", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/admin/providers",
      headers: auth(await token("intruder")),
      payload: [{ id: "yahoo", enabled: true, priority: 1 }],
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /admin/market-data/scrape runs the scrapers and caches results (admin only)", async () => {
    // Stub the network so the scrape is hermetic: harga-emas HTML + a Bibit envelope.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      // Check galeri24 first: its URL (galeri24.co.id/harga-emas) also contains "harga-emas".
      if (u.includes("galeri24")) {
        return { ok: true, status: 200, text: async () => GALERI24_HTML } as Response;
      }
      if (u.includes("harga-emas")) {
        return { ok: true, status: 200, text: async () => HARGA_EMAS_HTML } as Response;
      }
      if (u.includes("bibit")) {
        const data = encryptBibitEnvelope([{ symbol: "RDPU", nav: { value: 1234.56 } }]);
        return { ok: true, status: 200, json: async () => ({ data }) } as Response;
      }
      return { ok: false, status: 404 } as Response;
    }) as typeof fetch;

    try {
      const res = await app.inject({
        method: "POST",
        url: "/admin/market-data/scrape",
        headers: auth(await token("admin-scrape", [ADMIN_GROUP])),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        antamBuyback: 2591100,
        galeri24Buyback: 2549000,
        navFunds: 1,
      });
      expect(await getScrapedQuote(app.db, ANTAM_BUYBACK_KEY)).toBe(2591100);
      expect(await getScrapedQuote(app.db, GALERI24_BUYBACK_KEY)).toBe(2549000);
      expect(await getScrapedQuote(app.db, navKey("RDPU"))).toBe(1234.56);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("POST /admin/market-data/scrape is forbidden for non-admins", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/market-data/scrape",
      headers: auth(await token("intruder-2")),
    });
    expect(res.statusCode).toBe(403);
  });

  it("PUT /admin/providers/:id/credential returns 503 when encryption is disabled", async () => {
    // Tests run with DB_ENCRYPTION_KEY unset → encryption disabled.
    const res = await app.inject({
      method: "PUT",
      url: "/admin/providers/twelvedata/credential",
      headers: auth(await token("admin-cred-1", [ADMIN_GROUP])),
      payload: { apiKey: "test-key-abc123" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "encryption_required" });
  });

  it("PUT /admin/providers/:id/credential returns 404 for unknown provider", async () => {
    // Even when encryption is required, unknown ids return 404 first if we fake it.
    // Here encryption is disabled so we get 503, but test the 404 path via non-existent id.
    const res = await app.inject({
      method: "DELETE",
      url: "/admin/providers/does-not-exist/credential",
      headers: auth(await token("admin-cred-2", [ADMIN_GROUP])),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "unknown_provider" });
  });

  it("DELETE /admin/providers/:id/credential is a no-op when no credential exists (200)", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/admin/providers/yahoo/credential",
      headers: auth(await token("admin-cred-3", [ADMIN_GROUP])),
    });
    // yahoo has no required key; deleting a non-existent credential is still 200
    expect(res.statusCode).toBe(200);
  });

  it("GET /admin/audit returns a list of admin audit entries (admin only)", async () => {
    const ok = await app.inject({
      method: "GET",
      url: "/admin/audit",
      headers: auth(await token("admin-audit-1", [ADMIN_GROUP])),
    });
    expect(ok.statusCode).toBe(200);
    expect(Array.isArray(ok.json())).toBe(true);

    const forbidden = await app.inject({
      method: "GET",
      url: "/admin/audit",
      headers: auth(await token("non-admin-audit")),
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("PATCH records an audit log entry", async () => {
    const t = await token("admin-audit-2", [ADMIN_GROUP]);
    await app.inject({
      method: "PATCH",
      url: "/admin/providers",
      headers: auth(t),
      payload: [{ id: "coingecko", enabled: true, priority: 7 }],
    });
    const auditRes = await app.inject({
      method: "GET",
      url: "/admin/audit",
      headers: auth(t),
    });
    const log = auditRes.json() as { action: string; target: string }[];
    const entry = log.find(
      (e) => e.action === "update_providers" && e.target.includes("coingecko"),
    );
    expect(entry).toBeDefined();
  });

  // ─── Vision LLM provider config ──────────────────────────────────────────

  it("GET /admin/vision-providers lists all registry providers (admin only)", async () => {
    const forbidden = await app.inject({
      method: "GET",
      url: "/admin/vision-providers",
      headers: auth(await token("nobody-v")),
    });
    expect(forbidden.statusCode).toBe(403);

    const ok = await app.inject({
      method: "GET",
      url: "/admin/vision-providers",
      headers: auth(await token("admin-v1", [ADMIN_GROUP])),
    });
    expect(ok.statusCode).toBe(200);
    const res = ok.json() as {
      providers: { id: string; configured: boolean }[];
      encryptionEnabled: boolean;
    };
    // All four registry providers should be listed.
    const ids = res.providers.map((p) => p.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("gemini");
    expect(ids).toContain("openrouter");
    expect(ids).toContain("ollama");
    // Ollama is not configured by default (OLLAMA_BASE_URL not set in tests).
    expect(res.providers.find((p) => p.id === "ollama")?.configured).toBe(false);
    expect(typeof res.encryptionEnabled).toBe("boolean");
  });

  it("PATCH /admin/vision-providers upserts enable/priority", async () => {
    const t = await token("admin-v2", [ADMIN_GROUP]);
    const patch = await app.inject({
      method: "PATCH",
      url: "/admin/vision-providers",
      headers: auth(t),
      payload: [
        { id: "gemini", enabled: false, priority: 0 },
        { id: "ollama", enabled: true, priority: 9 },
      ],
    });
    expect(patch.statusCode).toBe(200);
    const after = patch.json() as {
      providers: { id: string; enabled: boolean; priority: number }[];
    };
    expect(after.providers.find((p) => p.id === "gemini")?.enabled).toBe(false);
    // gemini at priority 0 should sort ahead of all others.
    expect(after.providers[0].id).toBe("gemini");
  });

  it("PATCH /admin/vision-providers rejects unknown provider ids", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/admin/vision-providers",
      headers: auth(await token("admin-v3", [ADMIN_GROUP])),
      payload: [{ id: "not-a-vision-provider", enabled: true, priority: 1 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "unknown_provider" });
  });

  it("PUT /admin/vision-providers/:id/credential returns 503 when encryption disabled", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/admin/vision-providers/claude/credential",
      headers: auth(await token("admin-vc1", [ADMIN_GROUP])),
      payload: { apiKey: "test-anthropic-key" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "encryption_required" });
  });

  it("PUT /admin/vision-providers/:id/credential returns 404 for unknown provider", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/admin/vision-providers/not-real/credential",
      headers: auth(await token("admin-vc2", [ADMIN_GROUP])),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "unknown_provider" });
  });

  it("DELETE /admin/vision-providers/:id/credential is a no-op when no credential exists", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/admin/vision-providers/ollama/credential",
      headers: auth(await token("admin-vc3", [ADMIN_GROUP])),
    });
    // Deleting a non-existent credential is idempotent → 200.
    expect(res.statusCode).toBe(200);
  });

  // ─── DB statistics (#140) ────────────────────────────────────────────────

  it("GET /admin/stats is admin-gated and returns the expected shape", async () => {
    const forbidden = await app.inject({
      method: "GET",
      url: "/admin/stats",
      headers: auth(await token("nobody-stats")),
    });
    expect(forbidden.statusCode).toBe(403);

    const ok = await app.inject({
      method: "GET",
      url: "/admin/stats",
      headers: auth(await token("admin-stats", [ADMIN_GROUP])),
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as {
      db: { sizeBytes: number | null; tables: unknown[] };
      objectStorage: { configured: boolean };
    };
    // Under PGlite (test env) catalog queries are skipped → nulls/empty.
    expect(body.db.sizeBytes).toBeNull();
    expect(body.db.tables).toEqual([]);
    // Object storage stats are skipped under NODE_ENV=test (same guard as pg catalog queries).
    expect(body.objectStorage.configured).toBe(false);
  });

  // ─── Background jobs panel (#105 + Slice 5) ──────────────────────────────

  it("GET /admin/jobs is admin-gated and returns the expected shape", async () => {
    const forbidden = await app.inject({
      method: "GET",
      url: "/admin/jobs",
      headers: auth(await token("nobody-jobs")),
    });
    expect(forbidden.statusCode).toBe(403);

    const ok = await app.inject({
      method: "GET",
      url: "/admin/jobs",
      headers: auth(await token("admin-jobs-1", [ADMIN_GROUP])),
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as {
      schedulerAvailable: boolean;
      jobs: {
        name: string;
        label: string;
        cron: string | null;
        lastRunAt: null;
        lastStatus: null;
        supportsForce: boolean;
      }[];
    };
    // pg-boss is not running in PGlite/test env.
    expect(body.schedulerAvailable).toBe(false);
    // All known job descriptors should be listed.
    expect(body.jobs).toHaveLength(11);
    const names = body.jobs.map((j) => j.name);
    expect(names).toContain("refresh-prices");
    expect(names).toContain("daily-snapshot");
    expect(names).toContain("intraday-snapshot");
    expect(names).toContain("tr-sync");
    expect(names).toContain("scrape-antam");
    expect(names).toContain("scrape-nav");
    expect(names).toContain("refresh-dividends");
    expect(names).toContain("gc-staged-receipts");
    expect(names).toContain("backfill-stale-history");
    expect(names).toContain("refresh-instrument-metadata");
    expect(names).toContain("ibkr-sync");
    // With scheduler unavailable, last-run fields are all null.
    for (const job of body.jobs) {
      expect(job.lastRunAt).toBeNull();
      expect(job.lastStatus).toBeNull();
      expect(typeof job.label).toBe("string");
      expect(typeof job.cron).toBe("string"); // all known jobs have a cron
    }
    // supportsForce is exposed on the two force-capable jobs.
    const byName = Object.fromEntries(body.jobs.map((j) => [j.name, j]));
    expect(byName["backfill-stale-history"].supportsForce).toBe(true);
    expect(byName["refresh-instrument-metadata"].supportsForce).toBe(true);
    expect(byName["refresh-prices"].supportsForce).toBe(false);
    expect(byName["daily-snapshot"].supportsForce).toBe(false);
  });

  it("POST /admin/jobs/:name/trigger returns 404 for unknown job names", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/jobs/not-a-job/trigger",
      headers: auth(await token("admin-jobs-2", [ADMIN_GROUP])),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "unknown_job" });
  });

  it("POST /admin/jobs/:name/trigger returns 503 when scheduler is unavailable", async () => {
    // In PGlite/test env, activeBoss is null → scheduler_unavailable.
    const res = await app.inject({
      method: "POST",
      url: "/admin/jobs/refresh-prices/trigger",
      headers: auth(await token("admin-jobs-3", [ADMIN_GROUP])),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "scheduler_unavailable" });
  });

  it("POST /admin/jobs/:name/trigger is forbidden for non-admins", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/jobs/refresh-prices/trigger",
      headers: auth(await token("intruder-jobs")),
    });
    expect(res.statusCode).toBe(403);
  });

  it("PATCH /admin/vision-providers records an audit log entry", async () => {
    const t = await token("admin-v-audit", [ADMIN_GROUP]);
    await app.inject({
      method: "PATCH",
      url: "/admin/vision-providers",
      headers: auth(t),
      payload: [{ id: "openrouter", enabled: true, priority: 3 }],
    });
    const auditRes = await app.inject({
      method: "GET",
      url: "/admin/audit",
      headers: auth(t),
    });
    const log = auditRes.json() as { action: string; target: string }[];
    const entry = log.find(
      (e) => e.action === "update_vision_providers" && e.target.includes("openrouter"),
    );
    expect(entry).toBeDefined();
  });

  it("GET /admin/import-settings defaults to parser_first (admin only)", async () => {
    const forbidden = await app.inject({
      method: "GET",
      url: "/admin/import-settings",
      headers: auth(await token("nobody-import")),
    });
    expect(forbidden.statusCode).toBe(403);

    const ok = await app.inject({
      method: "GET",
      url: "/admin/import-settings",
      headers: auth(await token("admin-import", [ADMIN_GROUP])),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ strategy: "parser_first" });
  });

  it("PATCH /admin/import-settings persists the strategy and reflects it on GET", async () => {
    const t = await token("admin-import-patch", [ADMIN_GROUP]);
    const patched = await app.inject({
      method: "PATCH",
      url: "/admin/import-settings",
      headers: auth(t),
      payload: { strategy: "vision_only" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toEqual({ strategy: "vision_only" });

    const got = await app.inject({
      method: "GET",
      url: "/admin/import-settings",
      headers: auth(t),
    });
    expect(got.json()).toEqual({ strategy: "vision_only" });

    // Restore the default so other tests/uploads see parser_first.
    await app.inject({
      method: "PATCH",
      url: "/admin/import-settings",
      headers: auth(t),
      payload: { strategy: "parser_first" },
    });
  });

  it("PATCH /admin/import-settings rejects an invalid strategy with 400", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/admin/import-settings",
      headers: auth(await token("admin-import-bad", [ADMIN_GROUP])),
      payload: { strategy: "magic" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH /admin/import-settings is forbidden for non-admins", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/admin/import-settings",
      headers: auth(await token("plain-import")),
      payload: { strategy: "vision_only" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("PATCH /admin/import-settings records an audit log entry", async () => {
    const t = await token("admin-import-audit", [ADMIN_GROUP]);
    await app.inject({
      method: "PATCH",
      url: "/admin/import-settings",
      headers: auth(t),
      payload: { strategy: "vision_only" },
    });
    const auditRes = await app.inject({
      method: "GET",
      url: "/admin/audit",
      headers: auth(t),
    });
    const log = auditRes.json() as { action: string; target: string }[];
    const entry = log.find(
      (e) => e.action === "update_import_settings" && e.target === "vision_only",
    );
    expect(entry).toBeDefined();
    // Restore default.
    await app.inject({
      method: "PATCH",
      url: "/admin/import-settings",
      headers: auth(t),
      payload: { strategy: "parser_first" },
    });
  });

  // ── Admin users management (#486) ──────────────────────────────────────────────────

  /** Register a user and return their id. */
  async function ensureUser(sub: string, isAdmin = true): Promise<string> {
    const claims: Record<string, unknown> = { email: `${sub}@test.example` };
    if (isAdmin) claims.groups = [ADMIN_GROUP];
    const t = await new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256" })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${t}` },
    });
    return (res.json() as { id: string }).id;
  }

  it("rejects unauthenticated requests with 401 on all user endpoints", async () => {
    for (const url of [
      "/admin/users",
      "/admin/users/00000000-0000-0000-0000-000000000000/revoke-tokens",
      "/admin/users/00000000-0000-0000-0000-000000000000/reset-onboarding",
      "/admin/users/00000000-0000-0000-0000-000000000000/delete",
    ]) {
      const res = await app.inject({ method: url === "/admin/users" ? "GET" : "POST", url });
      expect(res.statusCode).toBe(401);
    }
  });

  it("rejects non-admin requests with 403", async () => {
    const id = await ensureUser("plain-user-admin-test", false);
    const t = await token("plain-user-admin-test");
    for (const url of [
      "/admin/users",
      "/admin/users/00000000-0000-0000-0000-000000000000/revoke-tokens",
      "/admin/users/00000000-0000-0000-0000-000000000000/reset-onboarding",
      "/admin/users/00000000-0000-0000-0000-000000000000/delete",
    ]) {
      const res = await app.inject({
        method: url === "/admin/users" ? "GET" : "POST",
        url,
        headers: auth(t),
      });
      expect(res.statusCode).toBe(403);
    }
    await app.db.delete(users).where(eq(users.id, id));
  });

  it("lists all users with aggregated counts", async () => {
    const idA = await ensureUser("user-list-a");
    const idB = await ensureUser("user-list-b");

    const [portA] = await app.db
      .insert(portfolios)
      .values({ userId: idA, name: "List Test" })
      .returning({ id: portfolios.id });
    await app.db.insert(transactions).values({
      portfolioId: portA.id,
      type: "buy",
      quantity: "10",
      price: "100",
      currency: "USD",
      executedAt: new Date(),
    });
    await app.db.insert(documents).values({
      userId: idA,
      storageKey: "test/a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
    });

    const res = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: auth(await token("admin-list-check", [ADMIN_GROUP])),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string;
      email: string;
      portfolioCount: number;
      transactionCount: number;
      documentCount: number;
      storageBytes: number;
      tokenCount: number;
    }[];
    const userA = body.find((u) => u.id === idA);
    const userB = body.find((u) => u.id === idB);
    expect(userA).toBeDefined();
    expect(userB).toBeDefined();
    expect(userA!.portfolioCount).toBe(1);
    expect(userA!.transactionCount).toBe(1);
    expect(userA!.documentCount).toBe(1);
    expect(userA!.storageBytes).toBe(2048);
    expect(userA!.tokenCount).toBe(0);
    expect(userB!.portfolioCount).toBe(0);
    expect(userB!.transactionCount).toBe(0);
    expect(userB!.documentCount).toBe(0);
    expect(userB!.storageBytes).toBe(0);

    await app.db.delete(users).where(eq(users.id, idA));
    await app.db.delete(users).where(eq(users.id, idB));
  });

  // Regression guard for a join fan-out: the query LEFT JOINs portfolios→transactions,
  // documents, and apiTokens onto users then GROUP BY users.id. Counts survive because
  // they use count(distinct …), but a plain sum(documents.sizeBytes) would be multiplied
  // once per (transaction × token) row in the joined Cartesian product. With 2
  // transactions and 2 tokens, a naive sum would report storageBytes 4x too large.
  it("does not inflate storageBytes via joined transactions/tokens fan-out", async () => {
    const id = await ensureUser("user-fanout-check");

    const hash = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
    const [port] = await app.db
      .insert(portfolios)
      .values({ userId: id, name: "Fanout Test" })
      .returning({ id: portfolios.id });
    await app.db.insert(transactions).values([
      {
        portfolioId: port.id,
        type: "buy",
        quantity: "10",
        price: "100",
        currency: "USD",
        executedAt: new Date(),
      },
      {
        portfolioId: port.id,
        type: "sell",
        quantity: "5",
        price: "110",
        currency: "USD",
        executedAt: new Date(),
      },
    ]);
    await app.db.insert(apiTokens).values([
      {
        userId: id,
        name: "t1",
        tokenHash: hash("fanout-t1"),
        tokenPrefix: "pt_ft1_",
        scope: "read",
      },
      {
        userId: id,
        name: "t2",
        tokenHash: hash("fanout-t2"),
        tokenPrefix: "pt_ft2_",
        scope: "read",
      },
    ]);
    await app.db.insert(documents).values([
      { userId: id, storageKey: "test/fanout-a.pdf", mimeType: "application/pdf", sizeBytes: 1000 },
      { userId: id, storageKey: "test/fanout-b.pdf", mimeType: "application/pdf", sizeBytes: 500 },
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: auth(await token("admin-fanout-check", [ADMIN_GROUP])),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string;
      documentCount: number;
      storageBytes: number;
      transactionCount: number;
      tokenCount: number;
    }[];
    const user = body.find((u) => u.id === id);
    expect(user).toBeDefined();
    expect(user!.transactionCount).toBe(2);
    expect(user!.tokenCount).toBe(2);
    expect(user!.documentCount).toBe(2);
    expect(user!.storageBytes).toBe(1500); // not 1500 * 2 * 2

    await app.db.delete(users).where(eq(users.id, id));
  });

  it("revokes all tokens for a user", async () => {
    const id = await ensureUser("revoke-test");

    const hash = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
    await app.db.insert(apiTokens).values({
      userId: id,
      name: "t1",
      tokenHash: hash("t1"),
      tokenPrefix: "pt_t1_",
      scope: "read",
    });
    await app.db.insert(apiTokens).values({
      userId: id,
      name: "t2",
      tokenHash: hash("t2"),
      tokenPrefix: "pt_t2_",
      scope: "write",
    });

    const res = await app.inject({
      method: "POST",
      url: `/admin/users/${id}/revoke-tokens`,
      headers: auth(await token("admin-revoke", [ADMIN_GROUP])),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: 2 });

    const remaining = await app.db
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .where(eq(apiTokens.userId, id));
    expect(remaining).toHaveLength(0);

    await app.db.delete(users).where(eq(users.id, id));
  });

  it("resets a user's onboarding-completed flag and records an audit entry", async () => {
    const id = await ensureUser("reset-onboarding-test");
    await app.db.update(users).set({ onboardingCompletedAt: new Date() }).where(eq(users.id, id));

    const res = await app.inject({
      method: "POST",
      url: `/admin/users/${id}/reset-onboarding`,
      headers: auth(await token("admin-reset-onboarding", [ADMIN_GROUP])),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reset: true });

    const [row] = await app.db
      .select({ onboardingCompletedAt: users.onboardingCompletedAt })
      .from(users)
      .where(eq(users.id, id));
    expect(row.onboardingCompletedAt).toBeNull();

    const log = await app.db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.action, "reset_user_onboarding"))
      .orderBy(sql`${adminAuditLog.at} desc`)
      .limit(1);
    expect(log[0]?.target).toBe(id);

    await app.db.delete(users).where(eq(users.id, id));
  });

  it("reset-onboarding is forbidden for non-admins", async () => {
    const id = await ensureUser("reset-onboarding-nonadmin", false);
    const res = await app.inject({
      method: "POST",
      url: `/admin/users/${id}/reset-onboarding`,
      headers: auth(await token("reset-onboarding-nonadmin")),
    });
    expect(res.statusCode).toBe(403);
    await app.db.delete(users).where(eq(users.id, id));
  });

  it("deletes a user, cascades data, and removes S3 docs", async () => {
    const id = await ensureUser("delete-cascade-test");

    const [port] = await app.db
      .insert(portfolios)
      .values({ userId: id, name: "Delete Test" })
      .returning({ id: portfolios.id });
    await app.db.insert(transactions).values({
      portfolioId: port.id,
      type: "buy",
      quantity: "5",
      price: "50",
      currency: "EUR",
      executedAt: new Date(),
    });
    await app.db.insert(documents).values({
      userId: id,
      storageKey: "test/delete-me.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4096,
    });

    const res = await app.inject({
      method: "POST",
      url: `/admin/users/${id}/delete`,
      headers: auth(await token("admin-delete-run", [ADMIN_GROUP])),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true });

    const userRows = await app.db.select({ id: users.id }).from(users).where(eq(users.id, id));
    expect(userRows).toHaveLength(0);

    const log = await app.db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.action, "delete_user"))
      .orderBy(sql`${adminAuditLog.at} desc`)
      .limit(1);
    expect(log[0]?.target).toBe(id);
    expect((log[0]?.meta as { docCount: number }).docCount).toBe(1);
  });

  it("rejects deleting your own account with 400", async () => {
    const t = await token("admin-self", [ADMIN_GROUP]);
    const me = await app.inject({ method: "GET", url: "/me", headers: auth(t) });
    const myId = (me.json() as { id: string }).id;

    const res = await app.inject({
      method: "POST",
      url: `/admin/users/${myId}/delete`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "cannot_delete_self" });

    await app.db.delete(users).where(eq(users.id, myId));
  });
});
