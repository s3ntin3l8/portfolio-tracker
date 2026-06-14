import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT, exportJWK, type JWK, type KeyLike } from "jose";
import { instruments } from "@portfolio/db";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

const ISSUER = "https://auth.test/application/o/portfolio/";
const AUDIENCE = "portfolio-tracker";

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let privateKey: KeyLike;
let publicJwk: JWK;

async function token(sub: string, email = `${sub}@example.com`) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe("auth + portfolios + transactions", () => {
  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    publicJwk = await exportJWK(kp.publicKey);
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    app = await buildApp({ authKey: kp.publicKey });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
  });

  it("rejects unauthenticated and invalid tokens", async () => {
    expect((await app.inject({ method: "GET", url: "/me" })).statusCode).toBe(401);
    const bad = await app.inject({ method: "GET", url: "/me", headers: auth("not-a-jwt") });
    expect(bad.statusCode).toBe(401);
    expect(publicJwk.kty).toBe("EC");
  });

  it("creates the user on first authenticated request", async () => {
    const res = await app.inject({ method: "GET", url: "/me", headers: auth(await token("user-a")) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ authSub: "user-a", email: "user-a@example.com" });
  });

  it("creates and lists portfolios for the owner", async () => {
    const t = await token("user-a");
    const created = await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(t),
      payload: { name: "Stockbit", baseCurrency: "idr" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().baseCurrency).toBe("IDR"); // normalised

    const list = await app.inject({ method: "GET", url: "/portfolios", headers: auth(t) });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
  });

  it("validates portfolio input", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(await token("user-a")),
      payload: { name: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("validation_error");
  });

  it("records a transaction and derives holdings", async () => {
    const t = await token("user-a");
    const portfolioId = (await app.inject({ method: "GET", url: "/portfolios", headers: auth(t) })).json()[0].id;

    // Reference instrument (no instrument endpoint in this slice).
    const [bbca] = await app.db
      .insert(instruments)
      .values({ symbol: "BBCA", market: "IDX", assetClass: "equity", currency: "IDR", name: "BCA" })
      .returning();

    const tx = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: {
        type: "buy",
        instrumentId: bbca.id,
        quantity: "100",
        price: "9500",
        currency: "IDR",
        executedAt: "2026-01-15T03:00:00.000Z",
      },
    });
    expect(tx.statusCode).toBe(201);

    const holdings = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/holdings`,
      headers: auth(t),
    });
    expect(holdings.statusCode).toBe(200);
    expect(holdings.json()).toEqual([
      { instrumentId: bbca.id, quantity: "100", avgCost: "9500", costBasis: "950000", realizedPnL: "0" },
    ]);

    // The transaction list carries instrument metadata for rendering.
    const txList = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
    });
    expect(txList.json()[0].instrument).toEqual({
      symbol: "BBCA",
      name: "BCA",
      assetClass: "equity",
      unit: "shares",
    });
  });

  it("values the portfolio via /summary (priced by market data)", async () => {
    const t = await token("user-a");
    const portfolioId = (await app.inject({ method: "GET", url: "/portfolios", headers: auth(t) })).json()[0].id;

    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/summary`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const summary = res.json();
    // BBCA priced at 9500 by the fixture provider → 100 * 9500 market value.
    expect(summary.totalMarketValue).toBe("950000");
    expect(summary.holdings[0].marketValue).toBe("950000");
    expect(summary.holdings[0].instrument).toEqual({
      symbol: "BBCA",
      name: "BCA",
      assetClass: "equity",
      unit: "shares",
    });
    expect(summary.totalUnrealizedPnL).toBe("0");
    // Bought without a prior cash deposit, so cash is negative and net worth nets to 0.
    expect(summary.cash.IDR).toBe("-950000");
    expect(summary.netWorth).toBe("0");
  });

  it("finds-or-creates and searches instruments", async () => {
    const t = await token("user-a");

    // First POST creates; a second with the same (market, symbol) returns the same row.
    const create = await app.inject({
      method: "POST",
      url: "/instruments",
      headers: auth(t),
      payload: {
        symbol: "TLKM",
        market: "IDX",
        assetClass: "equity",
        currency: "idr",
        name: "Telkom Indonesia",
      },
    });
    expect(create.statusCode).toBe(201);
    const tlkm = create.json();
    expect(tlkm.symbol).toBe("TLKM");
    expect(tlkm.currency).toBe("IDR"); // normalised

    const again = await app.inject({
      method: "POST",
      url: "/instruments",
      headers: auth(t),
      payload: {
        symbol: "TLKM",
        market: "IDX",
        assetClass: "equity",
        currency: "IDR",
        name: "Telkom (dup)",
      },
    });
    expect(again.json().id).toBe(tlkm.id); // same instrument, not a duplicate

    // Search matches symbol or name, case-insensitively.
    const search = await app.inject({
      method: "GET",
      url: "/instruments?q=telkom",
      headers: auth(t),
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().some((i: { id: string }) => i.id === tlkm.id)).toBe(true);
  });

  it("deletes a transaction (owner only)", async () => {
    const t = await token("user-a");
    const portfolioId = (await app.inject({ method: "GET", url: "/portfolios", headers: auth(t) })).json()[0].id;

    const [oas] = await app.db
      .insert(instruments)
      .values({ symbol: "ORI", market: "IDX", assetClass: "bond", currency: "IDR", name: "ORI023" })
      .returning();
    const txId = (
      await app.inject({
        method: "POST",
        url: `/portfolios/${portfolioId}/transactions`,
        headers: auth(t),
        payload: {
          type: "buy",
          instrumentId: oas.id,
          quantity: "10",
          price: "100000",
          currency: "IDR",
          executedAt: "2026-01-10T00:00:00.000Z",
        },
      })
    ).json().id;

    // Another user can't delete it.
    const tB = await token("user-b");
    const cross = await app.inject({
      method: "DELETE",
      url: `/portfolios/${portfolioId}/transactions/${txId}`,
      headers: auth(tB),
    });
    expect(cross.statusCode).toBe(404);

    // The owner can.
    const del = await app.inject({
      method: "DELETE",
      url: `/portfolios/${portfolioId}/transactions/${txId}`,
      headers: auth(t),
    });
    expect(del.statusCode).toBe(204);

    // It's gone; deleting again 404s.
    const again = await app.inject({
      method: "DELETE",
      url: `/portfolios/${portfolioId}/transactions/${txId}`,
      headers: auth(t),
    });
    expect(again.statusCode).toBe(404);
    expect(again.json().error).toBe("transaction_not_found");
  });

  it("updates a transaction (owner only)", async () => {
    const t = await token("user-a");
    const portfolioId = (await app.inject({ method: "GET", url: "/portfolios", headers: auth(t) })).json()[0].id;

    const [gld] = await app.db
      .insert(instruments)
      .values({ symbol: "GLD", market: "XAU", assetClass: "gold", unit: "grams", currency: "IDR", name: "Antam Gold" })
      .returning();
    const txId = (
      await app.inject({
        method: "POST",
        url: `/portfolios/${portfolioId}/transactions`,
        headers: auth(t),
        payload: {
          type: "buy",
          instrumentId: gld.id,
          quantity: "5",
          price: "1140000",
          currency: "IDR",
          executedAt: "2026-02-08T00:00:00.000Z",
        },
      })
    ).json().id;

    // A non-owner can't update it.
    const cross = await app.inject({
      method: "PATCH",
      url: `/portfolios/${portfolioId}/transactions/${txId}`,
      headers: auth(await token("user-b")),
      payload: { type: "buy", quantity: "9", price: "1140000", currency: "IDR", executedAt: "2026-02-08T00:00:00.000Z" },
    });
    expect(cross.statusCode).toBe(404);

    // The owner can change the quantity.
    const res = await app.inject({
      method: "PATCH",
      url: `/portfolios/${portfolioId}/transactions/${txId}`,
      headers: auth(t),
      payload: {
        type: "buy",
        instrumentId: gld.id,
        quantity: "8",
        price: "1150000",
        currency: "IDR",
        executedAt: "2026-02-08T00:00:00.000Z",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: txId, quantity: "8", price: "1150000" });

    // Unknown id 404s.
    const missing = await app.inject({
      method: "PATCH",
      url: `/portfolios/${portfolioId}/transactions/${gld.id}`,
      headers: auth(t),
      payload: { type: "buy", quantity: "1", price: "1", currency: "IDR", executedAt: "2026-02-08T00:00:00.000Z" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("returns a live quote for the gold ticker", async () => {
    const t = await token("user-a");
    const res = await app.inject({
      method: "GET",
      url: "/quotes?symbol=GOLD&market=XAU&assetClass=gold&currency=idr",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    // Fixture provider prices GOLD at 1,150,000/gram.
    expect(res.json()).toMatchObject({
      symbol: "GOLD",
      assetClass: "gold",
      price: "1150000",
      currency: "IDR",
    });
    expect(typeof res.json().asOf).toBe("string");

    // Unknown symbol → no provider can price it.
    const missing = await app.inject({
      method: "GET",
      url: "/quotes?symbol=NOPE&market=XAU&assetClass=gold&currency=IDR",
      headers: auth(t),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("quote_unavailable");

    // Requires auth.
    const anon = await app.inject({
      method: "GET",
      url: "/quotes?symbol=GOLD&market=XAU&assetClass=gold&currency=IDR",
    });
    expect(anon.statusCode).toBe(401);
  });

  it("values bonds at par (face value) when there is no market price", async () => {
    const t = await token("bond-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Bonds", baseCurrency: "IDR" },
      })
    ).json().id;

    const [sr] = await app.db
      .insert(instruments)
      .values({
        symbol: "SR021", // not in the fixture → no market price
        market: "IDX",
        assetClass: "bond",
        unit: "units",
        currency: "IDR",
        name: "Sukuk Ritel 021",
        faceValue: "1000000",
      })
      .returning();
    await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: {
        type: "buy",
        instrumentId: sr.id,
        quantity: "5",
        price: "1000000",
        currency: "IDR",
        executedAt: "2026-01-10T00:00:00.000Z",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/summary`,
      headers: auth(t),
    });
    const summary = res.json();
    const bond = summary.holdings.find(
      (h: { instrumentId: string }) => h.instrumentId === sr.id,
    );
    expect(bond.price).toBe("1000000"); // valued at par
    expect(bond.marketValue).toBe("5000000"); // 5 units × 1,000,000
  });

  it("converts a non-base-currency holding via cached FX into the display currency", async () => {
    const { fxRates } = await import("@portfolio/db");
    const t = await token("fx-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "USD book", baseCurrency: "IDR" },
      })
    ).json().id;

    // A holding priced in USD; the fixture prices "BBCA" at 9500 (in the ref currency).
    // Symbol "BBCA" (fixture price 9500) on a distinct market to avoid the
    // (market, symbol) uniqueness clash with the IDX instrument above.
    const [us] = await app.db
      .insert(instruments)
      .values({ symbol: "BBCA", market: "NYSE", assetClass: "equity", currency: "USD", name: "BCA (USD)" })
      .returning();
    await app.db
      .insert(fxRates)
      .values({ base: "USD", quote: "IDR", rate: "16000", date: new Date().toISOString().slice(0, 10) });

    await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: {
        type: "buy",
        instrumentId: us.id,
        quantity: "10",
        price: "9500",
        currency: "USD",
        executedAt: "2026-01-10T00:00:00.000Z",
      },
    });

    const summary = (
      await app.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/summary`,
        headers: auth(t),
      })
    ).json();
    // Per-holding market value stays in USD; the total is converted to IDR.
    expect(summary.holdings[0].marketValue).toBe("95000"); // 10 × 9500 USD
    expect(summary.totalMarketValue).toBe("1520000000"); // × 16000 IDR/USD
  });

  it("isolates portfolios between users", async () => {
    const tA = await token("user-a");
    const tB = await token("user-b");
    const portfolioId = (await app.inject({ method: "GET", url: "/portfolios", headers: auth(tA) })).json()[0].id;

    // user-b sees none of user-a's portfolios...
    const listB = await app.inject({ method: "GET", url: "/portfolios", headers: auth(tB) });
    expect(listB.json()).toHaveLength(0);

    // ...and cannot read user-a's transactions.
    const cross = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(tB),
    });
    expect(cross.statusCode).toBe(404);
  });

  it("computes XIRR performance from external cash flows", async () => {
    const t = await token("perf-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Perf", baseCurrency: "IDR" },
      })
    ).json().id;

    const post = (payload: object) =>
      app.inject({
        method: "POST",
        url: `/portfolios/${portfolioId}/transactions`,
        headers: auth(t),
        payload,
      });
    await post({ type: "deposit", price: "1000000", currency: "IDR", executedAt: "2025-01-01T00:00:00.000Z" });
    await post({ type: "withdrawal", price: "100000", currency: "IDR", executedAt: "2025-07-01T00:00:00.000Z" });

    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/performance`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const perf = res.json();
    expect(perf.netWorth).toBe("900000"); // 1,000,000 deposited - 100,000 withdrawn
    expect(typeof perf.xirr).toBe("number");
    expect(Number.isFinite(perf.xirr)).toBe(true);
  });
});
