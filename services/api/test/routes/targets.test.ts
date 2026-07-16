import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

const ISSUER = "https://auth.test/application/o/portfolio/";
const AUDIENCE = "portfolio-tracker";

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
let privateKey: CryptoKey;

async function token(sub: string) {
  return new SignJWT({ email: `${sub}@example.com` })
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function createPortfolio(t: string) {
  const res = await app.inject({
    method: "POST",
    url: "/portfolios",
    headers: auth(t),
    payload: { name: "Test Portfolio", baseCurrency: "EUR" },
  });
  return res.json().id as string;
}

describe("allocation targets routes", () => {
  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    process.env.RATE_LIMIT_MAX = "10000";
    app = await buildApp({ authKey: kp.publicKey });
  });

  afterAll(async () => {
    await app.close();
    closeDb();
  });

  // ---------------------------------------------------------------------------
  // Aggregate (networth-level) targets
  // ---------------------------------------------------------------------------

  describe("networth targets", () => {
    it("GET /networth/targets — requires dimension param", async () => {
      const t = await token("user-nt-1");
      const res = await app.inject({
        method: "GET",
        url: "/networth/targets",
        headers: auth(t),
      });
      expect(res.statusCode).toBe(400);
    });

    it("GET /networth/targets — returns empty array when no targets", async () => {
      const t = await token("user-nt-2");
      const res = await app.inject({
        method: "GET",
        url: "/networth/targets?dimension=asset_class",
        headers: auth(t),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it("PUT /networth/targets — validates sum to 100", async () => {
      const t = await token("user-nt-3");
      const res = await app.inject({
        method: "PUT",
        url: "/networth/targets",
        headers: auth(t),
        payload: {
          dimension: "asset_class",
          targets: [
            { key: "equity", targetPct: 80 },
            { key: "bond", targetPct: 10 },
            // 90 total → should fail (not within 0.5 of 100)
          ],
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it("PUT /networth/targets — saves valid targets and GET round-trips", async () => {
      const t = await token("user-nt-4");
      const putRes = await app.inject({
        method: "PUT",
        url: "/networth/targets",
        headers: auth(t),
        payload: {
          dimension: "asset_class",
          targets: [
            { key: "equity", targetPct: 70 },
            { key: "bond", targetPct: 30 },
          ],
        },
      });
      expect(putRes.statusCode).toBe(200);
      const saved = putRes.json() as { key: string; targetPct: number }[];
      expect(saved).toHaveLength(2);
      expect(saved.find((s) => s.key === "equity")?.targetPct).toBe(70);
      expect(saved.find((s) => s.key === "bond")?.targetPct).toBe(30);

      // GET should return the same.
      const getRes = await app.inject({
        method: "GET",
        url: "/networth/targets?dimension=asset_class",
        headers: auth(t),
      });
      expect(getRes.statusCode).toBe(200);
      const fetched = getRes.json() as { key: string; targetPct: number }[];
      expect(fetched).toHaveLength(2);
      expect(fetched.find((s) => s.key === "equity")?.targetPct).toBe(70);
    });

    it("PUT /networth/targets — replaces existing set atomically", async () => {
      const t = await token("user-nt-5");
      // First save.
      await app.inject({
        method: "PUT",
        url: "/networth/targets",
        headers: auth(t),
        payload: {
          dimension: "asset_class",
          targets: [
            { key: "equity", targetPct: 70 },
            { key: "bond", targetPct: 30 },
          ],
        },
      });
      // Replace with a different split.
      const putRes = await app.inject({
        method: "PUT",
        url: "/networth/targets",
        headers: auth(t),
        payload: {
          dimension: "asset_class",
          targets: [
            { key: "etf", targetPct: 80 },
            { key: "cash", targetPct: 20 },
          ],
        },
      });
      expect(putRes.statusCode).toBe(200);
      const saved = putRes.json() as { key: string; targetPct: number }[];
      // Old keys (equity, bond) should be gone.
      expect(saved.find((s) => s.key === "equity")).toBeUndefined();
      expect(saved.find((s) => s.key === "etf")?.targetPct).toBe(80);
    });

    it("targets are scoped to authenticated user", async () => {
      const t1 = await token("user-nt-6a");
      const t2 = await token("user-nt-6b");
      await app.inject({
        method: "PUT",
        url: "/networth/targets",
        headers: auth(t1),
        payload: {
          dimension: "currency",
          targets: [{ key: "EUR", targetPct: 100 }],
        },
      });
      // user 2 should not see user 1's targets.
      const res = await app.inject({
        method: "GET",
        url: "/networth/targets?dimension=currency",
        headers: auth(t2),
      });
      expect(res.json()).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Per-portfolio targets
  // ---------------------------------------------------------------------------

  describe("portfolio targets", () => {
    it("GET /portfolios/:id/targets — 404 for missing portfolio", async () => {
      const t = await token("user-pt-1");
      const res = await app.inject({
        method: "GET",
        url: "/portfolios/00000000-0000-0000-0000-000000000099/targets?dimension=asset_class",
        headers: auth(t),
      });
      expect(res.statusCode).toBe(404);
    });

    it("PUT + GET round-trip for portfolio targets", async () => {
      const t = await token("user-pt-2");
      const portfolioId = await createPortfolio(t);

      const putRes = await app.inject({
        method: "PUT",
        url: `/portfolios/${portfolioId}/targets`,
        headers: auth(t),
        payload: {
          dimension: "instrument",
          targets: [
            { key: "inst-world", targetPct: 70 },
            { key: "inst-em", targetPct: 30 },
          ],
        },
      });
      expect(putRes.statusCode).toBe(200);

      const getRes = await app.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/targets?dimension=instrument`,
        headers: auth(t),
      });
      expect(getRes.statusCode).toBe(200);
      const fetched = getRes.json() as { key: string; targetPct: number }[];
      expect(fetched.find((s) => s.key === "inst-world")?.targetPct).toBe(70);
      expect(fetched.find((s) => s.key === "inst-em")?.targetPct).toBe(30);
    });

    it("portfolio targets are independent of networth targets for the same dimension", async () => {
      const t = await token("user-pt-3");
      const portfolioId = await createPortfolio(t);

      // Save networth target (no portfolioId scope).
      await app.inject({
        method: "PUT",
        url: "/networth/targets",
        headers: auth(t),
        payload: {
          dimension: "asset_class",
          targets: [
            { key: "equity", targetPct: 60 },
            { key: "bond", targetPct: 40 },
          ],
        },
      });

      // Save portfolio-specific target.
      await app.inject({
        method: "PUT",
        url: `/portfolios/${portfolioId}/targets`,
        headers: auth(t),
        payload: {
          dimension: "asset_class",
          targets: [
            { key: "equity", targetPct: 90 },
            { key: "bond", targetPct: 10 },
          ],
        },
      });

      // Portfolio target should reflect the per-portfolio split.
      const getRes = await app.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/targets?dimension=asset_class`,
        headers: auth(t),
      });
      expect(getRes.json().find((s: { key: string }) => s.key === "equity")?.targetPct).toBe(90);

      // Networth target should remain at the aggregate split.
      const networthRes = await app.inject({
        method: "GET",
        url: "/networth/targets?dimension=asset_class",
        headers: auth(t),
      });
      expect(networthRes.json().find((s: { key: string }) => s.key === "equity")?.targetPct).toBe(
        60,
      );
    });
  });
});
