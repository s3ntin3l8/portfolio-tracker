import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { instruments } from "@portfolio/db";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

// Covers issue #585: the instrument detail page's transactions table needs a real
// server-side `?instrumentId=` filter on both list routes (matching the existing
// `type`/`year`/`q` filters) instead of fetching the whole portfolio/networth scope
// and filtering client-side. This also exercises that `total` and the `years` list
// returned alongside the page are scoped to the instrument, not the whole portfolio.

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

describe("?instrumentId= filter on the transaction list routes (#585)", () => {
  let instrumentA: string;
  let instrumentB: string;

  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    process.env.RATE_LIMIT_MAX = "10000";
    app = await buildApp({ authKey: kp.publicKey });
    const [a, b] = await app.db
      .insert(instruments)
      .values([
        {
          symbol: "INSTA",
          market: "IDX",
          assetClass: "equity",
          currency: "IDR",
          name: "Instrument A",
        },
        {
          symbol: "INSTB",
          market: "IDX",
          assetClass: "equity",
          currency: "IDR",
          name: "Instrument B",
        },
      ])
      .returning();
    instrumentA = a.id;
    instrumentB = b.id;
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

  async function createTx(
    t: string,
    portfolioId: string,
    instrumentId: string,
    executedAt: string,
  ) {
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
        executedAt,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  it("GET /portfolios/:id/transactions?instrumentId= returns only that instrument's rows, total, and years", async () => {
    const t = await token("instrument-filter-portfolio-user");
    const portfolioId = await createPortfolio(t, "Instrument filter test");
    const idA1 = await createTx(t, portfolioId, instrumentA, "2024-01-01T00:00:00.000Z");
    const idA2 = await createTx(t, portfolioId, instrumentA, "2025-06-01T00:00:00.000Z");
    await createTx(t, portfolioId, instrumentB, "2026-01-01T00:00:00.000Z");

    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions?instrumentId=${instrumentA}&page=1`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(new Set(body.rows.map((r: { id: string }) => r.id))).toEqual(new Set([idA1, idA2]));
    expect(body.total).toBe(2);
    expect(new Set(body.years)).toEqual(new Set(["2024", "2025"]));
  });

  it("GET /networth/transactions?instrumentId= scopes rows/total/years across portfolios to that instrument", async () => {
    const t = await token("instrument-filter-networth-user");
    const portfolioA = await createPortfolio(t, "Instrument filter networth A");
    const portfolioB = await createPortfolio(t, "Instrument filter networth B");
    const idA = await createTx(t, portfolioA, instrumentA, "2022-01-01T00:00:00.000Z");
    const idB = await createTx(t, portfolioB, instrumentA, "2023-01-01T00:00:00.000Z");
    await createTx(t, portfolioA, instrumentB, "2026-01-01T00:00:00.000Z");

    const res = await app.inject({
      method: "GET",
      url: `/networth/transactions?instrumentId=${instrumentA}&page=1`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(new Set(body.rows.map((r: { id: string }) => r.id))).toEqual(new Set([idA, idB]));
    expect(body.total).toBe(2);
    expect(new Set(body.years)).toEqual(new Set(["2022", "2023"]));
  });

  it("composes instrumentId with the existing year filter", async () => {
    const t = await token("instrument-filter-compose-user");
    const portfolioId = await createPortfolio(t, "Instrument filter compose");
    const idMatch = await createTx(t, portfolioId, instrumentA, "2025-05-01T00:00:00.000Z");
    await createTx(t, portfolioId, instrumentA, "2024-05-01T00:00:00.000Z");
    await createTx(t, portfolioId, instrumentB, "2025-05-01T00:00:00.000Z");

    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions?instrumentId=${instrumentA}&year=2025&page=1`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rows.map((r: { id: string }) => r.id)).toEqual([idMatch]);
    expect(body.total).toBe(1);
  });
});
