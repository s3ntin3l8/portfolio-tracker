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
    expect(c.monthsActive).toBe(2); // only months with activity
    // monthsElapsed = elapsed months from first tx (2026-01) to now; monthlyAverage = 19000 / monthsElapsed
    expect(c.monthsElapsed).toBeGreaterThanOrEqual(2);
    expect(Number(c.monthlyAverage) * c.monthsElapsed).toBeCloseTo(19000, 2);
    expect(c.series).toEqual([
      { month: "2026-01", contributed: "9500" },
      { month: "2026-02", contributed: "9500" },
    ]);
    // 2 BBCA priced at 9500 by the fixture (cash nets to 0) → value 19000.
    expect(c.currentValue).toBe("19000");
    expect(c.simpleGainPct).toBe(0);
    // No income or realized gains, value == cost → total return is also flat (computed
    // for cash-outside, not null).
    expect(c.totalReturnPct).toBe(0);
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
    // monthsElapsed = elapsed months from 2026-01 to now (≥ 3); monthlyAverage = 24000 / monthsElapsed
    expect(c.monthsElapsed).toBeGreaterThanOrEqual(3);
    expect(Number(c.monthlyAverage) * c.monthsElapsed).toBeCloseTo(24000, 2);
  });

  // Create a holder and return its id.
  async function createHolder(
    t: string,
    name: string,
    type: "self" | "child" | "other",
    birthYear?: number,
  ) {
    const res = await app.inject({
      method: "POST",
      url: "/account-holders",
      headers: auth(t),
      payload: { name, type, birthYear: birthYear ?? null },
    });
    return res.json().id as string;
  }

  it("surfaces the linked holder's birth year on contributions", async () => {
    const t = await token("parent");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });
    const holderId = await createHolder(t, "Kid", "child", 2017);
    const pf = await createPortfolio(t, "Kid");

    // Link the holder via PATCH.
    const patched = await app.inject({
      method: "PATCH",
      url: `/portfolios/${pf}`,
      headers: auth(t),
      payload: { accountHolderId: holderId },
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

    // Unassigning the holder clears the derived birth year.
    const cleared = await app.inject({
      method: "PATCH",
      url: `/portfolios/${pf}`,
      headers: auth(t),
      payload: { accountHolderId: null },
    });
    expect(cleared.json().birthYear).toBeNull();
  });

  it("derives child classification from the linked holder", async () => {
    const t = await token("classifier");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });

    // A portfolio linked to a child holder reads as a child depot in one shot.
    const childHolder = await createHolder(t, "Kid", "child", 2017);
    const created = await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(t),
      payload: { name: "Kid", baseCurrency: "idr", accountHolderId: childHolder },
    });
    expect(created.statusCode).toBe(201);
    const pf = created.json().id as string;
    expect(created.json().portfolioType).toBe("child");
    expect(created.json().birthYear).toBe(2017);

    // A POST without a holder defaults to "standard".
    const standard = await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(t),
      payload: { name: "Mine", baseCurrency: "idr" },
    });
    expect(standard.json().portfolioType).toBe("standard");

    // The derived type rides the list and contributions payloads.
    const list = await app.inject({ method: "GET", url: "/portfolios", headers: auth(t) });
    expect(list.json().find((p: { id: string }) => p.id === pf).portfolioType).toBe("child");
    const contrib = await app.inject({
      method: "GET",
      url: `/portfolios/${pf}/contributions`,
      headers: auth(t),
    });
    expect(contrib.json().portfolioType).toBe("child");

    // Unassigning the holder reverts the portfolio to "standard" with no birth year.
    const reverted = await app.inject({
      method: "PATCH",
      url: `/portfolios/${pf}`,
      headers: auth(t),
      payload: { accountHolderId: null },
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

  it("total return adds realized gains + dividends over the unrealized headline (cash-outside)", async () => {
    const t = await token("totalreturn");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });
    // Price the held instrument above cost so there's an unrealized gain too.
    overrideMarketData(
      new MarketDataService([new FixtureProvider({ BBCA: "9500", DIVI: "120" })]),
    );
    const [divi] = await app.db
      .insert(instruments)
      .values({ symbol: "DIVI", market: "IDX", assetClass: "equity", currency: "IDR", name: "Dividend Co" })
      .returning();

    const pf = await createPortfolio(t, "Income"); // cash-outside (default)
    // Buy 10 @ 100 (cost 1000); sell 4 @ 150 (proceeds 600, cost-of-sold 400 → realized 200);
    // 80 cash dividend; 6 left @ fixture 120 → MV 720 (unrealized 120).
    await postTx(t, pf, {
      type: "buy",
      instrumentId: divi.id,
      quantity: "10",
      price: "100",
      currency: "IDR",
      executedAt: "2026-01-15T00:00:00.000Z",
    });
    await postTx(t, pf, {
      type: "sell",
      instrumentId: divi.id,
      quantity: "4",
      price: "150",
      currency: "IDR",
      executedAt: "2026-02-15T00:00:00.000Z",
    });
    await postTx(t, pf, {
      type: "dividend",
      instrumentId: divi.id,
      quantity: "0",
      price: "80",
      currency: "IDR",
      executedAt: "2026-03-15T00:00:00.000Z",
    });

    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${pf}/contributions`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const c = res.json();
    // Gross contributed = 1000; net = 1000 − 400 (cost-of-sold) = 600; value (securities) = 720.
    expect(c.totalContributed).toBe("1000");
    expect(c.netContributed).toBe("600");
    expect(c.currentValue).toBe("720");
    // Headline stays unrealized-only: (720 − 600) / 600 = 0.2.
    expect(c.simpleGainPct).toBeCloseTo(0.2, 10);
    // Total return adds realized (200) + dividend (80): (720 + 600 + 80 − 1000) / 1000 = 0.4.
    expect(c.totalReturnPct).toBeCloseTo(0.4, 10);
  });

  it("total return excludes cash interest (flow-derived, not totalIncome); null for cash-inside", async () => {
    const t = await token("interest");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });
    overrideMarketData(
      new MarketDataService([new FixtureProvider({ BBCA: "9500", INTR: "100" })]),
    );
    const [intr] = await app.db
      .insert(instruments)
      .values({ symbol: "INTR", market: "IDX", assetClass: "equity", currency: "IDR", name: "Interest Co" })
      .returning();

    // Cash-outside: buy 10 @ 100 (value stays 1000 at fixture 100) + a 50 interest payout.
    // Interest is outside the securities boundary → must NOT lift total return.
    const outside = await createPortfolio(t, "With interest"); // cash-outside
    await postTx(t, outside, {
      type: "buy",
      instrumentId: intr.id,
      quantity: "10",
      price: "100",
      currency: "IDR",
      executedAt: "2026-01-15T00:00:00.000Z",
    });
    await postTx(t, outside, {
      type: "interest",
      quantity: "0",
      price: "50",
      currency: "IDR",
      executedAt: "2026-02-15T00:00:00.000Z",
    });
    const oc = (
      await app.inject({
        method: "GET",
        url: `/portfolios/${outside}/contributions`,
        headers: auth(t),
      })
    ).json();
    expect(oc.totalContributed).toBe("1000");
    expect(oc.currentValue).toBe("1000");
    expect(oc.totalReturnPct).toBe(0); // interest excluded → flat, not +5%

    // Cash-inside portfolio: total return is suppressed (headline already IS total return).
    const inside = await createPortfolio(t, "Cash inside", true);
    await postTx(t, inside, {
      type: "deposit",
      price: "5000",
      currency: "IDR",
      executedAt: "2026-01-05T00:00:00.000Z",
    });
    const ic = (
      await app.inject({
        method: "GET",
        url: `/portfolios/${inside}/contributions`,
        headers: auth(t),
      })
    ).json();
    expect(ic.totalReturnPct).toBeNull();

    // The aggregate (mixed boundaries) computes a blended total return (a finite number).
    const agg = (
      await app.inject({ method: "GET", url: "/networth/contributions", headers: auth(t) })
    ).json();
    expect(typeof agg.totalReturnPct).toBe("number");
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
