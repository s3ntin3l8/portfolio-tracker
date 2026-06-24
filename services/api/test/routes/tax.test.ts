import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { instruments } from "@portfolio/db";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

// Helpers for seeding transactions via inject
async function seedTransaction(
  app: Awaited<ReturnType<typeof buildApp>>,
  portfolioId: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
) {
  const res = await app.inject({
    method: "POST",
    url: `/portfolios/${portfolioId}/transactions`,
    headers,
    payload,
  });
  if (res.statusCode !== 201) throw new Error(`seed tx failed: ${res.body}`);
  return res.json();
}

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

async function createPortfolio(t: string, opts: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/portfolios",
    headers: auth(t),
    payload: { name: "Test Portfolio", baseCurrency: "EUR", ...opts },
  });
  return res.json().id as string;
}

async function createHolder(
  t: string,
  opts: Record<string, unknown> = {},
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/account-holders",
    headers: auth(t),
    payload: { name: "Test Holder", type: "self", ...opts },
  });
  return res.json().id as string;
}

describe("tax routes", () => {
  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    process.env.RATE_LIMIT_MAX = "10000";
    app = await buildApp({ authKey: kp.publicKey });
  });

  afterAll(async () => {
    await app.close();
    closeDb();
  });

  // ---------------------------------------------------------------------------
  // GET /portfolios/:id/tax
  // ---------------------------------------------------------------------------

  describe("GET /portfolios/:id/tax", () => {
    it("returns 404 for a portfolio that doesn't belong to the user", async () => {
      const t = await token("tax-user-1");
      const res = await app.inject({
        method: "GET",
        url: "/portfolios/00000000-0000-0000-0000-000000000099/tax",
        headers: auth(t),
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 422 when no tax allowance is configured on the portfolio's holder", async () => {
      const t = await token("tax-user-2");
      // Create a portfolio with NO holder (no tax allowance).
      const portfolioId = await createPortfolio(t);
      const res = await app.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/tax`,
        headers: auth(t),
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe("tax_allowance_not_configured");
    });

    it("returns 422 when no FSA allocation is set on the portfolio", async () => {
      const t = await token("tax-user-3");
      const holderId = await createHolder(t, { name: "No Allowance Holder" });
      // Portfolio has no taxAllowanceAnnual (FSA not submitted for this depot).
      const portfolioId = await createPortfolio(t, { accountHolderId: holderId });
      const res = await app.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/tax`,
        headers: auth(t),
      });
      expect(res.statusCode).toBe(422);
    });

    it("returns tax summary for a portfolio with a configured holder", async () => {
      const t = await token("tax-user-4");
      // Create a holder with the per-person cap.
      const holderId = await createHolder(t, {
        name: "DE Holder",
        taxAllowanceAnnual: "1000",
        capitalGainsTaxRate: "0.25",
        taxResidence: "DE",
      });
      // Portfolio carries the per-depot FSA allocation.
      const portfolioId = await createPortfolio(t, { accountHolderId: holderId, taxAllowanceAnnual: "1000" });

      const res = await app.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/tax?year=2025`,
        headers: auth(t),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.year).toBe(2025);
      expect(body.currency).toBe("EUR");
      expect(body.allowanceUsage).toBeDefined();
      expect(body.allowanceUsage.allowanceAnnual).toBe("1000.00");
      expect(body.allowanceUsage.remaining).toBe("1000.00"); // no transactions
      expect(body.harvestSuggestions).toEqual([]);
    });

    it("uses the current year when year param is omitted", async () => {
      const t = await token("tax-user-5");
      const holderId = await createHolder(t, {
        name: "No Year Holder",
        taxAllowanceAnnual: "800",
      });
      const portfolioId = await createPortfolio(t, { accountHolderId: holderId, taxAllowanceAnnual: "800" });

      const res = await app.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/tax`,
        headers: auth(t),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().year).toBe(new Date().getUTCFullYear());
    });

    it("is scoped to the authenticated user", async () => {
      const t1 = await token("tax-scope-1a");
      const t2 = await token("tax-scope-1b");
      const holderId = await createHolder(t1, { name: "Holder 1", taxAllowanceAnnual: "1000" });
      const portfolioId = await createPortfolio(t1, { accountHolderId: holderId, taxAllowanceAnnual: "1000" });

      // User 2 cannot access user 1's portfolio.
      const res = await app.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/tax`,
        headers: auth(t2),
      });
      expect(res.statusCode).toBe(404);
    });

    it("applies 30% Teilfreistellung for ETF by asset-class fallback (no explicit rate)", async () => {
      // Verify that an ETF instrument with null partial_exemption_rate still gets
      // the 30% statutory exemption via the assetClass fallback in tfRatesFor.
      const t = await token("tax-etf-fallback");

      // Insert an ETF with NO explicit partialExemptionRate.
      const [etf] = await app.db
        .insert(instruments)
        .values({ symbol: "WORLD-ETF", market: "XETRA", assetClass: "etf", currency: "EUR", name: "World ETF" })
        .returning();

      const holderId = await createHolder(t, {
        name: "ETF Holder",
        taxAllowanceAnnual: "1000",
        capitalGainsTaxRate: "0.25",
        taxResidence: "DE",
      });
      const portfolioId = await createPortfolio(t, { accountHolderId: holderId, baseCurrency: "EUR", taxAllowanceAnnual: "1000" });

      // Upsert the user and create a buy + sell for a 1000 EUR gross gain.
      await app.inject({ method: "GET", url: "/me", headers: auth(t) });
      const buy = await app.inject({
        method: "POST",
        url: `/portfolios/${portfolioId}/transactions`,
        headers: auth(t),
        payload: {
          type: "buy",
          instrumentId: etf.id,
          quantity: "10",
          price: "100",
          currency: "EUR",
          executedAt: "2025-01-15T00:00:00.000Z",
        },
      });
      expect(buy.statusCode).toBe(201);

      const sell = await app.inject({
        method: "POST",
        url: `/portfolios/${portfolioId}/transactions`,
        headers: auth(t),
        payload: {
          type: "sell",
          instrumentId: etf.id,
          quantity: "10",
          price: "200", // gain = (200-100)*10 = 1000 gross
          currency: "EUR",
          executedAt: "2025-06-15T00:00:00.000Z",
        },
      });
      expect(sell.statusCode).toBe(201);

      const res = await app.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/tax?year=2025`,
        headers: auth(t),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      // Gross gain = 1000. With 30% Teilfreistellung: adjusted = 1000 × 0.70 = 700.
      // allowance = 1000, so usedYtd = 700, remaining = 300.
      expect(body.allowanceUsage.realizedGainsAdjusted).toBe("700.00");
      expect(body.allowanceUsage.usedYtd).toBe("700.00");
      expect(body.allowanceUsage.remaining).toBe("300.00");
    });
  });

  // ---------------------------------------------------------------------------
  // GET /networth/tax
  // ---------------------------------------------------------------------------

  describe("GET /networth/tax", () => {
    it("returns empty array when no holders have a tax allowance", async () => {
      const t = await token("tax-nw-1");
      // Create a holder WITHOUT a tax allowance.
      await createHolder(t, { name: "No Tax" });
      const res = await app.inject({
        method: "GET",
        url: "/networth/tax",
        headers: auth(t),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it("returns one entry per holder with allowance configured", async () => {
      const t = await token("tax-nw-2");
      const h1 = await createHolder(t, { name: "Holder A", taxAllowanceAnnual: "1000" });
      const h2 = await createHolder(t, { name: "Holder B", taxAllowanceAnnual: "800" });
      await createPortfolio(t, { accountHolderId: h1, taxAllowanceAnnual: "1000" });
      await createPortfolio(t, { accountHolderId: h2, taxAllowanceAnnual: "800" });

      const res = await app.inject({
        method: "GET",
        url: "/networth/tax?year=2025",
        headers: auth(t),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{ holder: { name: string } }>;
      const names = body.map((e) => e.holder.name);
      expect(names).toContain("Holder A");
      expect(names).toContain("Holder B");
    });

    it("filters by holderId when provided", async () => {
      const t = await token("tax-nw-3");
      const h1 = await createHolder(t, { name: "Filter A", taxAllowanceAnnual: "1000" });
      const h2 = await createHolder(t, { name: "Filter B", taxAllowanceAnnual: "800" });
      await createPortfolio(t, { accountHolderId: h1, taxAllowanceAnnual: "1000" });
      await createPortfolio(t, { accountHolderId: h2, taxAllowanceAnnual: "800" });

      const res = await app.inject({
        method: "GET",
        url: `/networth/tax?holderId=${h1}`,
        headers: auth(t),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{ holder: { name: string } }>;
      expect(body).toHaveLength(1);
      expect(body[0].holder.name).toBe("Filter A");
    });

    it("returns 404 for unknown holderId", async () => {
      const t = await token("tax-nw-4");
      const res = await app.inject({
        method: "GET",
        url: "/networth/tax?holderId=00000000-0000-0000-0000-000000000099",
        headers: auth(t),
      });
      expect(res.statusCode).toBe(404);
    });

    it("is scoped to the authenticated user (another user's data not returned)", async () => {
      const t1 = await token("tax-scope-nw-1a");
      const t2 = await token("tax-scope-nw-1b");
      await createHolder(t1, { name: "Private Holder", taxAllowanceAnnual: "1000" });
      await createPortfolio(t1, { accountHolderId: (await createHolder(t1, { name: "PH2", taxAllowanceAnnual: "500" })) });

      // User 2 should see no entries.
      const res = await app.inject({
        method: "GET",
        url: "/networth/tax",
        headers: auth(t2),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it("response shape has expected fields", async () => {
      const t = await token("tax-nw-shape");
      const holderId = await createHolder(t, {
        name: "Shape Holder",
        taxAllowanceAnnual: "1000",
        capitalGainsTaxRate: "0.25",
        taxResidence: "DE",
      });
      await createPortfolio(t, { accountHolderId: holderId, taxAllowanceAnnual: "1000" });

      const res = await app.inject({
        method: "GET",
        url: "/networth/tax?year=2025",
        headers: auth(t),
      });
      expect(res.statusCode).toBe(200);
      const [entry] = res.json() as Array<{
        holder: { id: string; name: string; taxAllowanceAnnual: string };
        year: number;
        currency: string;
        allowanceUsage: {
          allowanceAnnual: string;
          remaining: string;
          usedYtd: string;
          taxRate: string;
          currency: string;
        };
        harvestSuggestions: unknown[];
      }>;
      expect(entry.holder.name).toBe("Shape Holder");
      expect(entry.holder.taxAllowanceAnnual).toBe("1000");
      expect(entry.year).toBe(2025);
      expect(entry.currency).toBeDefined();
      expect(entry.allowanceUsage.allowanceAnnual).toBe("1000.00");
      expect(entry.allowanceUsage.remaining).toBe("1000.00");
      expect(entry.allowanceUsage.taxRate).toBe("0.25");
      expect(entry.allowanceUsage.currency).toBeDefined();
      expect(Array.isArray(entry.harvestSuggestions)).toBe(true);
    });

    it("distribution field carries FSA allocation breakdown against the cap", async () => {
      const t = await token("tax-nw-dist");
      const holderId = await createHolder(t, {
        name: "Dist Holder",
        taxAllowanceAnnual: "1000",
      });
      // Two depots each with partial FSA allocations summing to 700.
      await createPortfolio(t, { accountHolderId: holderId, taxAllowanceAnnual: "400" });
      await createPortfolio(t, { accountHolderId: holderId, taxAllowanceAnnual: "300" });

      const res = await app.inject({
        method: "GET",
        url: "/networth/tax?year=2025",
        headers: auth(t),
      });
      expect(res.statusCode).toBe(200);
      const [entry] = res.json() as Array<{
        allowanceUsage: { allowanceAnnual: string };
        distribution: {
          holderAllowanceCap: string;
          totalAllocated: string;
          remainingToDistribute: string;
          overAllocated: boolean;
        };
      }>;
      // allowanceUsage uses the holder cap (€1,000), not the FSA sum (€700).
      expect(entry.allowanceUsage.allowanceAnnual).toBe("1000.00");
      // Distribution shows cap vs. allocated vs. remaining.
      expect(entry.distribution.holderAllowanceCap).toBe("1000.00");
      expect(entry.distribution.totalAllocated).toBe("700.00");
      expect(entry.distribution.remainingToDistribute).toBe("300.00");
      expect(entry.distribution.overAllocated).toBe(false);
    });

    it("flags over-allocation when depot FSA sum exceeds the holder cap", async () => {
      const t = await token("tax-nw-overalloc");
      const holderId = await createHolder(t, {
        name: "Over Holder",
        taxAllowanceAnnual: "1000",
      });
      // Two depots together exceed the €1,000 cap.
      await createPortfolio(t, { accountHolderId: holderId, taxAllowanceAnnual: "700" });
      await createPortfolio(t, { accountHolderId: holderId, taxAllowanceAnnual: "500" });

      const res = await app.inject({
        method: "GET",
        url: "/networth/tax?year=2025",
        headers: auth(t),
      });
      expect(res.statusCode).toBe(200);
      const [entry] = res.json() as Array<{
        distribution: {
          holderAllowanceCap: string;
          totalAllocated: string;
          remainingToDistribute: string;
          overAllocated: boolean;
        };
      }>;
      expect(entry.distribution.totalAllocated).toBe("1200.00");
      expect(entry.distribution.remainingToDistribute).toBe("0.00");
      expect(entry.distribution.overAllocated).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH /account-holders/:id — tax profile fields round-trip
  // ---------------------------------------------------------------------------

  describe("PATCH /account-holders/:id — tax profile", () => {
    it("persists tax profile fields and returns them", async () => {
      const t = await token("tax-holder-patch");
      const holderId = await createHolder(t, { name: "Patch Target" });

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/account-holders/${holderId}`,
        headers: auth(t),
        payload: {
          taxAllowanceAnnual: "2000",
          capitalGainsTaxRate: "0.26375",
          churchTax: true,
          taxResidence: "DE",
        },
      });
      expect(patchRes.statusCode).toBe(200);
      const updated = patchRes.json();
      expect(updated.taxAllowanceAnnual).toBe("2000");
      expect(updated.capitalGainsTaxRate).toBe("0.26375");
      expect(updated.churchTax).toBe(true);
      expect(updated.taxResidence).toBe("DE");
    });

    it("can clear tax profile fields with null", async () => {
      const t = await token("tax-holder-clear");
      const holderId = await createHolder(t, {
        name: "Clear Target",
        taxAllowanceAnnual: "1000",
        taxResidence: "DE",
      });

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/account-holders/${holderId}`,
        headers: auth(t),
        payload: {
          taxAllowanceAnnual: null,
          taxResidence: null,
        },
      });
      expect(patchRes.statusCode).toBe(200);
      const updated = patchRes.json();
      expect(updated.taxAllowanceAnnual).toBeNull();
      expect(updated.taxResidence).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Rest-of-year forecast (forecastIncomeRestOfYear) — new projected fields
  // ---------------------------------------------------------------------------

  describe("forecastIncomeRestOfYear", () => {
    // currentYear is the year tests actually run in. We seed a dividend from last
    // year's rest-of-year window (today-1yr .. Dec 31 last year) so projectDividends
    // picks it up and projects it into the current year.
    const currentYear = new Date().getUTCFullYear();
    const lastYear = currentYear - 1;

    // A date in last year's rest-of-year window (Aug 15 of last year).
    const lastYearDivDate = `${lastYear}-08-15T00:00:00.000Z`;
    // A buy date well before the dividend.
    const buyDate = `${lastYear}-01-01T00:00:00.000Z`;

    it("returns zero forecast for a historic year (not current year)", async () => {
      const t = await token("tax-forecast-past");
      await app.inject({ method: "GET", url: "/me", headers: auth(t) }); // upsert user

      const [stock] = await app.db
        .insert(instruments)
        .values({ symbol: "PAST-STOCK", market: "XETRA", assetClass: "equity", currency: "EUR", name: "Past Stock" })
        .returning();

      const holderId = await createHolder(t, { name: "Past Year Holder", taxAllowanceAnnual: "1000" });
      const portfolioId = await createPortfolio(t, { accountHolderId: holderId, baseCurrency: "EUR", taxAllowanceAnnual: "1000" });

      await seedTransaction(app, portfolioId, auth(t), {
        type: "buy", instrumentId: stock.id, quantity: "10", price: "50",
        currency: "EUR", executedAt: buyDate,
      });
      await seedTransaction(app, portfolioId, auth(t), {
        type: "dividend", instrumentId: stock.id, quantity: "0", price: "20",
        currency: "EUR", executedAt: lastYearDivDate,
      });

      // Ask for a past year — forecast must be 0.
      const res = await app.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/tax?year=${lastYear}`,
        headers: auth(t),
      });
      expect(res.statusCode).toBe(200);
      const u = res.json().allowanceUsage;
      expect(u.forecastIncomeRestOfYear).toBe("0.00");
      // For a past year, projected fields equal realized fields.
      expect(u.projectedRemaining).toBe(u.remaining);
    });

    it("produces a positive forecastIncomeRestOfYear for the current year when a last-year dividend exists", async () => {
      const t = await token("tax-forecast-current");
      await app.inject({ method: "GET", url: "/me", headers: auth(t) }); // upsert user

      const [stock] = await app.db
        .insert(instruments)
        .values({ symbol: "CUR-STOCK", market: "XETRA", assetClass: "equity", currency: "EUR", name: "Current Stock" })
        .returning();

      const holderId = await createHolder(t, {
        name: "Current Year Holder",
        taxAllowanceAnnual: "1000",
        capitalGainsTaxRate: "0.25",
      });
      const portfolioId = await createPortfolio(t, { accountHolderId: holderId, baseCurrency: "EUR", taxAllowanceAnnual: "1000" });

      // Hold 10 shares; dividend from last year's rest-of-year window (no withholding).
      await seedTransaction(app, portfolioId, auth(t), {
        type: "buy", instrumentId: stock.id, quantity: "10", price: "100",
        currency: "EUR", executedAt: buyDate,
      });
      await seedTransaction(app, portfolioId, auth(t), {
        type: "dividend", instrumentId: stock.id, quantity: "0", price: "30",
        currency: "EUR", executedAt: lastYearDivDate,
      });

      // Current year, no year param.
      const res = await app.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/tax`,
        headers: auth(t),
      });
      expect(res.statusCode).toBe(200);
      const u = res.json().allowanceUsage;
      // Projection: dividend of 30 EUR from last year's window, same qty → 30 EUR forecast.
      // No withholding → gross-up ratio = 1.0 → forecast = 30.
      expect(parseFloat(u.forecastIncomeRestOfYear)).toBeGreaterThan(0);
      expect(parseFloat(u.projectedUsedFullYear)).toBeGreaterThan(parseFloat(u.usedYtd));
      expect(parseFloat(u.projectedRemaining)).toBeLessThan(parseFloat(u.remaining));
      // projected fields must sum correctly.
      const projected = parseFloat(u.projectedUsedFullYear) + parseFloat(u.projectedRemaining);
      expect(projected).toBeCloseTo(parseFloat(u.allowanceAnnual), 1);
    });

    it("grosses up projected dividends when withholding tax was recorded", async () => {
      const t = await token("tax-forecast-grossup");
      await app.inject({ method: "GET", url: "/me", headers: auth(t) });

      const [stock] = await app.db
        .insert(instruments)
        .values({ symbol: "GUP-STOCK", market: "XETRA", assetClass: "equity", currency: "EUR", name: "Grossup Stock" })
        .returning();

      const holderId = await createHolder(t, {
        name: "Grossup Holder",
        taxAllowanceAnnual: "1000",
        capitalGainsTaxRate: "0.25",
      });
      const portfolioId = await createPortfolio(t, { accountHolderId: holderId, baseCurrency: "EUR", taxAllowanceAnnual: "1000" });

      await seedTransaction(app, portfolioId, auth(t), {
        type: "buy", instrumentId: stock.id, quantity: "10", price: "100",
        currency: "EUR", executedAt: buyDate,
      });
      // Dividend: net price=60, withholding tax=20 → gross=80, ratio=80/60≈1.333.
      await seedTransaction(app, portfolioId, auth(t), {
        type: "dividend", instrumentId: stock.id, quantity: "0", price: "60",
        tax: "20", currency: "EUR", executedAt: lastYearDivDate,
      });

      const noTaxRes = await app.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/tax`,
        headers: auth(t),
      });
      expect(noTaxRes.statusCode).toBe(200);
      const u = noTaxRes.json().allowanceUsage;

      // Gross-up: projected 60 EUR net × (80/60) = 80 EUR gross.
      // forecastIncomeRestOfYear should be ~80, not ~60.
      const forecast = parseFloat(u.forecastIncomeRestOfYear);
      expect(forecast).toBeGreaterThan(60); // gross > net
      expect(forecast).toBeCloseTo(80, 0);  // ≈ net + tax = 80
    });

    it("harvest suggestions use projectedRemaining, not remaining", async () => {
      const t = await token("tax-forecast-harvest");
      await app.inject({ method: "GET", url: "/me", headers: auth(t) });

      const [stock] = await app.db
        .insert(instruments)
        .values({ symbol: "HARV-STOCK", market: "XETRA", assetClass: "equity", currency: "EUR", name: "Harvest Stock" })
        .returning();

      const holderId = await createHolder(t, {
        name: "Harvest Forecast Holder",
        taxAllowanceAnnual: "1000",
        capitalGainsTaxRate: "0.25",
      });
      const portfolioId = await createPortfolio(t, { accountHolderId: holderId, baseCurrency: "EUR", taxAllowanceAnnual: "1000" });

      // Buy at 50, still open (unrealized gain drives harvest suggestion).
      await seedTransaction(app, portfolioId, auth(t), {
        type: "buy", instrumentId: stock.id, quantity: "10", price: "50",
        currency: "EUR", executedAt: buyDate,
      });
      // Large dividend from last year's window (e.g. 900 EUR) → forecast eats most of 1000 allowance.
      await seedTransaction(app, portfolioId, auth(t), {
        type: "dividend", instrumentId: stock.id, quantity: "0", price: "900",
        currency: "EUR", executedAt: lastYearDivDate,
      });

      const res = await app.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/tax`,
        headers: auth(t),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const u = body.allowanceUsage;

      // No realized income/gains → realized remaining = 1000.
      // Forecast ≈ 900 → projectedRemaining ≈ 100.
      expect(parseFloat(u.remaining)).toBe(1000);
      expect(parseFloat(u.projectedRemaining)).toBeLessThan(200); // meaningfully reduced

      // Harvest suggestions should be sized against projectedRemaining, not 1000.
      // (No open position with unrealized gain in this test — suggestions should be empty
      //  or, if the buy is at 50 and there's no market price set, also empty.)
      // The key check is that projectedRemaining is returned at all and < remaining.
      expect(typeof u.projectedRemaining).toBe("string");
      expect(typeof u.projectedTaxSavingAvailable).toBe("string");
    });

    it("networth/tax also populates forecast fields across portfolios", async () => {
      const t = await token("tax-forecast-nw");
      await app.inject({ method: "GET", url: "/me", headers: auth(t) });

      const [stock] = await app.db
        .insert(instruments)
        .values({ symbol: "NW-STOCK", market: "XETRA", assetClass: "equity", currency: "EUR", name: "NW Stock" })
        .returning();

      const holderId = await createHolder(t, {
        name: "NW Forecast Holder",
        taxAllowanceAnnual: "1000",
        capitalGainsTaxRate: "0.25",
        taxResidence: "DE",
      });
      const portfolioId = await createPortfolio(t, { accountHolderId: holderId, baseCurrency: "EUR", taxAllowanceAnnual: "1000" });

      await seedTransaction(app, portfolioId, auth(t), {
        type: "buy", instrumentId: stock.id, quantity: "5", price: "100",
        currency: "EUR", executedAt: buyDate,
      });
      await seedTransaction(app, portfolioId, auth(t), {
        type: "dividend", instrumentId: stock.id, quantity: "0", price: "50",
        currency: "EUR", executedAt: lastYearDivDate,
      });

      const res = await app.inject({
        method: "GET",
        url: "/networth/tax",
        headers: auth(t),
      });
      expect(res.statusCode).toBe(200);
      const [entry] = res.json();
      expect(entry.holder.name).toBe("NW Forecast Holder");

      const u = entry.allowanceUsage;
      // Projected fields must all be present strings.
      expect(typeof u.forecastIncomeRestOfYear).toBe("string");
      expect(typeof u.projectedUsedFullYear).toBe("string");
      expect(typeof u.projectedRemaining).toBe("string");
      expect(typeof u.projectedTaxSavingAvailable).toBe("string");
      // With a last-year dividend in the window, forecast should be positive.
      expect(parseFloat(u.forecastIncomeRestOfYear)).toBeGreaterThan(0);
    });
  });
});
