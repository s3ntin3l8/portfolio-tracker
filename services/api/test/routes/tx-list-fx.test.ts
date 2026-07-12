import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT, exportJWK } from "jose";
import { fxRates, instruments } from "@portfolio/db";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

// Covers the `?convertTo=` per-row FX conversion added to
// GET /portfolios/:portfolioId/transactions for issue #465: the "scope currency"
// rule needs every row (regardless of its own currency) to carry a `displayRate`
// so client-side aggregators (Activity banners) stop dropping non-dominant-currency
// transactions instead of silently excluding them.

const ISSUER = "https://auth.test/application/o/portfolio/";
const AUDIENCE = "portfolio-tracker";

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let privateKey: CryptoKey;
let eurInstrumentId: string;

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

describe("GET /portfolios/:portfolioId/transactions ?convertTo=", () => {
  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    await exportJWK(kp.publicKey);
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    process.env.RATE_LIMIT_MAX = "10000";
    app = await buildApp({ authKey: kp.publicKey });
    const [ins] = await app.db
      .insert(instruments)
      .values({ symbol: "IWDA", market: "XETRA", assetClass: "equity", currency: "EUR", name: "iShares World" })
      .returning();
    eurInstrumentId = ins.id;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    delete process.env.RATE_LIMIT_MAX;
  });

  async function setup() {
    const t = await token("fx-row-user");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });
    const created = await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(t),
      payload: { name: "Mixed-currency book", baseCurrency: "EUR" },
    });
    const portfolioId = created.json().id as string;
    return { t, portfolioId };
  }

  async function addBuy(
    t: string,
    portfolioId: string,
    currency: string,
    executedAt: string,
  ) {
    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: {
        type: "buy",
        instrumentId: eurInstrumentId,
        quantity: "1",
        price: "100",
        currency,
        executedAt,
      },
    });
    return res.json().id as string;
  }

  it("returns a per-row displayRate using each transaction's own trade-date rate", async () => {
    const { t, portfolioId } = await setup();

    // Two USD buys on different dates, priced against EUR at different rates.
    await addBuy(t, portfolioId, "USD", "2026-03-03T00:00:00.000Z");
    await addBuy(t, portfolioId, "USD", "2026-03-04T00:00:00.000Z");
    // A same-currency (EUR) row.
    await addBuy(t, portfolioId, "EUR", "2026-03-03T00:00:00.000Z");
    // A currency with no seeded rate at all.
    await addBuy(t, portfolioId, "SGD", "2026-03-03T00:00:00.000Z");

    await app.db.insert(fxRates).values([
      { base: "USD", quote: "EUR", rate: "0.9", date: "2026-03-03" },
      { base: "USD", quote: "EUR", rate: "0.92", date: "2026-03-04" },
    ]);

    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions?convertTo=EUR`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as {
      currency: string;
      executedAt: string;
      displayCurrency: string;
      displayRate: string;
    }[];
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r.displayCurrency).toBe("EUR");

    const byDateCcy = (ccy: string, date: string) =>
      rows.find((r) => r.currency === ccy && r.executedAt.startsWith(date))!;

    expect(byDateCcy("USD", "2026-03-03").displayRate).toBe("0.9");
    expect(byDateCcy("USD", "2026-03-04").displayRate).toBe("0.92");
    // Same-currency row: identity rate.
    expect(byDateCcy("EUR", "2026-03-03").displayRate).toBe("1");
    // Unknown pair: falls back to unconverted (1) rather than dropping the row.
    expect(byDateCcy("SGD", "2026-03-03").displayRate).toBe("1");
  });

  it("omits displayRate/displayCurrency when convertTo is not requested", async () => {
    const { t, portfolioId } = await setup();
    await addBuy(t, portfolioId, "EUR", "2026-03-03T00:00:00.000Z");

    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
    });
    const rows = res.json() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("displayRate");
    expect(rows[0]).not.toHaveProperty("displayCurrency");
  });
});
