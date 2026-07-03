/**
 * API integration tests for Phase B: Sparplan drift + contribution split.
 *
 * Verifies that after saving instrument-dimension targets for a portfolio,
 * GET /portfolios/:id/sparplan returns `drift` and `contributionSplit` fields
 * containing the per-instrument drift and recommended monthly contribution split.
 */
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

async function createPortfolio(t: string, name = "Depot", baseCurrency = "EUR") {
  const res = await app.inject({
    method: "POST",
    url: "/portfolios",
    headers: auth(t),
    payload: { name, baseCurrency, cashCounted: false },
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

/**
 * The 1st of each of the last `count` calendar months, oldest→newest, anchored to today.
 * A savings plan is "active" only while its last execution is within 1.5× the cadence,
 * so hardcoded execution dates silently expire once ~45 days pass — which is what turned
 * these tests into a recurring, calendar-dependent CI failure. Relative dates keep the
 * most recent execution inside the active window whenever the suite runs.
 */
function recentMonths(count: number): string[] {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(y, m - (count - 1 - i), 1)).toISOString().slice(0, 10),
  );
}

describe("sparplan rebalancing (Phase B)", () => {
  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    process.env.RATE_LIMIT_MAX = "10000";
    app = await buildApp({ authKey: kp.publicKey });
    // Fixture prices for the ETFs used in tests (unique symbols to avoid collision with sparplan.test.ts).
    overrideMarketData(
      new MarketDataService([new FixtureProvider({
        "RB-VWCE": "100.00",
        "RB-VWCE2": "100.00",
        "RB-VWCE3": "100.00",
        "RB-EIMI2": "100.00",
        "RB-EIMI3": "100.00",
        // Phase D symbols.
        "RB-PHD-VWCE1": "100.00",
        "RB-PHD-VWCE2": "100.00",
        "RB-PHD-EIMI2": "100.00",
      })]),
    );
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    invalidateMarketData();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    delete process.env.RATE_LIMIT_MAX;
  });

  it("GET /portfolios/:id/sparplan returns no drift when no targets are saved", async () => {
    const t = await token("rb-notar-1");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });
    const pf = await createPortfolio(t, "Depot A");

    const [vwce] = await app.db
      .insert(instruments)
      .values({ symbol: "RB-VWCE", market: "XETRA", assetClass: "equity", currency: "EUR", name: "Rebal FTSE All-World" })
      .returning();

    const months = recentMonths(5);
    for (const d of months) {
      await postTx(t, pf, {
        type: "savings_plan",
        instrumentId: vwce.id,
        quantity: "1.0",
        price: "100.00",
        currency: "EUR",
        executedAt: d,
      });
    }

    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${pf}/sparplan`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.drift).toBeUndefined();
    expect(body.contributionSplit).toBeUndefined();
  });

  it("GET /portfolios/:id/sparplan returns drift + contributionSplit when instrument targets are set", async () => {
    const t = await token("rb-withtargets-1");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });
    const pf = await createPortfolio(t, "Depot B");

    const [vwce] = await app.db
      .insert(instruments)
      .values({ symbol: "RB-VWCE2", market: "XETRA", assetClass: "equity", currency: "EUR", name: "Rebal FTSE All-World" })
      .returning();
    const [eimi] = await app.db
      .insert(instruments)
      .values({ symbol: "RB-EIMI2", market: "XETRA", assetClass: "equity", currency: "EUR", name: "Rebal EM IMI" })
      .returning();

    // Post 5× €70/mo into VWCE (7 units × €100) → ~€700 market value
    const months = recentMonths(5);
    for (const d of months) {
      await postTx(t, pf, {
        type: "savings_plan",
        instrumentId: vwce.id,
        quantity: "0.7",
        price: "100.00",
        currency: "EUR",
        executedAt: d,
      });
    }

    // Post 5× €30/mo into EIMI (3 units × €100) → ~€300 market value
    for (const d of months) {
      await postTx(t, pf, {
        type: "savings_plan",
        instrumentId: eimi.id,
        quantity: "0.3",
        price: "100.00",
        currency: "EUR",
        executedAt: d,
      });
    }

    // Set instrument targets: 70% VWCE / 30% EIMI.
    const putRes = await app.inject({
      method: "PUT",
      url: `/portfolios/${pf}/targets`,
      headers: auth(t),
      payload: {
        dimension: "instrument",
        targets: [
          { key: vwce.id, targetPct: 70 },
          { key: eimi.id, targetPct: 30 },
        ],
      },
    });
    expect(putRes.statusCode).toBe(200);

    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${pf}/sparplan`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.plans).toHaveLength(2);

    // Drift should be present.
    expect(body.drift).toBeDefined();
    expect(Array.isArray(body.drift)).toBe(true);
    expect(body.drift).toHaveLength(2);

    // The holdings are 70/30 and targets are 70/30, so both should be on_target or very close.
    const vwceDrift = body.drift.find((d: { key: string }) => d.key === vwce.id);
    const eimiDrift = body.drift.find((d: { key: string }) => d.key === eimi.id);
    expect(vwceDrift).toBeDefined();
    expect(eimiDrift).toBeDefined();
    // Both drift rows should have targetPct matching what we set.
    expect(vwceDrift.targetPct).toBe(70);
    expect(eimiDrift.targetPct).toBe(30);
    // Status should be on_target since actual matches target.
    expect(vwceDrift.status).toBe("on_target");
    expect(eimiDrift.status).toBe("on_target");

    // contributionSplit should be present.
    expect(body.contributionSplit).toBeDefined();
    expect(Array.isArray(body.contributionSplit)).toBe(true);
    expect(body.contributionSplit).toHaveLength(2);

    // All amounts together should sum to ≈activeMonthlyTotalDisplay.
    const totalSplit = body.contributionSplit.reduce(
      (acc: number, s: { amount: string }) => acc + Number(s.amount),
      0,
    );
    expect(Math.abs(totalSplit - Number(body.activeMonthlyTotalDisplay))).toBeLessThan(1);
  });

  it("GET /portfolios/:id/sparplan shows under-target drift when holding is imbalanced", async () => {
    const t = await token("rb-imbalanced-1");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });
    const pf = await createPortfolio(t, "Imbalanced Depot");

    const [vwce] = await app.db
      .insert(instruments)
      .values({ symbol: "RB-VWCE3", market: "XETRA", assetClass: "equity", currency: "EUR", name: "Rebal FTSE All-World" })
      .returning();
    const [eimi] = await app.db
      .insert(instruments)
      .values({ symbol: "RB-EIMI3", market: "XETRA", assetClass: "equity", currency: "EUR", name: "Rebal EM IMI" })
      .returning();

    // VWCE: 9 × €100 = €900 (90% of total)
    const months = recentMonths(5);
    for (const d of months) {
      await postTx(t, pf, {
        type: "savings_plan",
        instrumentId: vwce.id,
        quantity: "9.0",
        price: "100.00",
        currency: "EUR",
        executedAt: d,
      });
    }

    // EIMI: 1 × €100 = €100 (10% of total)
    for (const d of months) {
      await postTx(t, pf, {
        type: "savings_plan",
        instrumentId: eimi.id,
        quantity: "1.0",
        price: "100.00",
        currency: "EUR",
        executedAt: d,
      });
    }

    // Target: 70% VWCE / 30% EIMI — VWCE is over (90 vs 70), EIMI is under (10 vs 30).
    await app.inject({
      method: "PUT",
      url: `/portfolios/${pf}/targets`,
      headers: auth(t),
      payload: {
        dimension: "instrument",
        targets: [
          { key: vwce.id, targetPct: 70 },
          { key: eimi.id, targetPct: 30 },
        ],
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${pf}/sparplan`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.drift).toBeDefined();

    const vwceDrift = body.drift.find((d: { key: string }) => d.key === vwce.id);
    const eimiDrift = body.drift.find((d: { key: string }) => d.key === eimi.id);
    // VWCE is 90% actual vs 70% target → over
    expect(vwceDrift.status).toBe("over");
    // EIMI is 10% actual vs 30% target → under
    expect(eimiDrift.status).toBe("under");

    // contributionSplit: EIMI is under target, so it gets the full monthly amount.
    expect(body.contributionSplit).toBeDefined();
    const eimiSplit = body.contributionSplit.find((s: { key: string }) => s.key === eimi.id);
    expect(eimiSplit).toBeDefined();
    // EIMI is under, so it should receive a significant portion of the monthly contribution.
    expect(Number(eimiSplit.amount)).toBeGreaterThan(0);
  });

  it("drift is not returned for a portfolio owned by another user", async () => {
    const t1 = await token("rb-scope-1a");
    const t2 = await token("rb-scope-1b");
    await app.inject({ method: "GET", url: "/me", headers: auth(t1) });

    const pf = await createPortfolio(t1, "Scoped");
    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${pf}/sparplan`,
      headers: auth(t2),
    });
    expect(res.statusCode).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // Phase D: ?includeSales=true
  // ---------------------------------------------------------------------------

  it("GET /portfolios/:id/sparplan?includeSales=true returns taxUnavailable:true when no tax profile", async () => {
    const t = await token("rb-phd-notax-1");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });
    const pf = await createPortfolio(t, "PhaseD No Tax");

    const [vwce] = await app.db
      .insert(instruments)
      .values({ symbol: "RB-PHD-VWCE1", market: "XETRA", assetClass: "etf", currency: "EUR", name: "Rebal FTSE All-World PD1" })
      .returning();

    // Add savings plan transactions and targets.
    const months = recentMonths(3);
    for (const d of months) {
      await app.inject({
        method: "POST",
        url: `/portfolios/${pf}/transactions`,
        headers: auth(t),
        payload: { type: "savings_plan", instrumentId: vwce.id, quantity: "1.0", price: "100.00", currency: "EUR", executedAt: d },
      });
    }

    await app.inject({
      method: "PUT",
      url: `/portfolios/${pf}/targets`,
      headers: auth(t),
      payload: { dimension: "instrument", targets: [{ key: vwce.id, targetPct: 100 }] },
    });

    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${pf}/sparplan?includeSales=true`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.taxUnavailable).toBe(true);
    expect(body.tradeActions).toBeUndefined();
    // drift + contributionSplit still present even when taxUnavailable.
    expect(body.drift).toBeDefined();
    expect(body.contributionSplit).toBeDefined();
  });

  it("GET /portfolios/:id/sparplan?includeSales=true returns tradeActions when tax profile is set and positions are imbalanced", async () => {
    const t = await token("rb-phd-withtax-1");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });

    // Create holder with tax allowance.
    const holderRes = await app.inject({
      method: "POST",
      url: "/account-holders",
      headers: auth(t),
      payload: { name: "DE Holder PD", type: "self", taxAllowanceAnnual: "1000", capitalGainsTaxRate: "0.25" },
    });
    const holderId = holderRes.json().id as string;

    const pf = await createPortfolio(t, "PhaseD With Tax");
    // Link holder to portfolio and set per-depot FSA allocation.
    await app.inject({
      method: "PATCH",
      url: `/portfolios/${pf}`,
      headers: auth(t),
      payload: { accountHolderId: holderId, taxAllowanceAnnual: "1000" },
    });

    // Insert two instruments with unique symbols for this test.
    const [vwce] = await app.db
      .insert(instruments)
      .values({ symbol: "RB-PHD-VWCE2", market: "XETRA", assetClass: "etf", currency: "EUR", name: "Rebal FTSE All-World PD2" })
      .returning();
    const [eimi] = await app.db
      .insert(instruments)
      .values({ symbol: "RB-PHD-EIMI2", market: "XETRA", assetClass: "etf", currency: "EUR", name: "Rebal EM IMI PD2" })
      .returning();

    // VWCE: 9 units at €100 = €900 (90% of targeted total); target 70% → overweight.
    // EIMI: 1 unit at €100 = €100 (10% of targeted total); target 30% → underweight.
    // Use a buy (not savings_plan) at a lower price to create unrealized gain for harvest.
    const months = ["2025-01-05", "2025-02-05"];
    for (const d of months) {
      await app.inject({
        method: "POST",
        url: `/portfolios/${pf}/transactions`,
        headers: auth(t),
        payload: { type: "buy", instrumentId: vwce.id, quantity: "4.5", price: "80.00", currency: "EUR", executedAt: d },
      });
    }
    for (const d of months) {
      await app.inject({
        method: "POST",
        url: `/portfolios/${pf}/transactions`,
        headers: auth(t),
        payload: { type: "buy", instrumentId: eimi.id, quantity: "0.5", price: "80.00", currency: "EUR", executedAt: d },
      });
    }

    // Set targets: 70% VWCE / 30% EIMI.
    await app.inject({
      method: "PUT",
      url: `/portfolios/${pf}/targets`,
      headers: auth(t),
      payload: {
        dimension: "instrument",
        targets: [
          { key: vwce.id, targetPct: 70 },
          { key: eimi.id, targetPct: 30 },
        ],
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${pf}/sparplan?includeSales=true`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // No taxUnavailable flag — tax profile is configured.
    expect(body.taxUnavailable).toBeUndefined();

    // tradeActions should be an array (sells + buys).
    expect(body.tradeActions).toBeDefined();
    expect(Array.isArray(body.tradeActions)).toBe(true);

    // VWCE is over-weight → sell action expected; EIMI is under-weight → buy action expected.
    const buys = body.tradeActions.filter((a: { side: string }) => a.side === "buy");
    expect(buys.length).toBeGreaterThan(0);

    // Verify the sell cap is applied.
    // Setup: VWCE 9 units @ cost €80 = €720 total cost, market price €100 → value €900, unrealized gain €180.
    // Targeted total: €900 + €100 = €1000. Uncapped sell = |70%×1000 − 900| = 200.
    // ETF tfRate = 30%, multiplier = 0.70. harvestableGross = min(180, remaining/0.70) ≈ 180.
    // So sell is capped from 200 → 180.
    const sell = body.tradeActions.find((a: { side: string }) => a.side === "sell");
    expect(sell).toBeDefined();
    // The capped value (≈180) must be strictly less than the uncapped value (200).
    expect(Number(sell.deltaValue)).toBeLessThan(200);
    // And approximately equal to the harvestable gross (€180).
    expect(Number(sell.deltaValue)).toBeCloseTo(180, 0);

    // Allowance fields should be present.
    expect(body.allowanceUsed).toBeDefined();
    expect(body.remainingAllowance).toBeDefined();
    // allowanceUsed should be > 0 (the sell realizes some adjusted gain).
    expect(Number(body.allowanceUsed)).toBeGreaterThan(0);

    // drift and contributionSplit still present.
    expect(body.drift).toBeDefined();
    expect(body.contributionSplit).toBeDefined();
  });
});
