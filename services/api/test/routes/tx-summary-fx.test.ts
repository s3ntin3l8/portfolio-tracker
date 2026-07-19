import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { fxRates, instruments } from "@portfolio/db";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

// Covers #593: the `summary` (Invested/Proceeds/Income) returned by both
// GET /networth/transactions and GET /portfolios/:id/transactions used to be a raw
// `SUM(price*quantity)` with no currency awareness — silently blending currencies when
// rows span more than one `transactions.currency` (a EUR + IDR networth view, or a single
// portfolio holding a foreign-currency instrument). `computeConvertedSummary` groups by
// (currency, trade-day) and FX-folds each bucket to the target currency at that day's
// historical rate before summing.

const ISSUER = "https://auth.test/application/o/portfolio/";
const AUDIENCE = "portfolio-tracker";

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let privateKey: CryptoKey;
let instrumentId: string;

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

describe("transactions summary FX conversion (#593)", () => {
  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    process.env.RATE_LIMIT_MAX = "10000";
    app = await buildApp({ authKey: kp.publicKey });
    const [ins] = await app.db
      .insert(instruments)
      .values({
        symbol: "SUMFX",
        market: "XETRA",
        assetClass: "equity",
        currency: "EUR",
        name: "Summary FX Test Co",
      })
      .returning();
    instrumentId = ins.id;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    delete process.env.RATE_LIMIT_MAX;
  });

  async function createPortfolio(t: string, name: string, baseCurrency: string) {
    const res = await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(t),
      payload: { name, baseCurrency },
    });
    return res.json().id as string;
  }

  async function postTx(t: string, portfolioId: string, payload: Record<string, unknown>) {
    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: { instrumentId, executedAt: "2026-03-03T00:00:00.000Z", ...payload },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  it("networth summary folds every portfolio's currency to the user's displayCurrency", async () => {
    const t = await token("summary-fx-networth-user");
    await app.inject({
      method: "PATCH",
      url: "/me",
      headers: auth(t),
      payload: { displayCurrency: "IDR" },
    });

    const eurBook = await createPortfolio(t, "EUR book", "EUR");
    const idrBook = await createPortfolio(t, "IDR book", "IDR");
    // A third, mixed-in currency with no seeded rate — proves the known 1:1 fallback
    // doesn't corrupt the totals for the currencies that DO have a rate.
    const sgdBook = await createPortfolio(t, "SGD book", "SGD");

    await postTx(t, eurBook, { type: "buy", quantity: "10", price: "100", currency: "EUR" }); // 1000 EUR invested
    await postTx(t, eurBook, { type: "sell", quantity: "5", price: "50", currency: "EUR" }); // 250 EUR proceeds
    await postTx(t, eurBook, { type: "dividend", quantity: "1", price: "20", currency: "EUR" }); // 20 EUR income
    await postTx(t, idrBook, { type: "buy", quantity: "1", price: "5000000", currency: "IDR" }); // 5,000,000 IDR invested
    await postTx(t, sgdBook, { type: "buy", quantity: "1", price: "100", currency: "SGD" }); // 100 SGD invested, no rate seeded

    await app.db
      .insert(fxRates)
      .values([{ base: "EUR", quote: "IDR", rate: "16000", date: "2026-03-03" }]);

    const res = await app.inject({
      method: "GET",
      url: "/networth/transactions?page=1&pageSize=25",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const summary = res.json().summary as {
      totalInvested: string;
      totalProceeds: string;
      totalIncome: string;
    };
    // 1000 EUR * 16000 + 5,000,000 IDR + 100 SGD (unrated, falls back to 1:1) unconverted.
    expect(summary.totalInvested).toBe("21000100");
    expect(summary.totalProceeds).toBe("4000000");
    expect(summary.totalIncome).toBe("320000");
  });

  it("single-portfolio summary converts a foreign-currency row to the portfolio's base currency", async () => {
    const t = await token("summary-fx-single-user");
    const portfolioId = await createPortfolio(t, "EUR book with USD dividend", "EUR");

    await postTx(t, portfolioId, { type: "buy", quantity: "10", price: "100", currency: "EUR" }); // 1000 EUR
    await postTx(t, portfolioId, { type: "dividend", quantity: "1", price: "50", currency: "USD" }); // 50 USD

    await app.db
      .insert(fxRates)
      .values([{ base: "USD", quote: "EUR", rate: "0.9", date: "2026-03-03" }]);

    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions?page=1&pageSize=25`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const summary = res.json().summary as {
      totalInvested: string;
      totalProceeds: string;
      totalIncome: string;
    };
    expect(summary.totalInvested).toBe("1000");
    expect(summary.totalIncome).toBe("45"); // 50 * 0.9
  });

  it("networth summary is scoped to the user's own portfolios and unaffected by another user's currencies", async () => {
    const t1 = await token("summary-fx-owner");
    const t2 = await token("summary-fx-other");
    await app.inject({
      method: "PATCH",
      url: "/me",
      headers: auth(t1),
      payload: { displayCurrency: "EUR" },
    });
    const ownerBook = await createPortfolio(t1, "Owner book", "EUR");
    const otherBook = await createPortfolio(t2, "Other user's IDR book", "IDR");

    await postTx(t1, ownerBook, { type: "buy", quantity: "10", price: "100", currency: "EUR" }); // 1000 EUR
    await postTx(t2, otherBook, {
      type: "buy",
      quantity: "1",
      price: "999999999",
      currency: "IDR",
    });

    const res = await app.inject({
      method: "GET",
      url: "/networth/transactions?page=1&pageSize=25",
      headers: auth(t1),
    });
    expect(res.statusCode).toBe(200);
    const summary = res.json().summary as { totalInvested: string };
    expect(summary.totalInvested).toBe("1000");
  });
});
