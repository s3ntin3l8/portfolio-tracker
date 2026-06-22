/**
 * Tests for `GET /search` — user-scoped global search.
 *
 * Verifies: matching by description/tags, instrument results with owned flag,
 * user isolation (no cross-user data leakage), holderId scoping, and limit.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT, type JWK, exportJWK } from "jose";
import { instruments } from "@portfolio/db";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

const ISSUER = "https://auth.test/application/o/portfolio/";
const AUDIENCE = "portfolio-tracker";

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let privateKey: CryptoKey;
let publicJwk: JWK;

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

async function createPortfolio(t: string, name = "Main") {
  const res = await app.inject({
    method: "POST",
    url: "/portfolios",
    headers: auth(t),
    payload: { name, baseCurrency: "IDR" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function createTransaction(
  t: string,
  portfolioId: string,
  payload: Record<string, unknown>,
) {
  const res = await app.inject({
    method: "POST",
    url: `/portfolios/${portfolioId}/transactions`,
    headers: auth(t),
    payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe("GET /search", () => {
  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    publicJwk = await exportJWK(kp.publicKey);
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    process.env.RATE_LIMIT_MAX = "10000";
    app = await buildApp({ authKey: kp.publicKey });
    expect(publicJwk.kty).toBe("EC"); // sanity
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    delete process.env.RATE_LIMIT_MAX;
  });

  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/search?q=test" });
    expect(res.statusCode).toBe(401);
  });

  it("requires q", async () => {
    const t = await token("search-user-0");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) }); // upsert
    const res = await app.inject({ method: "GET", url: "/search", headers: auth(t) });
    expect(res.statusCode).toBe(400);
  });

  it("returns matching transactions by description", async () => {
    const t = await token("search-user-desc");
    const pfId = await createPortfolio(t);

    // Create a transaction with a distinctive description.
    const tx = await createTransaction(t, pfId, {
      type: "deposit",
      quantity: "0",
      price: "5000000",
      currency: "IDR",
      executedAt: "2026-01-10T00:00:00.000Z",
      description: "Transfer from BNI savings account",
    });

    // Should match on part of the description.
    const res = await app.inject({
      method: "GET",
      url: "/search?q=BNI+savings",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.transactions)).toBe(true);
    expect(body.transactions.some((r: { id: string }) => r.id === tx.id)).toBe(true);
  });

  it("returns matching transactions by tags", async () => {
    const t = await token("search-user-tags");
    const pfId = await createPortfolio(t);

    const tx = await createTransaction(t, pfId, {
      type: "deposit",
      quantity: "0",
      price: "1000000",
      currency: "IDR",
      executedAt: "2026-02-01T00:00:00.000Z",
      description: "Monthly savings",
      tags: ["emergency-fund", "savings"],
    });

    const res = await app.inject({
      method: "GET",
      url: "/search?q=emergency-fund",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transactions.some((r: { id: string }) => r.id === tx.id)).toBe(true);
  });

  it("returns instruments from the global catalog with the owned flag", async () => {
    const t = await token("search-user-instr");
    const pfId = await createPortfolio(t);

    // Insert two instruments: one the user owns, one they don't.
    const [owned] = await app.db
      .insert(instruments)
      .values({ symbol: "SRCH_OWN", market: "IDX", assetClass: "equity", currency: "IDR", name: "Owned Corp" })
      .onConflictDoNothing()
      .returning();
    await app.db
      .insert(instruments)
      .values({ symbol: "SRCH_CAT", market: "IDX", assetClass: "equity", currency: "IDR", name: "Catalog Only Corp" })
      .onConflictDoNothing();

    // Buy the owned instrument.
    await createTransaction(t, pfId, {
      type: "buy",
      instrumentId: owned.id,
      quantity: "10",
      price: "1000",
      currency: "IDR",
      executedAt: "2026-01-15T00:00:00.000Z",
    });

    // Search for "Corp" — both instruments should match.
    const res = await app.inject({
      method: "GET",
      url: "/search?q=Corp",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const instrs = body.instruments as Array<{ symbol: string; owned: boolean }>;

    const ownedResult = instrs.find((i) => i.symbol === "SRCH_OWN");
    const catalogResult = instrs.find((i) => i.symbol === "SRCH_CAT");
    expect(ownedResult).toBeDefined();
    expect(ownedResult?.owned).toBe(true);
    expect(catalogResult).toBeDefined();
    expect(catalogResult?.owned).toBe(false);

    // Owned instruments sort first.
    const ownedIdx = instrs.findIndex((i) => i.symbol === "SRCH_OWN");
    const catalogIdx = instrs.findIndex((i) => i.symbol === "SRCH_CAT");
    expect(ownedIdx).toBeLessThan(catalogIdx);
  });

  it("does not leak another user's transactions", async () => {
    const alice = await token("search-alice");
    const bob = await token("search-bob");
    const alicePf = await createPortfolio(alice, "Alice Portfolio");
    await createPortfolio(bob, "Bob Portfolio"); // ensure bob is upserted

    await createTransaction(alice, alicePf, {
      type: "deposit",
      quantity: "0",
      price: "999999",
      currency: "IDR",
      executedAt: "2026-03-01T00:00:00.000Z",
      description: "alice-secret-transfer",
    });

    // Bob searches for Alice's unique string — should get no results.
    const res = await app.inject({
      method: "GET",
      url: "/search?q=alice-secret",
      headers: auth(bob),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transactions).toHaveLength(0);
  });

  it("honours the limit parameter", async () => {
    const t = await token("search-user-limit");
    const pfId = await createPortfolio(t);

    // Insert an instrument matching the search.
    const [instr] = await app.db
      .insert(instruments)
      .values({ symbol: "LMT_SRCH", market: "IDX", assetClass: "equity", currency: "IDR", name: "Limit Test Corp" })
      .onConflictDoNothing()
      .returning();

    // Create 5 transactions with matching descriptions.
    for (let i = 1; i <= 5; i++) {
      await createTransaction(t, pfId, {
        type: "buy",
        instrumentId: instr.id,
        quantity: "1",
        price: "100",
        currency: "IDR",
        executedAt: `2026-0${i}-01T00:00:00.000Z`,
        description: "limit-test-keyword",
      });
    }

    const res = await app.inject({
      method: "GET",
      url: "/search?q=limit-test-keyword&limit=2",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    // At most 2 transaction results returned.
    expect(res.json().transactions.length).toBeLessThanOrEqual(2);
  });

  it("returns empty results for a user with no portfolios", async () => {
    const t = await token("search-user-empty");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) }); // upsert user

    const res = await app.inject({
      method: "GET",
      url: "/search?q=anymatch",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Instruments may still return catalog matches; transactions must be empty.
    expect(body.transactions).toHaveLength(0);
  });

  it("returns 404 for a holderId that is not owned by the user", async () => {
    const t = await token("search-user-holder");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) }); // upsert

    // Use a non-existent holder ID that passes z.guid() validation.
    const fakeHolderId = "11111111-1111-1111-1111-111111111111";
    const res = await app.inject({
      method: "GET",
      url: `/search?q=test&holderId=${fakeHolderId}`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(404);
  });
});
