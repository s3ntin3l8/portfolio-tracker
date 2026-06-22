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
    payload: { name, baseCurrency: "EUR", cashCounted },
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

describe("sparplan detection", () => {
  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    process.env.RATE_LIMIT_MAX = "10000";
    app = await buildApp({ authKey: kp.publicKey });
    overrideMarketData(
      new MarketDataService([new FixtureProvider({ VWCE: "120.00", EIMI: "30.00" })]),
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

  // ---------------------------------------------------------------------------
  // Per-portfolio route
  // ---------------------------------------------------------------------------

  it("GET /portfolios/:id/sparplan detects a tagged savings plan with step history", async () => {
    const t = await token("sparplanner");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });
    const pf = await createPortfolio(t, "Depot");

    const [vwce] = await app.db
      .insert(instruments)
      .values({ symbol: "VWCE", market: "XETRA", assetClass: "equity", currency: "EUR", name: "Vanguard FTSE All-World" })
      .returning();

    // 4× €100/mo savings_plan
    const months100 = ["2025-09-05", "2025-10-05", "2025-11-05", "2025-12-05"];
    for (const d of months100) {
      await postTx(t, pf, {
        type: "savings_plan",
        instrumentId: vwce.id,
        quantity: "0.8333",
        price: "120.00",
        currency: "EUR",
        executedAt: d,
      });
    }

    // 4× €150/mo savings_plan (step increase; last execution in June so it stays "active")
    const months150 = ["2026-01-05", "2026-02-05", "2026-03-05", "2026-06-05"];
    for (const d of months150) {
      await postTx(t, pf, {
        type: "savings_plan",
        instrumentId: vwce.id,
        quantity: "1.25",
        price: "120.00",
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
    expect(body.plans).toHaveLength(1);

    const plan = body.plans[0];
    expect(plan.source).toBe("tagged");
    expect(plan.cadenceMonths).toBe(1);
    expect(plan.executionCount).toBe(8);
    expect(plan.symbol).toBe("VWCE");
    expect(plan.name).toBe("Vanguard FTSE All-World");

    // Levels: two tiers (€100 then €150)
    expect(plan.levels).toHaveLength(2);
    expect(Number(plan.levels[0].amount)).toBeCloseTo(100, 0);
    expect(Number(plan.levels[1].amount)).toBeCloseTo(150, 0);
    expect(plan.levels[1].until).toBeNull();
    expect(Number(plan.currentAmount)).toBeCloseTo(150, 0);
    expect(plan.status).toBe("active");
  });

  it("GET /portfolios/:id/sparplan returns 404 for a portfolio owned by another user", async () => {
    const t = await token("sparplanner");
    const other = await token("other-user2");
    const pf = await createPortfolio(t, "Private");

    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${pf}/sparplan`,
      headers: auth(other),
    });
    expect(res.statusCode).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // Aggregate route
  // ---------------------------------------------------------------------------

  it("GET /networth/sparplan sums plans across two portfolios (no collapse)", async () => {
    const t = await token("aggplanner");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });

    const pfA = await createPortfolio(t, "Depot A");
    const pfB = await createPortfolio(t, "Depot B");

    const [eimiA] = await app.db
      .insert(instruments)
      .values({ symbol: "EIMI", market: "XETRA", assetClass: "equity", currency: "EUR", name: "iShares EM IMI" })
      .returning();

    // pfA: 5× €150/mo into EIMI
    const monthsA = ["2026-01-05", "2026-02-05", "2026-03-05", "2026-04-05", "2026-05-05"];
    for (const d of monthsA) {
      await postTx(t, pfA, {
        type: "savings_plan",
        instrumentId: eimiA.id,
        quantity: "5.0",
        price: "30.00",
        currency: "EUR",
        executedAt: d,
      });
    }

    // pfB: also 5× €150/mo into the same EIMI (different portfolio)
    for (const d of monthsA) {
      await postTx(t, pfB, {
        type: "savings_plan",
        instrumentId: eimiA.id,
        quantity: "5.0",
        price: "30.00",
        currency: "EUR",
        executedAt: d,
      });
    }

    const res = await app.inject({
      method: "GET",
      url: "/networth/sparplan",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    // Both portfolios' plans appear — not collapsed into one.
    expect(body.plans).toHaveLength(2);
    // Active monthly total = €150 + €150 = €300, not €150.
    expect(Number(body.activeMonthlyTotalDisplay)).toBeCloseTo(300, 0);
    expect(body.activePlanCount).toBe(2);
  });
});
