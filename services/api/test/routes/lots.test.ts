import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { instruments } from "@portfolio/db";
import { FixtureProvider, MarketDataService } from "@portfolio/market-data";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { overrideMarketData, invalidateMarketData } from "../../src/services/market-data.js";

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

async function createPortfolio(t: string, name: string) {
  const res = await app.inject({
    method: "POST",
    url: "/portfolios",
    headers: auth(t),
    payload: { name, baseCurrency: "EUR" },
  });
  return res.json().id as string;
}

async function postTx(t: string, portfolioId: string, payload: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    url: `/portfolios/${portfolioId}/transactions`,
    headers: auth(t),
    payload,
  });
  expect(res.statusCode).toBe(201);
}

describe("per-lot FIFO cost-basis lots on the summary endpoint", () => {
  let pf: string;
  let bbca: string;

  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    process.env.RATE_LIMIT_MAX = "10000";
    app = await buildApp({ authKey: kp.publicKey });
    overrideMarketData(new MarketDataService([new FixtureProvider({ BBCA: "9500" })]));

    const t = await token("lotholder");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) }); // upsert user
    pf = await createPortfolio(t, "Lots");

    [bbca] = (
      await app.db
        .insert(instruments)
        .values({
          symbol: "BBCA",
          market: "XETRA",
          assetClass: "equity",
          currency: "EUR",
          name: "BCA",
        })
        .returning()
    ).map((i) => i.id);

    // Two buys create two lots, then a partial sell consumes the oldest lot first.
    await postTx(t, pf, {
      type: "buy",
      instrumentId: bbca,
      quantity: "10",
      price: "9000",
      currency: "EUR",
      executedAt: "2021-01-01T00:00:00.000Z",
    });
    await postTx(t, pf, {
      type: "buy",
      instrumentId: bbca,
      quantity: "5",
      price: "9200",
      currency: "EUR",
      executedAt: "2021-03-01T00:00:00.000Z",
    });
    await postTx(t, pf, {
      type: "sell",
      instrumentId: bbca,
      quantity: "6",
      price: "9500",
      currency: "EUR",
      executedAt: "2021-06-01T00:00:00.000Z",
    });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    invalidateMarketData();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    delete process.env.RATE_LIMIT_MAX;
  });

  it("attaches FIFO-remaining open lots to the holding", async () => {
    const t = await token("lotholder");
    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${pf}/summary`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const summary = res.json();
    const holding = summary.holdings.find((h: { instrumentId: string }) => h.instrumentId === bbca);
    expect(holding).toBeTruthy();
    expect(holding.lots).toHaveLength(2);
    // First lot had 10 @ 9000; 6 consumed by the sell → 4 remain at the same unit cost.
    expect(holding.lots[0]).toEqual({
      acqDate: "2021-01-01",
      qty: "4",
      unitCost: "9000",
      cost: "36000",
    });
    // Second lot untouched.
    expect(holding.lots[1]).toEqual({
      acqDate: "2021-03-01",
      qty: "5",
      unitCost: "9200",
      cost: "46000",
    });
  });

  it("404s a portfolio the user does not own; 401s without a token", async () => {
    const stranger = await token("intruder");
    await app.inject({ method: "GET", url: "/me", headers: auth(stranger) });
    const forbidden = await app.inject({
      method: "GET",
      url: `/portfolios/${pf}/summary`,
      headers: auth(stranger),
    });
    expect(forbidden.statusCode).toBe(404);

    const anon = await app.inject({ method: "GET", url: `/portfolios/${pf}/summary` });
    expect(anon.statusCode).toBe(401);
  });
});
