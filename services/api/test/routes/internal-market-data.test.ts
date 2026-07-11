import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { users, apiTokens } from "@portfolio/db";
import { buildApp } from "../../src/app.js";
import {
  upsertScrapedQuote,
  ANTAM_BUYBACK_KEY,
  GALERI24_BUYBACK_KEY,
  navKey,
} from "../../src/services/scrapers/store.js";
import type { FastifyInstance } from "fastify";
import { closeDb } from "../../src/db/client.js";
import { hashToken, PAT_PREFIX } from "../../src/plugins/auth.js";

const ISSUER = "https://auth.test/application/o/portfolio/";
const AUDIENCE = "portfolio-tracker";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("internal market-data routes", () => {
  let app: FastifyInstance;
  let privateKey: CryptoKey;
  let token: string;

  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    process.env.RATE_LIMIT_MAX = "10000";
    app = await buildApp({ authKey: kp.publicKey });
    token = await new SignJWT({ email: "market-data@example.com" })
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("market-data")
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    await upsertScrapedQuote(app.db, ANTAM_BUYBACK_KEY, 2591100, "harga-emas");
    await upsertScrapedQuote(app.db, GALERI24_BUYBACK_KEY, 2549000, "galeri24");
    await upsertScrapedQuote(app.db, navKey("RDPU"), 1234.56, "bibit");
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    delete process.env.RATE_LIMIT_MAX;
  });

  it("serves the cached Antam buyback in the provider's shape", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/internal/gold/antam-buyback",
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ buyback: 2591100 });
  });

  it("serves the cached Galeri24 buyback in the provider's shape", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/internal/gold/galeri24-buyback",
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ buyback: 2549000 });
  });

  it("serves a cached fund NAV by symbol", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/internal/nav/RDPU",
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ nav: 1234.56 });
  });

  it("404s for an unknown fund symbol after authentication", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/internal/nav/UNKNOWN",
      headers: auth(token),
    });
    expect(res.statusCode).toBe(404);
  });

  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/internal/gold/antam-buyback" });
    expect(res.statusCode).toBe(401);
  });

  it("accepts read-only personal access tokens for GET routes", async () => {
    await app.inject({ method: "GET", url: "/me", headers: auth(token) });
    const [u] = await app.db.select().from(users).where(eq(users.authSub, "market-data")).limit(1);
    const secret = `${PAT_PREFIX}internal-read`;
    await app.db.insert(apiTokens).values({
      userId: u.id,
      name: "internal-read",
      tokenHash: hashToken(secret),
      tokenPrefix: secret.slice(0, 12),
      scope: "read",
    });

    const res = await app.inject({
      method: "GET",
      url: "/internal/gold/antam-buyback",
      headers: auth(secret),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ buyback: 2591100 });
  });
});
