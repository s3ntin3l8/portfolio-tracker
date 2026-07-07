import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { ibkrConnections, portfolios, users } from "@portfolio/db";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import type { IbkrFlexClient } from "../../src/services/ibkr/flex-client.js";
import type { FastifyInstance } from "fastify";

const TEST_AUTH_KEY = "test-key-ibkr-routes-xyzabc";

async function token(sub: string): Promise<string> {
  return new SignJWT({ email: `${sub}@test.com` })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(TEST_AUTH_KEY));
}
function auth(t: string) {
  return { authorization: `Bearer ${t}`, "content-type": "application/json" };
}

const EMPTY_FLEX_XML =
  `<?xml version="1.0"?><FlexQueryResponse queryName="Test"><FlexStatements count="0"/></FlexQueryResponse>`;

function okFlex(): IbkrFlexClient {
  return { fetchFlexStatement: async () => EMPTY_FLEX_XML };
}


let app: FastifyInstance;
let userId: string;
let portfolioId: string;

beforeAll(async () => {
  app = await buildApp({ authKey: new TextEncoder().encode(TEST_AUTH_KEY), ibkrFlex: okFlex() });

  const [user] = await app.db
    .insert(users)
    .values({ authSub: "ibkr-route-user-abc", email: "ibkr-abc@test.com" })
    .returning();
  userId = user.id;

  const [portfolio] = await app.db
    .insert(portfolios)
    .values({ userId, name: "IBKR Route Test", baseCurrency: "USD", cashCounted: false })
    .returning();
  portfolioId = portfolio.id;
});

afterAll(async () => {
  await closeDb();
});

describe("IBKR routes", () => {
  describe("GET /ibkr/connection", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/ibkr/connection" });
      expect(res.statusCode).toBe(401);
    });

    it("returns disconnected state when no connection exists", async () => {
      const t = await token("ibkr-route-user-abc");
      const res = await app.inject({
        method: "GET",
        url: "/ibkr/connection",
        headers: auth(t),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("disconnected");
      expect(body.portfolioId).toBeNull();
      expect(body.syncing).toBe(false);
    });
  });

  describe("POST /ibkr/connection", () => {
    it("returns 503 when encryption is disabled (test env has no key)", async () => {
      const t = await token("ibkr-route-user-abc");
      const res = await app.inject({
        method: "POST",
        url: "/ibkr/connection",
        headers: auth(t),
        body: JSON.stringify({ token: "T", queryId: "Q", portfolioId }),
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("encryption_required");
    });

    it("returns 401 without auth", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/ibkr/connection",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "T", queryId: "Q", portfolioId }),
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("DELETE /ibkr/connection", () => {
    it("returns 204 even with no existing connection", async () => {
      const t = await token("ibkr-route-user-abc");
      const res = await app.inject({
        method: "DELETE",
        url: "/ibkr/connection",
        headers: auth(t),
      });
      expect(res.statusCode).toBe(204);
    });
  });

  describe("POST /ibkr/connection/sync (not connected)", () => {
    it("returns 409 not_connected when no connection exists", async () => {
      const t = await token("ibkr-route-user-abc");
      const res = await app.inject({
        method: "POST",
        url: "/ibkr/connection/sync",
        headers: auth(t),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("not_connected");
    });
  });

  describe("POST /ibkr/connection/reimport (not connected)", () => {
    it("returns 409 not_connected when no connection exists", async () => {
      const t = await token("ibkr-route-user-abc");
      const res = await app.inject({
        method: "POST",
        url: "/ibkr/connection/reimport",
        headers: auth(t),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("not_connected");
    });
  });

  describe("connected flow (with encryption-enabled app)", () => {
    let connApp: FastifyInstance;
    let connUserId: string;
    let connPortfolioId: string;

    beforeAll(async () => {
      // Build a separate app instance with encryption enabled (EncryptionService accepts
      // a 32-byte key). We can't use process.env in tests, so we inject the flex client
      // and rely on the fact that buildApp creates a fresh PGlite with encryption on.
      connApp = await buildApp({
        authKey: new TextEncoder().encode(TEST_AUTH_KEY),
        ibkrFlex: okFlex(),
        // No encryption key injected here — we test the connected state by pre-seeding
        // the ibkrConnections table directly with an already-encrypted token.
      });

      const [u] = await connApp.db
        .insert(users)
        .values({ authSub: "ibkr-connected-user", email: "connected@ibkr.test" })
        .returning();
      connUserId = u.id;

      const [p] = await connApp.db
        .insert(portfolios)
        .values({ userId: connUserId, name: "Connected Portfolio", baseCurrency: "USD", cashCounted: false })
        .returning();
      connPortfolioId = p.id;

      // Pre-seed a connected ibkr connection with a plaintext token (encryption disabled
      // in tests — encryptString is identity, decryptString is identity).
      await connApp.db.insert(ibkrConnections).values({
        userId: connUserId,
        portfolioId: connPortfolioId,
        tokenEnc: connApp.encryption.encryptString("TEST_TOKEN"),
        queryId: "42",
        status: "connected",
      });
    });

    afterAll(async () => {
      await connApp.close();
    });

    it("GET /ibkr/connection returns connected state", async () => {
      const t = await token("ibkr-connected-user");
      const res = await connApp.inject({
        method: "GET",
        url: "/ibkr/connection",
        headers: auth(t),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("connected");
      expect(res.json().portfolioId).toBe(connPortfolioId);
    });

    it("POST /ibkr/connection/sync falls back to inline (pg-boss unavailable in PGlite)", async () => {
      const t = await token("ibkr-connected-user");
      const res = await connApp.inject({
        method: "POST",
        url: "/ibkr/connection/sync",
        headers: auth(t),
      });
      // pg-boss unavailable → inline sync → 200 with sync result
      expect([200, 202]).toContain(res.statusCode);
    });

    it("POST /ibkr/connection/sync 409s sync_in_progress when a sync is already running", async () => {
      const [u] = await connApp.db
        .insert(users)
        .values({ authSub: "ibkr-sync-inflight", email: "inflight@ibkr.test" })
        .returning();
      const [p] = await connApp.db
        .insert(portfolios)
        .values({ userId: u.id, name: "Inflight", baseCurrency: "USD", cashCounted: false })
        .returning();
      await connApp.db.insert(ibkrConnections).values({
        userId: u.id,
        portfolioId: p.id,
        tokenEnc: connApp.encryption.encryptString("TK"),
        queryId: "1",
        status: "connected",
        // Simulate a sync already in flight (the flag the route guards on).
        syncing: true,
      });

      const t = await token("ibkr-sync-inflight");
      const res = await connApp.inject({
        method: "POST",
        url: "/ibkr/connection/sync",
        headers: auth(t),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "sync_in_progress" });
    });

    it("POST /ibkr/connection/sync re-claims a stale syncing flag past the lease (killed worker)", async () => {
      const [u] = await connApp.db
        .insert(users)
        .values({ authSub: "ibkr-sync-stale-lease", email: "stale-lease@ibkr.test" })
        .returning();
      const [p] = await connApp.db
        .insert(portfolios)
        .values({ userId: u.id, name: "Stale Lease", baseCurrency: "USD", cashCounted: false })
        .returning();
      await connApp.db.insert(ibkrConnections).values({
        userId: u.id,
        portfolioId: p.id,
        tokenEnc: connApp.encryption.encryptString("TK"),
        queryId: "1",
        status: "connected",
        // A claim left behind by a worker killed mid-sync (process restart/crash) —
        // `syncing` never got cleared, and it's old enough to be past SYNC_CLAIM_LEASE_MS.
        syncing: true,
        updatedAt: new Date(Date.now() - 3 * 60 * 60_000),
      });

      const t = await token("ibkr-sync-stale-lease");
      const res = await connApp.inject({
        method: "POST",
        url: "/ibkr/connection/sync",
        headers: auth(t),
      });
      // Not blocked by the stale claim (would be 409 if the lease weren't honored).
      expect([200, 202]).toContain(res.statusCode);
    });

    it("POST /ibkr/connection/reimport returns removed count", async () => {
      const t = await token("ibkr-connected-user");
      const res = await connApp.inject({
        method: "POST",
        url: "/ibkr/connection/reimport",
        headers: auth(t),
      });
      expect(res.statusCode).toBe(200);
      expect(typeof res.json().removed).toBe("number");
    });

    it("DELETE /ibkr/connection removes the connection row", async () => {
      // Use a separate user so we don't affect the other tests.
      const [u] = await connApp.db
        .insert(users)
        .values({ authSub: "ibkr-delete-user", email: "delete@ibkr.test" })
        .returning();
      const [p] = await connApp.db
        .insert(portfolios)
        .values({ userId: u.id, name: "Delete Me", baseCurrency: "USD", cashCounted: false })
        .returning();
      await connApp.db.insert(ibkrConnections).values({
        userId: u.id,
        portfolioId: p.id,
        tokenEnc: connApp.encryption.encryptString("TK"),
        queryId: "1",
        status: "connected",
      });

      const t = await token("ibkr-delete-user");
      const res = await connApp.inject({
        method: "DELETE",
        url: "/ibkr/connection",
        headers: auth(t),
      });
      expect(res.statusCode).toBe(204);

      const rows = await connApp.db
        .select()
        .from(ibkrConnections)
        .where(eq(ibkrConnections.userId, u.id));
      expect(rows).toHaveLength(0);
    });
  });
});
