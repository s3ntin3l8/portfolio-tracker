import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import type { StorageProvider } from "../../src/storage/types.js";

const ISSUER = "https://auth.test/application/o/portfolio/";
const AUDIENCE = "portfolio-tracker";
const ADMIN_GROUP = "portfolio-admins";

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let privateKey: CryptoKey;

// A fake storage driver that records calls (no real I/O).
function makeInertStorage(): StorageProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    put: async (key) => { calls.push(`put:${key}`); },
    getSignedUrl: async (key) => `https://fake.storage/${key}?signed=1`,
    delete: async (key) => { calls.push(`delete:${key}`); },
    exists: async () => true,
    get: async () => null,
    move: async () => {},
    stats: async () => ({ objectCount: 3, totalBytes: 1024 }),
  };
}

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

describe("admin storage routes", () => {
  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    process.env.AUTHENTIK_ADMIN_GROUP = ADMIN_GROUP;
    process.env.RATE_LIMIT_MAX = "10000";
    app = await buildApp({ authKey: kp.publicKey, storage: makeInertStorage() });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    delete process.env.AUTHENTIK_ADMIN_GROUP;
    delete process.env.RATE_LIMIT_MAX;
  });

  describe("GET /admin/storage-providers", () => {
    it("returns 401 without a token", async () => {
      const res = await app.inject({ method: "GET", url: "/admin/storage-providers" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 for a non-admin token", async () => {
      const t = await token("plain-user");
      const res = await app.inject({
        method: "GET",
        url: "/admin/storage-providers",
        headers: auth(t),
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns storage config for an admin", async () => {
      const t = await token("admin", [ADMIN_GROUP]);
      const res = await app.inject({
        method: "GET",
        url: "/admin/storage-providers",
        headers: auth(t),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty("activeProvider");
      expect(body).toHaveProperty("s3");
      expect(body).toHaveProperty("folder");
      expect(body).toHaveProperty("encryptionEnabled");
      // Secret must not be present as plaintext
      expect(JSON.stringify(body)).not.toContain("minioadmin");
    });
  });

  describe("PATCH /admin/storage-providers", () => {
    it("updates the active provider and returns the updated config", async () => {
      const t = await token("admin", [ADMIN_GROUP]);
      const res = await app.inject({
        method: "PATCH",
        url: "/admin/storage-providers",
        headers: { ...auth(t), "content-type": "application/json" },
        payload: JSON.stringify({ activeProvider: "folder", folderPath: "/tmp/test" }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.activeProvider).toBe("folder");
      expect(body.folder.path).toBe("/tmp/test");
    });

    it("rejects invalid activeProvider values", async () => {
      const t = await token("admin", [ADMIN_GROUP]);
      const res = await app.inject({
        method: "PATCH",
        url: "/admin/storage-providers",
        headers: { ...auth(t), "content-type": "application/json" },
        payload: JSON.stringify({ activeProvider: "ftp" }),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("PUT /admin/storage-providers/s3/secret", () => {
    it("returns 503 when encryption is not configured", async () => {
      const t = await token("admin", [ADMIN_GROUP]);
      const res = await app.inject({
        method: "PUT",
        url: "/admin/storage-providers/s3/secret",
        headers: { ...auth(t), "content-type": "application/json" },
        payload: JSON.stringify({ apiKey: "secretvalue" }),
      });
      // DB_ENCRYPTION_KEY is not set in test env → 503
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: "encryption_required" });
    });
  });

  describe("POST /admin/storage-providers/test", () => {
    it("performs a round-trip and returns ok: true with the injected storage", async () => {
      const t = await token("admin", [ADMIN_GROUP]);
      const res = await app.inject({
        method: "POST",
        url: "/admin/storage-providers/test",
        headers: auth(t),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true });
    });
  });

  describe("GET /admin/stats — objectStorage section", () => {
    it("returns objectStorage with counts under NODE_ENV=test (nulled out)", async () => {
      const t = await token("admin", [ADMIN_GROUP]);
      const res = await app.inject({
        method: "GET",
        url: "/admin/stats",
        headers: auth(t),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty("objectStorage");
      // Under NODE_ENV=test the provider stats are skipped (same guard as pg catalog queries)
      expect(body.objectStorage).toMatchObject({ configured: false });
    });
  });
});
