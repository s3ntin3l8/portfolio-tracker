import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT, exportJWK } from "jose";
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
let acmeId: string;

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

describe("transaction status (archived / cash_neutral)", () => {
  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    await exportJWK(kp.publicKey);
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    process.env.RATE_LIMIT_MAX = "10000";
    app = await buildApp({ authKey: kp.publicKey });
    // Price the cash-counted portfolio's instrument so /summary returns a market value.
    overrideMarketData(new MarketDataService([new FixtureProvider({ ACME: "10" })]));
    const [acme] = await app.db
      .insert(instruments)
      .values({ symbol: "ACME", market: "XETRA", assetClass: "equity", currency: "EUR", name: "Acme" })
      .returning();
    acmeId = acme.id;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    invalidateMarketData();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    delete process.env.RATE_LIMIT_MAX;
  });

  async function setup() {
    const t = await token("status-user");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });
    const created = await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(t),
      payload: { name: "S", baseCurrency: "EUR", cashCounted: true },
    });
    const portfolioId = created.json().id as string;
    async function addBuy(qty: string, price: string, fees = "0") {
      const res = await app.inject({
        method: "POST",
        url: `/portfolios/${portfolioId}/transactions`,
        headers: auth(t),
        payload: {
          type: "buy",
          instrumentId: acmeId,
          quantity: qty,
          price,
          fees,
          currency: "EUR",
          executedAt: "2026-01-15T00:00:00.000Z",
        },
      });
      return res.json().id as string;
    }
    return { t, portfolioId, instrumentId: acmeId, addBuy };
  }

  it("archiving a transaction removes it from derived holdings; restoring brings it back", async () => {
    const { t, portfolioId, addBuy } = await setup();
    const txId = await addBuy("10", "10");

    const before = await app.inject({ method: "GET", url: `/portfolios/${portfolioId}/holdings`, headers: auth(t) });
    expect(before.json().holdings).toHaveLength(1);

    const patched = await app.inject({
      method: "PATCH",
      url: `/portfolios/${portfolioId}/transactions/${txId}/status`,
      headers: auth(t),
      payload: { status: "archived" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().status).toBe("archived");

    const after = await app.inject({ method: "GET", url: `/portfolios/${portfolioId}/holdings`, headers: auth(t) });
    expect(after.json().holdings).toHaveLength(0);

    // The list endpoint still shows the archived row (so the UI can restore it).
    const list = await app.inject({ method: "GET", url: `/portfolios/${portfolioId}/transactions`, headers: auth(t) });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].status).toBe("archived");

    const restored = await app.inject({
      method: "PATCH",
      url: `/portfolios/${portfolioId}/transactions/${txId}/status`,
      headers: auth(t),
      payload: { status: "normal" },
    });
    expect(restored.json().status).toBe("normal");
    const back = await app.inject({ method: "GET", url: `/portfolios/${portfolioId}/holdings`, headers: auth(t) });
    expect(back.json().holdings).toHaveLength(1);
  });

  it("cash_neutral keeps shares but contributes no cash in the summary", async () => {
    const { t, portfolioId, addBuy } = await setup();
    // A deposit funds the account, then a cash_neutral buy (reward-funded).
    await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: { type: "deposit", quantity: "0", price: "1000", currency: "EUR", executedAt: "2026-01-10T00:00:00.000Z" },
    });
    const txId = await addBuy("5", "10"); // would normally cost 50

    const markNeutral = await app.inject({
      method: "PATCH",
      url: `/portfolios/${portfolioId}/transactions/${txId}/status`,
      headers: auth(t),
      payload: { status: "cash_neutral" },
    });
    expect(markNeutral.json().status).toBe("cash_neutral");

    const summary = await app.inject({ method: "GET", url: `/portfolios/${portfolioId}/summary`, headers: auth(t) });
    expect(summary.statusCode).toBe(200);
    const s = summary.json();
    // Shares kept: 5 ACME priced at 10 → 50 market value.
    const holding = s.holdings.find((h: { instrument: { symbol: string } }) => h.instrument.symbol === "ACME");
    expect(holding.quantity).toBe("5");
    // Cash is the full deposit — the cash_neutral buy did not spend any cash.
    expect(s.cash.EUR).toBe("1000");
  });

  it("rejects an invalid status value", async () => {
    const { t, portfolioId, addBuy } = await setup();
    const txId = await addBuy("1", "1");
    const bad = await app.inject({
      method: "PATCH",
      url: `/portfolios/${portfolioId}/transactions/${txId}/status`,
      headers: auth(t),
      payload: { status: "bogus" },
    });
    expect(bad.statusCode).toBe(400);
  });
});
