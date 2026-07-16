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

describe("trade log", () => {
  let pf: string;
  let tlkm: string;
  let bbca: string;

  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    process.env.RATE_LIMIT_MAX = "10000";
    app = await buildApp({ authKey: kp.publicKey });
    overrideMarketData(new MarketDataService([new FixtureProvider({ BBCA: "9500" })]));

    const t = await token("trader");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) }); // upsert user
    pf = await createPortfolio(t, "Trades");

    [tlkm] = (
      await app.db
        .insert(instruments)
        .values({
          symbol: "TLKM",
          market: "XETRA",
          assetClass: "equity",
          currency: "EUR",
          name: "Telkom",
        })
        .returning()
    ).map((i) => i.id);
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

    // A: closed round-trip (bought, fully sold) → realized 300.
    await postTx(t, pf, {
      type: "buy",
      instrumentId: tlkm,
      quantity: "10",
      price: "100",
      currency: "EUR",
      executedAt: "2021-01-01T00:00:00.000Z",
    });
    await postTx(t, pf, {
      type: "sell",
      instrumentId: tlkm,
      quantity: "10",
      price: "130",
      currency: "EUR",
      executedAt: "2021-06-01T00:00:00.000Z",
    });
    // B: open position with an in-window dividend (priced 9500 by the fixture).
    await postTx(t, pf, {
      type: "buy",
      instrumentId: bbca,
      quantity: "5",
      price: "9000",
      currency: "EUR",
      executedAt: "2021-02-01T00:00:00.000Z",
    });
    await postTx(t, pf, {
      type: "dividend",
      instrumentId: bbca,
      quantity: "0",
      price: "100",
      tax: "20",
      currency: "EUR",
      executedAt: "2021-07-01T00:00:00.000Z",
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

  it("returns one closed and one open trade with dividends folded in", async () => {
    const t = await token("trader");
    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${pf}/trades`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const log = res.json();
    expect(log.method).toBe("average");
    expect(log.trades).toHaveLength(2);

    const closed = log.trades.find((x: { status: string }) => x.status === "closed");
    expect(closed.instrument.symbol).toBe("TLKM");
    expect(closed.realizedPnL).toBe("300");
    expect(closed.exitDate).toBe("2021-06-01");

    const open = log.trades.find((x: { status: string }) => x.status === "open");
    expect(open.instrument.symbol).toBe("BBCA");
    expect(open.dividends).toBe("100");
    expect(open.unrealizedPnL).toBe("2500"); // 5×9500 − 45000
    expect(open.totalReturn).toBe("2600"); // 0 realized + 2500 unrealized + 100 dividend

    expect(log.totalRealized).toBe("300");
    expect(log.realizedByYear).toEqual([{ year: 2021, amount: "300" }]);
    expect(log.dividendsByYear).toEqual([{ year: 2021, amount: "100", tax: "20" }]);
    expect(log.winRate).toBe(1); // the one closed trade was profitable
  });

  it("honours ?method=fifo (same total realized on a fully-closed episode)", async () => {
    const t = await token("trader");
    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${pf}/trades?method=fifo`,
      headers: auth(t),
    });
    const log = res.json();
    expect(log.method).toBe("fifo");
    const closed = log.trades.find((x: { status: string }) => x.status === "closed");
    expect(closed.realizedPnL).toBe("300");
  });

  it("aggregates trades across portfolios at /networth/trades", async () => {
    const t = await token("trader");
    const res = await app.inject({
      method: "GET",
      url: "/networth/trades",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const log = res.json();
    expect(log.trades).toHaveLength(2);
    expect(log.totalRealized).toBe("300");
    expect(log.dividendsByYear).toEqual([{ year: 2021, amount: "100", tax: "20" }]);
  });

  it("404s a portfolio the user does not own; 401s without a token", async () => {
    const stranger = await token("intruder");
    await app.inject({ method: "GET", url: "/me", headers: auth(stranger) });
    const forbidden = await app.inject({
      method: "GET",
      url: `/portfolios/${pf}/trades`,
      headers: auth(stranger),
    });
    expect(forbidden.statusCode).toBe(404);

    const anon = await app.inject({ method: "GET", url: "/networth/trades" });
    expect(anon.statusCode).toBe(401);
  });
});
