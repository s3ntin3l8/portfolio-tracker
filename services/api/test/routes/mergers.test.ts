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

async function makeInstrument(symbol: string, currency = "EUR") {
  const [i] = await app.db
    .insert(instruments)
    .values({ symbol, market: "XETRA", assetClass: "etf", currency, name: symbol })
    .returning();
  return i.id;
}

async function buy(t: string, pf: string, instrumentId: string, quantity: string, price: string) {
  const res = await app.inject({
    method: "POST",
    url: `/portfolios/${pf}/transactions`,
    headers: auth(t),
    payload: { type: "buy", instrumentId, quantity, price, currency: "EUR", executedAt: "2024-01-01T00:00:00.000Z" },
  });
  expect(res.statusCode).toBe(201);
}

async function holdings(t: string, pf: string) {
  const res = await app.inject({ method: "GET", url: `/portfolios/${pf}/holdings`, headers: auth(t) });
  return res.json() as { instrumentId: string; quantity: string; costBasis: string; avgCost: string; realizedPnL: string }[];
}

describe("POST /portfolios/:id/mergers", () => {
  let t: string;
  let oldI: string;
  let newI: string;

  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    process.env.RATE_LIMIT_MAX = "10000";
    app = await buildApp({ authKey: kp.publicKey });
    overrideMarketData(new MarketDataService([new FixtureProvider({ NEWF: "300" })]));
    t = await token("merger-user");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });
    oldI = await makeInstrument("OLDF");
    newI = await makeInstrument("NEWF");
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    invalidateMarketData();
  });

  it("records a taxable merger as a sell+buy pair, stepping basis up to market", async () => {
    const pf = await createPortfolio(t, "Taxable");
    await buy(t, pf, oldI, "10", "100"); // basis 1000

    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${pf}/mergers`,
      headers: auth(t),
      payload: {
        fromInstrumentId: oldI,
        toInstrumentId: newI,
        outQty: "10",
        inQty: "5",
        executedAt: "2024-02-01T00:00:00.000Z",
        taxable: true,
        marketValue: "1200",
      },
    });
    expect(res.statusCode).toBe(201);
    const legs = res.json() as { type: string; kind: string; instrumentId: string }[];
    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.kind === "merger")).toBe(true);
    expect(legs.find((l) => l.instrumentId === oldI)?.type).toBe("sell");
    expect(legs.find((l) => l.instrumentId === newI)?.type).toBe("buy");

    const hs = await holdings(t, pf);
    const oldH = hs.find((h) => h.instrumentId === oldI)!;
    const newH = hs.find((h) => h.instrumentId === newI)!;
    expect(oldH.quantity).toBe("0");
    expect(oldH.realizedPnL).toBe("200"); // sold @ 1200 vs basis 1000
    expect(newH.quantity).toBe("5");
    expect(newH.costBasis).toBe("1200"); // stepped up to market
    expect(newH.avgCost).toBe("240");
  });

  it("records a tax-neutral merger carrying the old cost basis, no realized gain", async () => {
    const pf = await createPortfolio(t, "Neutral");
    await buy(t, pf, oldI, "10", "100"); // basis 1000

    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${pf}/mergers`,
      headers: auth(t),
      payload: {
        fromInstrumentId: oldI,
        toInstrumentId: newI,
        outQty: "10",
        inQty: "5",
        executedAt: "2024-02-01T00:00:00.000Z",
      },
    });
    expect(res.statusCode).toBe(201);

    const hs = await holdings(t, pf);
    const oldH = hs.find((h) => h.instrumentId === oldI)!;
    const newH = hs.find((h) => h.instrumentId === newI)!;
    expect(oldH.quantity).toBe("0");
    expect(oldH.realizedPnL).toBe("0"); // sold at avg cost → no gain
    expect(newH.costBasis).toBe("1000"); // basis carried
    expect(newH.avgCost).toBe("200");
  });

  it("rejects a taxable merger without a market value", async () => {
    const pf = await createPortfolio(t, "BadTaxable");
    await buy(t, pf, oldI, "10", "100");
    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${pf}/mergers`,
      headers: auth(t),
      payload: { fromInstrumentId: oldI, toInstrumentId: newI, outQty: "10", inQty: "5", executedAt: "2024-02-01T00:00:00.000Z", taxable: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a merger when the old instrument isn't held", async () => {
    const pf = await createPortfolio(t, "NoPosition");
    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${pf}/mergers`,
      headers: auth(t),
      payload: { fromInstrumentId: oldI, toInstrumentId: newI, outQty: "10", inQty: "5", executedAt: "2024-02-01T00:00:00.000Z" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("no_position_to_merge");
  });

  it("flows through the trade log (old episode closes with the gain) and stays contribution-neutral", async () => {
    const pf = await createPortfolio(t, "Integration");
    await buy(t, pf, oldI, "10", "100"); // 1000 of external capital into the old fund

    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${pf}/mergers`,
      headers: auth(t),
      payload: {
        fromInstrumentId: oldI,
        toInstrumentId: newI,
        outQty: "10",
        inQty: "5",
        executedAt: "2024-02-01T00:00:00.000Z",
        taxable: true,
        marketValue: "1200",
      },
    });
    expect(res.statusCode).toBe(201);

    // Trade log: the old instrument's episode is closed with the realized gain; the new
    // instrument opens a fresh episode.
    const trades = (
      await app.inject({ method: "GET", url: `/portfolios/${pf}/trades`, headers: auth(t) })
    ).json() as { trades: { instrumentId: string; status: string; realizedPnL: string }[] };
    const oldTrade = trades.trades.find((tr) => tr.instrumentId === oldI)!;
    const newTrade = trades.trades.find((tr) => tr.instrumentId === newI)!;
    expect(oldTrade.status).toBe("closed");
    expect(Number(oldTrade.realizedPnL)).toBe(200);
    expect(newTrade.status).toBe("open");

    // Contributions (cash-outside by default): only the original 1000 counts — the merger
    // legs cancel out, so no phantom inflow/outflow.
    const contrib = (
      await app.inject({ method: "GET", url: `/portfolios/${pf}/contributions`, headers: auth(t) })
    ).json() as { netContributed: string };
    expect(Number(contrib.netContributed)).toBe(1000);
  });

  it("returns 409 when the same merger is recorded twice", async () => {
    const pf = await createPortfolio(t, "Duplicate");
    await buy(t, pf, oldI, "10", "100");
    const payload = {
      fromInstrumentId: oldI,
      toInstrumentId: newI,
      outQty: "10",
      inQty: "5",
      executedAt: "2024-02-01T00:00:00.000Z",
    };
    const first = await app.inject({ method: "POST", url: `/portfolios/${pf}/mergers`, headers: auth(t), payload });
    expect(first.statusCode).toBe(201);
    // Re-establish a position so the retry passes the no-position guard and actually
    // reaches the insert, where the deterministic externalIds collide on the dedup index.
    await buy(t, pf, oldI, "10", "100");
    const second = await app.inject({ method: "POST", url: `/portfolios/${pf}/mergers`, headers: auth(t), payload });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("merger_already_recorded");
  });

  it("rejects a cross-currency merger", async () => {
    const usdI = await makeInstrument("USDF", "USD");
    const pf = await createPortfolio(t, "FX");
    await buy(t, pf, oldI, "10", "100");
    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${pf}/mergers`,
      headers: auth(t),
      payload: { fromInstrumentId: oldI, toInstrumentId: usdI, outQty: "10", inQty: "5", executedAt: "2024-02-01T00:00:00.000Z" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("currency_mismatch");
  });
});
