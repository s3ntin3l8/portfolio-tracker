import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { instruments } from "@portfolio/db";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

// Covers issue #562: "Show flagged only" / "Needs review" showed a non-zero count but an
// empty filtered list, because the count came from an unpaginated whole-scope anomalies
// scan while the filter only searched already-loaded (paginated) rows. The fix fetches the
// flagged rows directly by id — this suite exercises the two new server pieces that back
// that: the `ids` querystring filter on both list routes, and the new cross-portfolio
// `GET /networth/anomalies` endpoint (the aggregate view previously never fetched anomalies
// at all).

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

describe("transactions ids filter + /networth/anomalies (#562)", () => {
  let instrumentId: string;

  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    process.env.RATE_LIMIT_MAX = "10000";
    app = await buildApp({ authKey: kp.publicKey });
    const [inst] = await app.db
      .insert(instruments)
      .values({
        symbol: "IDST",
        market: "IDX",
        assetClass: "equity",
        currency: "IDR",
        name: "Ids/Networth Anomalies Test Co",
      })
      .returning();
    instrumentId = inst.id;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    delete process.env.RATE_LIMIT_MAX;
  });

  async function createPortfolio(t: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(t),
      payload: { name, baseCurrency: "idr" },
    });
    return res.json().id as string;
  }

  async function createTx(t: string, portfolioId: string, overrides: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: {
        type: "buy",
        instrumentId,
        quantity: "1",
        price: "100",
        currency: "IDR",
        executedAt: "2025-03-01T00:00:00.000Z",
        ...overrides,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  it("GET /portfolios/:id/transactions?ids= returns exactly those rows, enriched, ignoring pagination", async () => {
    const t = await token("ids-portfolio-user");
    const portfolioId = await createPortfolio(t, "Ids filter test");
    const idA = await createTx(t, portfolioId, { executedAt: "2020-01-01T00:00:00.000Z" });
    const idB = await createTx(t, portfolioId, { executedAt: "2021-01-01T00:00:00.000Z" });
    // A third, very old row that would sit off any small page — proves the `ids` fetch
    // isn't scoped by pagination.
    await createTx(t, portfolioId, { executedAt: "2010-01-01T00:00:00.000Z" });

    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions?ids=${idA},${idB}`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r: { id: string }) => r.id))).toEqual(new Set([idA, idB]));
    // Enriched the same way as a normal page (instrument attached).
    expect(rows[0].instrument).toMatchObject({ symbol: "IDST" });
  });

  it("GET /portfolios/:id/transactions?ids= excludes ids from another portfolio (scoping still applies)", async () => {
    const t = await token("ids-scoping-user");
    const portfolioA = await createPortfolio(t, "Ids scoping A");
    const portfolioB = await createPortfolio(t, "Ids scoping B");
    const idInA = await createTx(t, portfolioA);
    const idInB = await createTx(t, portfolioB);

    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioA}/transactions?ids=${idInA},${idInB}`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows.map((r: { id: string }) => r.id)).toEqual([idInA]);
  });

  it("GET /networth/transactions?ids= returns exactly those rows across portfolios, ignoring pagination", async () => {
    const t = await token("ids-networth-user");
    const portfolioA = await createPortfolio(t, "Networth ids A");
    const portfolioB = await createPortfolio(t, "Networth ids B");
    const idA = await createTx(t, portfolioA, { executedAt: "2010-01-01T00:00:00.000Z" });
    const idB = await createTx(t, portfolioB, { executedAt: "2011-01-01T00:00:00.000Z" });
    await createTx(t, portfolioA, { executedAt: "2025-01-01T00:00:00.000Z" });

    const res = await app.inject({
      method: "GET",
      url: `/networth/transactions?ids=${idA},${idB}`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(new Set(rows.map((r: { id: string }) => r.id))).toEqual(new Set([idA, idB]));
  });

  it("GET /networth/transactions?ids= never returns another user's transaction", async () => {
    const t1 = await token("ids-networth-owner");
    const t2 = await token("ids-networth-other");
    const portfolio1 = await createPortfolio(t1, "Networth ids owner");
    const idOwner = await createTx(t1, portfolio1);

    const res = await app.inject({
      method: "GET",
      url: `/networth/transactions?ids=${idOwner}`,
      headers: auth(t2),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("GET /networth/anomalies merges anomalies across portfolios, matching the union of per-portfolio /anomalies", async () => {
    const t = await token("networth-anomalies-user");
    const portfolioA = await createPortfolio(t, "Networth anomalies A");
    const portfolioB = await createPortfolio(t, "Networth anomalies B");
    // zero_price (warning): a trade-type tx with price = 0.
    const flaggedA = await createTx(t, portfolioA, { price: "0" });
    const flaggedB = await createTx(t, portfolioB, { price: "0" });
    // A clean row in each portfolio that must NOT be flagged.
    await createTx(t, portfolioA);
    await createTx(t, portfolioB);

    const [perA, perB, aggregate] = await Promise.all([
      app.inject({ method: "GET", url: `/portfolios/${portfolioA}/anomalies`, headers: auth(t) }),
      app.inject({ method: "GET", url: `/portfolios/${portfolioB}/anomalies`, headers: auth(t) }),
      app.inject({ method: "GET", url: "/networth/anomalies", headers: auth(t) }),
    ]);
    expect(perA.statusCode).toBe(200);
    expect(perB.statusCode).toBe(200);
    expect(aggregate.statusCode).toBe(200);

    const perAIds = perA.json().anomalies.map((a: { transactionId?: string }) => a.transactionId);
    const perBIds = perB.json().anomalies.map((a: { transactionId?: string }) => a.transactionId);
    const aggregateIds = aggregate
      .json()
      .anomalies.map((a: { transactionId?: string }) => a.transactionId);

    expect(perAIds).toEqual([flaggedA]);
    expect(perBIds).toEqual([flaggedB]);
    expect(new Set(aggregateIds)).toEqual(new Set([...perAIds, ...perBIds]));

    // The exact bug scenario: fetching the aggregate-flagged ids by id surfaces both rows,
    // regardless of which portfolio they belong to or where they'd fall in a paginated list.
    const flaggedRows = await app.inject({
      method: "GET",
      url: `/networth/transactions?ids=${aggregateIds.join(",")}`,
      headers: auth(t),
    });
    expect(flaggedRows.statusCode).toBe(200);
    expect(new Set(flaggedRows.json().map((r: { id: string }) => r.id))).toEqual(
      new Set([flaggedA, flaggedB]),
    );
  });

  it("GET /networth/anomalies only reflects the requesting user's own portfolios", async () => {
    const t1 = await token("networth-anomalies-owner");
    const t2 = await token("networth-anomalies-other");
    const portfolio1 = await createPortfolio(t1, "Networth anomalies owner");
    await createTx(t1, portfolio1, { price: "0" });

    const res = await app.inject({
      method: "GET",
      url: "/networth/anomalies",
      headers: auth(t2),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().anomalies).toEqual([]);
  });
});
