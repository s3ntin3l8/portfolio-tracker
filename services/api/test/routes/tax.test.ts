import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { instruments } from "@portfolio/db";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

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

    it("returns 422 when holder has no tax allowance configured", async () => {
      const t = await token("tax-user-3");
      const holderId = await createHolder(t, { name: "No Allowance Holder" });
      // Holder has no taxAllowanceAnnual.
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
      // Create a holder with tax allowance.
      const holderId = await createHolder(t, {
        name: "DE Holder",
        taxAllowanceAnnual: "1000",
        capitalGainsTaxRate: "0.25",
        taxResidence: "DE",
      });
      const portfolioId = await createPortfolio(t, { accountHolderId: holderId });

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
      const portfolioId = await createPortfolio(t, { accountHolderId: holderId });

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
      const portfolioId = await createPortfolio(t1, { accountHolderId: holderId });

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
      const portfolioId = await createPortfolio(t, { accountHolderId: holderId, baseCurrency: "EUR" });

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
      await createPortfolio(t, { accountHolderId: h1 });
      await createPortfolio(t, { accountHolderId: h2 });

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
      await createPortfolio(t, { accountHolderId: h1 });
      await createPortfolio(t, { accountHolderId: h2 });

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
      await createPortfolio(t, { accountHolderId: holderId });

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
});
