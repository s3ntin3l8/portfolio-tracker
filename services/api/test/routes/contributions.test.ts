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

async function createPortfolio(t: string, name: string, cashCounted = false) {
  const res = await app.inject({
    method: "POST",
    url: "/portfolios",
    headers: auth(t),
    payload: { name, baseCurrency: "idr", cashCounted },
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

describe("contribution analytics", () => {
  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    process.env.RATE_LIMIT_MAX = "10000";
    app = await buildApp({ authKey: kp.publicKey });
    overrideMarketData(new MarketDataService([new FixtureProvider({ BBCA: "9500" })]));
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    invalidateMarketData();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    delete process.env.RATE_LIMIT_MAX;
  });

  it("derives per-portfolio contributions (cash-outside counts the invested savings-plan buys)", async () => {
    const t = await token("saver");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) }); // upsert user
    const pf = await createPortfolio(t, "Child A"); // default cash-outside

    const [bbca] = await app.db
      .insert(instruments)
      .values({ symbol: "BBCA", market: "IDX", assetClass: "equity", currency: "IDR", name: "BCA" })
      .returning();

    // Two months, each funded by a deposit then invested via a savings plan. Cash-outside
    // counts the invested capital (the plan buys) and ignores the deposits — counting the
    // same money once, from the securities side.
    for (const month of ["2026-01", "2026-02"]) {
      await postTx(t, pf, {
        type: "deposit",
        price: "9500",
        currency: "IDR",
        executedAt: `${month}-05T00:00:00.000Z`,
      });
      await postTx(t, pf, {
        type: "savings_plan",
        instrumentId: bbca.id,
        quantity: "1",
        price: "9500",
        currency: "IDR",
        executedAt: `${month}-15T00:00:00.000Z`,
      });
    }

    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${pf}/contributions`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const c = res.json();
    expect(c.totalContributed).toBe("19000"); // 9500 + 9500, not 38000
    expect(c.netContributed).toBe("19000");
    expect(c.monthsActive).toBe(2);
    expect(c.monthlyAverage).toBe("9500");
    expect(c.series).toEqual([
      { month: "2026-01", contributed: "9500" },
      { month: "2026-02", contributed: "9500" },
    ]);
    // 2 BBCA priced at 9500 by the fixture (cash nets to 0) → value 19000.
    expect(c.currentValue).toBe("19000");
    expect(c.simpleGainPct).toBe(0);
    expect(typeof c.seedAnnualReturn).toBe("string");
  });

  it("aggregates contributions across boundaries (cash-outside buys + cash-inside deposit)", async () => {
    const t = await token("saver"); // same user as above (1 existing cash-outside portfolio)
    // A cash-inside savings account whose deposit IS the contribution.
    const pf2 = await createPortfolio(t, "Child B", true);
    await postTx(t, pf2, {
      type: "deposit",
      price: "5000",
      currency: "IDR",
      executedAt: "2026-03-05T00:00:00.000Z",
    });

    const res = await app.inject({
      method: "GET",
      url: "/networth/contributions",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const c = res.json();
    // 19000 from the cash-outside portfolio's buys + 5000 from the cash-inside deposit;
    // each portfolio is computed under its own boundary, then merged.
    expect(c.totalContributed).toBe("24000");
    expect(c.monthsActive).toBe(3); // Jan, Feb, Mar
    expect(c.monthlyAverage).toBe("8000"); // 24000 / 3
  });

  it("persists a portfolio birth year and surfaces it on contributions", async () => {
    const t = await token("parent");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });
    const pf = await createPortfolio(t, "Kid");

    // Set the birth year via PATCH.
    const patched = await app.inject({
      method: "PATCH",
      url: `/portfolios/${pf}`,
      headers: auth(t),
      payload: { birthYear: 2017 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().birthYear).toBe(2017);

    // It rides the list and the contributions payload.
    const list = await app.inject({ method: "GET", url: "/portfolios", headers: auth(t) });
    expect(list.json().find((p: { id: string }) => p.id === pf).birthYear).toBe(2017);

    const contrib = await app.inject({
      method: "GET",
      url: `/portfolios/${pf}/contributions`,
      headers: auth(t),
    });
    expect(contrib.json().birthYear).toBe(2017);

    // Clearing it with null works too.
    const cleared = await app.inject({
      method: "PATCH",
      url: `/portfolios/${pf}`,
      headers: auth(t),
      payload: { birthYear: null },
    });
    expect(cleared.json().birthYear).toBeNull();
  });

  it("classifies child portfolios and gates the birth year on the type", async () => {
    const t = await token("classifier");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });

    // Create a child portfolio with a birth year in one shot.
    const created = await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(t),
      payload: { name: "Kid", baseCurrency: "idr", portfolioType: "child", birthYear: 2017 },
    });
    expect(created.statusCode).toBe(201);
    const pf = created.json().id as string;
    expect(created.json().portfolioType).toBe("child");
    expect(created.json().birthYear).toBe(2017);

    // A POST without a type defaults to "standard".
    const standard = await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(t),
      payload: { name: "Mine", baseCurrency: "idr" },
    });
    expect(standard.json().portfolioType).toBe("standard");

    // The type rides the list and contributions payloads.
    const list = await app.inject({ method: "GET", url: "/portfolios", headers: auth(t) });
    expect(list.json().find((p: { id: string }) => p.id === pf).portfolioType).toBe("child");
    const contrib = await app.inject({
      method: "GET",
      url: `/portfolios/${pf}/contributions`,
      headers: auth(t),
    });
    expect(contrib.json().portfolioType).toBe("child");

    // Flipping back to "standard" clears the birth year so it can't leak into the forecast.
    const reverted = await app.inject({
      method: "PATCH",
      url: `/portfolios/${pf}`,
      headers: auth(t),
      payload: { portfolioType: "standard" },
    });
    expect(reverted.json().portfolioType).toBe("standard");
    expect(reverted.json().birthYear).toBeNull();
  });

  it("counts one-off buys only when cash is outside the boundary (round-trips cashCounted)", async () => {
    const t = await token("investonly");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });
    const [tlkm] = await app.db
      .insert(instruments)
      .values({ symbol: "TLKM", market: "IDX", assetClass: "equity", currency: "IDR", name: "Telkom" })
      .returning();

    // A cash-outside portfolio (the default) — the buys are the invested capital. The flag
    // must ride create + list.
    const created = await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(t),
      payload: { name: "Invest-only", baseCurrency: "idr", cashCounted: false },
    });
    expect(created.json().cashCounted).toBe(false);
    const outsidePf = created.json().id as string;
    const list = await app.inject({ method: "GET", url: "/portfolios", headers: auth(t) });
    expect(
      list.json().find((p: { id: string }) => p.id === outsidePf).cashCounted,
    ).toBe(false);

    // A cash-inside portfolio with the SAME buy-only data — buys are internal there.
    const insidePf = await createPortfolio(t, "Cash inside", true);

    for (const pf of [outsidePf, insidePf]) {
      for (const month of ["2026-01", "2026-02"]) {
        await postTx(t, pf, {
          type: "buy",
          instrumentId: tlkm.id,
          quantity: "1",
          price: "9500",
          currency: "IDR",
          executedAt: `${month}-15T00:00:00.000Z`,
        });
      }
    }

    const outside = await app.inject({
      method: "GET",
      url: `/portfolios/${outsidePf}/contributions`,
      headers: auth(t),
    });
    expect(outside.json().totalContributed).toBe("19000"); // both buys counted
    expect(outside.json().monthsActive).toBe(2);

    const inside = await app.inject({
      method: "GET",
      url: `/portfolios/${insidePf}/contributions`,
      headers: auth(t),
    });
    expect(inside.json().totalContributed).toBe("0"); // cash-inside ignores buys (no deposits)
  });

  it("merges per-portfolio boundaries in the aggregate (cash-inside deposit + cash-outside buy)", async () => {
    const t = await token("mixed");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });
    const [tlkm] = await app.db
      .insert(instruments)
      .values({ symbol: "TLKM2", market: "IDX", assetClass: "equity", currency: "IDR", name: "Telkom2" })
      .returning();

    // Cash-inside portfolio funded by a deposit; cash-outside portfolio funded by a one-off buy.
    const insidePf = await createPortfolio(t, "Inside", true);
    await postTx(t, insidePf, {
      type: "deposit",
      price: "5000",
      currency: "IDR",
      executedAt: "2026-01-05T00:00:00.000Z",
    });
    const buyPf = await createPortfolio(t, "Buys"); // cash-outside (default)
    await postTx(t, buyPf, {
      type: "buy",
      instrumentId: tlkm.id,
      quantity: "1",
      price: "3000",
      currency: "IDR",
      executedAt: "2026-02-15T00:00:00.000Z",
    });

    const agg = await app.inject({
      method: "GET",
      url: "/networth/contributions",
      headers: auth(t),
    });
    const c = agg.json();
    expect(c.totalContributed).toBe("8000"); // 5000 deposit + 3000 buy
    expect(c.monthsActive).toBe(2);
    expect(c.series).toEqual([
      { month: "2026-01", contributed: "5000" },
      { month: "2026-02", contributed: "3000" },
    ]);
  });

  it("404s a portfolio the user does not own; 401s without a token", async () => {
    const t = await token("saver");
    const stranger = await token("intruder");
    await app.inject({ method: "GET", url: "/me", headers: auth(stranger) });
    const pf = await createPortfolio(t, "Private");

    const forbidden = await app.inject({
      method: "GET",
      url: `/portfolios/${pf}/contributions`,
      headers: auth(stranger),
    });
    expect(forbidden.statusCode).toBe(404);

    const anon = await app.inject({ method: "GET", url: "/networth/contributions" });
    expect(anon.statusCode).toBe(401);
  });
});
