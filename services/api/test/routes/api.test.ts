import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT, exportJWK, type JWK } from "jose";
import { instruments } from "@portfolio/db";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

const ISSUER = "https://auth.test/application/o/portfolio/";
const AUDIENCE = "portfolio-tracker";

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let privateKey: CryptoKey;
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
    // This suite shares one app across many requests in a single rate-limit window.
    process.env.RATE_LIMIT_MAX = "10000";
    app = await buildApp({ authKey: kp.publicKey });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    delete process.env.RATE_LIMIT_MAX;
  });

  it("rejects unauthenticated and invalid tokens", async () => {
    expect((await app.inject({ method: "GET", url: "/me" })).statusCode).toBe(401);
    const bad = await app.inject({ method: "GET", url: "/me", headers: auth("not-a-jwt") });
    expect(bad.statusCode).toBe(401);
    expect(publicJwk.kty).toBe("EC");
  });

  it("creates the user on first authenticated request", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: auth(await token("user-a")),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ authSub: "user-a", email: "user-a@example.com" });
  });

  it("updates the user's editable profile via PATCH /me", async () => {
    // A dedicated user so the currency change can't perturb other users' valuations.
    const t = await token("profile-user");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) }); // upsert

    const res = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: auth(t),
      payload: { name: "Björn", displayCurrency: "usd" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: "Björn",
      displayCurrency: "USD", // normalised
    });

    // The change persists on the next read.
    const me = await app.inject({ method: "GET", url: "/me", headers: auth(t) });
    expect(me.json()).toMatchObject({ name: "Björn", displayCurrency: "USD" });

    // An invalid currency is rejected.
    const bad = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: auth(t),
      payload: { displayCurrency: "RUPIAH" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("validation_error");
  });

  it("creates and lists portfolios for the owner", async () => {
    const t = await token("user-a");
    const created = await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(t),
      payload: { name: "Stockbit", baseCurrency: "idr", brokerage: "Stockbit" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().baseCurrency).toBe("IDR"); // normalised
    expect(created.json().brokerage).toBe("Stockbit");

    const list = await app.inject({ method: "GET", url: "/portfolios", headers: auth(t) });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);

    // Brokerage defaults to null when omitted.
    const created2 = await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(await token("brokerless-user")),
      payload: { name: "No broker", baseCurrency: "idr" },
    });
    expect(created2.json().brokerage).toBeNull();
  });

  it("sets and clears the brokerage via PATCH", async () => {
    const t = await token("broker-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Euro", baseCurrency: "eur", brokerage: "Trade Republic" },
      })
    ).json().id;

    const updated = await app.inject({
      method: "PATCH",
      url: `/portfolios/${portfolioId}`,
      headers: auth(t),
      payload: { brokerage: "DKB" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ name: "Euro", brokerage: "DKB" });

    // Explicit null clears it; other fields are untouched.
    const cleared = await app.inject({
      method: "PATCH",
      url: `/portfolios/${portfolioId}`,
      headers: auth(t),
      payload: { brokerage: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ name: "Euro", brokerage: null });
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
    const portfolioId = (
      await app.inject({ method: "GET", url: "/portfolios", headers: auth(t) })
    ).json()[0].id;

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
      {
        instrumentId: bbca.id,
        quantity: "100",
        avgCost: "9500",
        costBasis: "950000",
        realizedPnL: "0",
      },
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
    const portfolioId = (
      await app.inject({ method: "GET", url: "/portfolios", headers: auth(t) })
    ).json()[0].id;

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
    // Day change from the fixture's prior close (BBCA 9000 → 9500): 100 × 500.
    expect(summary.holdings[0].previousClose).toBe("9000");
    expect(summary.holdings[0].dayChange).toBe("50000");
    expect(summary.totalDayChange).toBe("50000");
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

  it("lists the configured gold buyback sources", async () => {
    const t = await token("user-a");
    const res = await app.inject({
      method: "GET",
      url: "/instruments/gold-sources",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    // Antam + Galeri24 are always configured; with no DB override both appear as gold sources.
    expect(res.json()).toContainEqual({ market: "ANTAM", label: "Antam buyback" });
    expect(res.json()).toContainEqual({ market: "GALERI24", label: "Galeri24 buyback" });
  });

  it("looks up instrument metadata from market data (auto-discovery)", async () => {
    const t = await token("user-a");

    // Tests use the FixtureProvider, whose catalogue stands in for the live providers.
    const byTicker = await app.inject({
      method: "GET",
      url: "/instruments/lookup?q=BBCA",
      headers: auth(t),
    });
    expect(byTicker.statusCode).toBe(200);
    expect(byTicker.json()).toContainEqual(
      expect.objectContaining({
        symbol: "BBCA",
        name: "Bank Central Asia Tbk",
        assetClass: "equity",
        currency: "IDR",
        market: "IDX",
      }),
    );

    // An ISIN routes through resolveISIN.
    const byIsin = await app.inject({
      method: "GET",
      url: "/instruments/lookup?q=ID1000109507",
      headers: auth(t),
    });
    expect(byIsin.json()[0]).toMatchObject({ symbol: "BBCA", isin: "ID1000109507" });

    // A no-match still returns 200 + [].
    const miss = await app.inject({
      method: "GET",
      url: "/instruments/lookup?q=ZZZZZ",
      headers: auth(t),
    });
    expect(miss.statusCode).toBe(200);
    expect(miss.json()).toEqual([]);

    // A blank query is rejected by validation.
    const blank = await app.inject({
      method: "GET",
      url: "/instruments/lookup?q=",
      headers: auth(t),
    });
    expect(blank.statusCode).toBe(400);
  });

  it("deletes a transaction (owner only)", async () => {
    const t = await token("user-a");
    const portfolioId = (
      await app.inject({ method: "GET", url: "/portfolios", headers: auth(t) })
    ).json()[0].id;

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
    const portfolioId = (
      await app.inject({ method: "GET", url: "/portfolios", headers: auth(t) })
    ).json()[0].id;

    const [gld] = await app.db
      .insert(instruments)
      .values({
        symbol: "GLD",
        market: "XAU",
        assetClass: "gold",
        unit: "grams",
        currency: "IDR",
        name: "Antam Gold",
      })
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
      payload: {
        type: "buy",
        quantity: "9",
        price: "1140000",
        currency: "IDR",
        executedAt: "2026-02-08T00:00:00.000Z",
      },
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
      payload: {
        type: "buy",
        quantity: "1",
        price: "1",
        currency: "IDR",
        executedAt: "2026-02-08T00:00:00.000Z",
      },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("batch-deletes transactions, ignoring foreign ids (owner only)", async () => {
    // A dedicated user/portfolio so the count isn't perturbed by other tests.
    const t = await token("bulk-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Bulk", baseCurrency: "idr" },
      })
    ).json().id;

    const [ins] = await app.db
      .insert(instruments)
      .values({
        symbol: "ANTM",
        market: "IDX",
        assetClass: "equity",
        currency: "IDR",
        name: "Aneka Tambang",
      })
      .returning();
    async function makeTx() {
      return (
        await app.inject({
          method: "POST",
          url: `/portfolios/${portfolioId}/transactions`,
          headers: auth(t),
          payload: {
            type: "buy",
            instrumentId: ins.id,
            quantity: "1",
            price: "1000",
            currency: "IDR",
            executedAt: "2026-01-20T00:00:00.000Z",
          },
        })
      ).json().id as string;
    }
    const id1 = await makeTx();
    const id2 = await makeTx();
    const id3 = await makeTx();

    // A non-owner can't batch-delete in this portfolio.
    const cross = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions/bulk-delete`,
      headers: auth(await token("user-b")),
      payload: { ids: [id1] },
    });
    expect(cross.statusCode).toBe(404);

    // The owner deletes two of the three; a foreign id is silently ignored.
    const foreign = "00000000-0000-0000-0000-000000000000";
    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions/bulk-delete`,
      headers: auth(t),
      payload: { ids: [id1, id2, foreign] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 2 });

    // Only id3 remains.
    const remaining = (
      await app.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/transactions`,
        headers: auth(t),
      })
    ).json();
    expect(remaining.map((x: { id: string }) => x.id)).toEqual([id3]);

    // An empty id list is rejected.
    const empty = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions/bulk-delete`,
      headers: auth(t),
      payload: { ids: [] },
    });
    expect(empty.statusCode).toBe(400);
  });

  it("renames and deletes a portfolio (owner only, cascades transactions)", async () => {
    const t = await token("rename-user");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) }); // upsert
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Temp", baseCurrency: "idr" },
      })
    ).json().id as string;

    // A non-owner can neither rename nor delete it.
    const tB = await token("rename-other");
    await app.inject({ method: "GET", url: "/me", headers: auth(tB) });
    const crossPatch = await app.inject({
      method: "PATCH",
      url: `/portfolios/${portfolioId}`,
      headers: auth(tB),
      payload: { name: "Hijack" },
    });
    expect(crossPatch.statusCode).toBe(404);
    const crossDelete = await app.inject({
      method: "DELETE",
      url: `/portfolios/${portfolioId}`,
      headers: auth(tB),
    });
    expect(crossDelete.statusCode).toBe(404);

    // The owner renames it.
    const renamed = await app.inject({
      method: "PATCH",
      url: `/portfolios/${portfolioId}`,
      headers: auth(t),
      payload: { name: "Renamed" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ id: portfolioId, name: "Renamed" });

    // Give it a transaction, then delete the portfolio — the transaction cascades.
    const [ins] = await app.db
      .insert(instruments)
      .values({
        symbol: "UNVR",
        market: "IDX",
        assetClass: "equity",
        currency: "IDR",
        name: "Unilever",
      })
      .returning();
    await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: {
        type: "buy",
        instrumentId: ins.id,
        quantity: "1",
        price: "5000",
        currency: "IDR",
        executedAt: "2026-01-25T00:00:00.000Z",
      },
    });

    const del = await app.inject({
      method: "DELETE",
      url: `/portfolios/${portfolioId}`,
      headers: auth(t),
    });
    expect(del.statusCode).toBe(204);

    // The portfolio is gone, and its transactions went with it (404 on read).
    expect(
      (await app.inject({ method: "GET", url: "/portfolios", headers: auth(t) })).json(),
    ).toHaveLength(0);
    const txAfter = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
    });
    expect(txAfter.statusCode).toBe(404);

    // Deleting again 404s.
    const again = await app.inject({
      method: "DELETE",
      url: `/portfolios/${portfolioId}`,
      headers: auth(t),
    });
    expect(again.statusCode).toBe(404);
  });

  it("accepts a bodyless DELETE that advertises application/json", async () => {
    // Browsers (via the api-client) send Content-Type: application/json on every
    // request. A bodyless DELETE carrying that header must not be rejected with a
    // 400 (FST_ERR_CTP_EMPTY_JSON_BODY) before the route handler runs.
    const t = await token("ctp-user");
    const created = await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: { ...auth(t), "content-type": "application/json" },
      payload: { name: "Disposable", baseCurrency: "IDR", portfolioType: "standard" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const del = await app.inject({
      method: "DELETE",
      url: `/portfolios/${id}`,
      headers: { ...auth(t), "content-type": "application/json" },
    });
    expect(del.statusCode).toBe(204);
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
    const bond = summary.holdings.find((h: { instrumentId: string }) => h.instrumentId === sr.id);
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
      .values({
        symbol: "BBCA",
        market: "NYSE",
        assetClass: "equity",
        currency: "USD",
        name: "BCA (USD)",
      })
      .returning();
    await app.db.insert(fxRates).values({
      base: "USD",
      quote: "IDR",
      rate: "16000",
      date: new Date().toISOString().slice(0, 10),
    });

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

  it("applies a corporate action (2:1 split) to derived holdings", async () => {
    const t = await token("ca-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Splits", baseCurrency: "IDR" },
      })
    ).json().id;
    const [inst] = await app.db
      .insert(instruments)
      .values({
        symbol: "SPLT",
        market: "IDX",
        assetClass: "equity",
        currency: "IDR",
        name: "Splitco",
      })
      .returning();
    await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: {
        type: "buy",
        instrumentId: inst.id,
        quantity: "100",
        price: "1000",
        currency: "IDR",
        executedAt: "2026-01-05T00:00:00.000Z",
      },
    });

    // 2:1 split with an ex-date after the purchase.
    const ca = await app.inject({
      method: "POST",
      url: "/corporate-actions",
      headers: auth(t),
      payload: { instrumentId: inst.id, type: "split", ratio: "2", exDate: "2026-02-01" },
    });
    expect(ca.statusCode).toBe(201);

    const holdings = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/holdings`,
      headers: auth(t),
    });
    const held = holdings.json().find((h: { instrumentId: string }) => h.instrumentId === inst.id);
    expect(held.quantity).toBe("200"); // 100 shares → 200 after the split
    expect(held.costBasis).toBe("100000"); // basis unchanged

    // The action is listed for the instrument.
    const list = await app.inject({
      method: "GET",
      url: `/instruments/${inst.id}/corporate-actions`,
      headers: auth(t),
    });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].type).toBe("split");
  });

  it("edits and deletes a corporate action, recomputing holdings", async () => {
    const t = await token("ca-edit-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Edits", baseCurrency: "IDR" },
      })
    ).json().id;
    const [inst] = await app.db
      .insert(instruments)
      .values({
        symbol: "EDIT",
        market: "IDX",
        assetClass: "equity",
        currency: "IDR",
        name: "Editco",
      })
      .returning();
    await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: {
        type: "buy",
        instrumentId: inst.id,
        quantity: "100",
        price: "1000",
        currency: "IDR",
        executedAt: "2026-01-05T00:00:00.000Z",
      },
    });
    const ca = (
      await app.inject({
        method: "POST",
        url: "/corporate-actions",
        headers: auth(t),
        payload: { instrumentId: inst.id, type: "split", ratio: "2", exDate: "2026-02-01" },
      })
    ).json();

    // PATCH the ratio 2:1 → 3:1; holdings recompute to 300 shares.
    const patched = await app.inject({
      method: "PATCH",
      url: `/corporate-actions/${ca.id}`,
      headers: auth(t),
      payload: { ratio: "3" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().ratio).toBe("3");
    const afterEdit = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/holdings`,
      headers: auth(t),
    });
    expect(
      afterEdit.json().find((h: { instrumentId: string }) => h.instrumentId === inst.id).quantity,
    ).toBe("300");

    // DELETE removes it; holdings fall back to the raw 100 shares.
    const del = await app.inject({
      method: "DELETE",
      url: `/corporate-actions/${ca.id}`,
      headers: auth(t),
    });
    expect(del.statusCode).toBe(204);
    const afterDelete = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/holdings`,
      headers: auth(t),
    });
    expect(
      afterDelete.json().find((h: { instrumentId: string }) => h.instrumentId === inst.id).quantity,
    ).toBe("100");

    // Unknown ids 404.
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/corporate-actions/${ca.id}`,
          headers: auth(t),
          payload: { ratio: "5" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "DELETE", url: `/corporate-actions/${ca.id}`, headers: auth(t) }))
        .statusCode,
    ).toBe(404);
  });

  it("aggregates net worth across a user's portfolios", async () => {
    const t = await token("nw-user");
    const mkPortfolio = async (name: string) =>
      (
        await app.inject({
          method: "POST",
          url: "/portfolios",
          headers: auth(t),
          payload: { name, baseCurrency: "IDR" },
        })
      ).json().id;
    const p1 = await mkPortfolio("One");
    const p2 = await mkPortfolio("Two");

    // BBCA priced 9500 by the fixture; distinct market avoids the IDX clash.
    const [bbca] = await app.db
      .insert(instruments)
      .values({
        symbol: "BBCA",
        market: "JKSE",
        assetClass: "equity",
        currency: "IDR",
        name: "BCA",
      })
      .returning();

    const post = (portfolioId: string, payload: object) =>
      app.inject({
        method: "POST",
        url: `/portfolios/${portfolioId}/transactions`,
        headers: auth(t),
        payload,
      });
    await post(p1, {
      type: "deposit",
      price: "2000000",
      currency: "IDR",
      executedAt: "2026-01-01T00:00:00.000Z",
    });
    await post(p1, {
      type: "buy",
      instrumentId: bbca.id,
      quantity: "100",
      price: "9000",
      currency: "IDR",
      executedAt: "2026-01-02T00:00:00.000Z",
    });
    await post(p2, {
      type: "deposit",
      price: "1000000",
      currency: "IDR",
      executedAt: "2026-01-01T00:00:00.000Z",
    });
    await post(p2, {
      type: "buy",
      instrumentId: bbca.id,
      quantity: "50",
      price: "9000",
      currency: "IDR",
      executedAt: "2026-01-02T00:00:00.000Z",
    });

    const res = await app.inject({ method: "GET", url: "/networth", headers: auth(t) });
    expect(res.statusCode).toBe(200);
    const nw = res.json();
    expect(nw.portfolioCount).toBe(2);
    // P1: cash 1,100,000 + 100×9500 = 2,050,000; P2: 550,000 + 50×9500 = 1,025,000.
    expect(nw.netWorth).toBe("3075000");
    expect(nw.cash.IDR).toBe("1650000"); // 1,100,000 + 550,000
    const merged = nw.holdings.find((h: { instrumentId: string }) => h.instrumentId === bbca.id);
    expect(merged.quantity).toBe("150"); // 100 + 50 across portfolios
    expect(merged.instrument.symbol).toBe("BBCA");
  });

  it("reports an income outlook: upcoming coupons + trailing yield", async () => {
    const t = await token("income-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Bonds", baseCurrency: "IDR" },
      })
    ).json().id;

    // A bond maturing in ~100 days (so its maturity coupon is the only one inside
    // the 12-month horizon), valued at par since no live quote exists.
    const maturity = new Date(Date.now() + 100 * 86_400_000).toISOString().slice(0, 10);
    const recentCoupon = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const [bond] = await app.db
      .insert(instruments)
      .values({
        symbol: "ORI-T",
        market: "IDX",
        assetClass: "bond",
        currency: "IDR",
        name: "ORI Test",
        faceValue: "1000000",
        couponRate: "0.06",
        couponSchedule: "semiannual",
        maturityDate: maturity,
      })
      .returning();

    await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: {
        type: "buy",
        instrumentId: bond.id,
        quantity: "10",
        price: "1000000",
        currency: "IDR",
        executedAt: "2026-01-05T00:00:00.000Z",
      },
    });
    await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: {
        type: "coupon",
        instrumentId: bond.id,
        quantity: "0",
        price: "300000",
        currency: "IDR",
        executedAt: recentCoupon,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/networth/income",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // One upcoming coupon (the maturity payment), 1,000,000 × 10 × 0.06 ÷ 2.
    expect(body.upcoming).toHaveLength(1);
    expect(body.upcoming[0]).toMatchObject({ symbol: "ORI-T", amount: "300000" });

    // Trailing yield: 300,000 income over par value 10,000,000 = 0.03; yield-on-cost
    // is the same since the bond was bought at par.
    const y = body.yields.find((r: { instrumentId: string }) => r.instrumentId === bond.id);
    expect(y).toMatchObject({
      trailingIncome: "300000",
      marketValue: "10000000",
      costBasis: "10000000",
      yield: "0.03",
      yieldOnCost: "0.03",
    });

    // Aggregated stats are derived from the single coupon event.
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ type: "coupon", amount: "300000", symbol: "ORI-T" });
    expect(body.lifetimeTotal).toBe("300000");
    expect(body.ttm).toBe("300000");
    expect(body.byYear).toEqual([{ year: "2026", total: "300000", paymentCount: 1 }]);
    // Forecast = TTM dividends (none) + the upcoming coupon (300,000).
    expect(body.forecastNextYear).toBe("300000");
    expect(body.byCurrency).toContainEqual({
      currency: "IDR",
      totalNative: "300000",
      totalNormalized: "300000",
    });

    // The per-portfolio twin returns the same stats for this lone portfolio.
    const scoped = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/income`,
      headers: auth(t),
    });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json().lifetimeTotal).toBe("300000");

    // Ownership is enforced.
    const other = await token("income-intruder");
    const denied = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/income`,
      headers: auth(other),
    });
    expect(denied.statusCode).toBe(404);
  });

  it("normalizes income yields for a non-display-currency holding (#93)", async () => {
    const { fxRates } = await import("@portfolio/db");
    const t = await token("income-fx-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "USD income", baseCurrency: "IDR" },
      })
    ).json().id;

    // USD instrument priced 9500 by the fixture (by symbol), USD→IDR at 16000.
    const [us] = await app.db
      .insert(instruments)
      .values({
        symbol: "BBCA",
        market: "NASDAQ",
        assetClass: "equity",
        currency: "USD",
        name: "BCA (USD)",
      })
      .returning();
    await app.db
      .insert(fxRates)
      .values({
        base: "USD",
        quote: "IDR",
        rate: "16000",
        date: new Date().toISOString().slice(0, 10),
      })
      .onConflictDoNothing();

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
    // A recent dividend of 100 USD (inside the trailing-12-month window).
    await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: {
        type: "dividend",
        instrumentId: us.id,
        quantity: "0",
        price: "100",
        currency: "USD",
        executedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      },
    });

    const body = (
      await app.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/income`,
        headers: auth(t),
      })
    ).json();

    const y = body.yields.find((r: { instrumentId: string }) => r.instrumentId === us.id);
    // Everything in the display currency (IDR): income 100×16000, value/cost 95000×16000.
    expect(y.trailingIncome).toBe("1600000");
    expect(y.marketValue).toBe("1520000000");
    expect(y.costBasis).toBe("1520000000");
    // Yields divide like-for-like, so the FX rate cancels: 100 / 95000 ≈ 0.00105.
    // (Pre-fix this divided IDR income by USD value and was ~16000× too large.)
    expect(Number(y.yield)).toBeCloseTo(100 / 95000, 8);
    expect(Number(y.yieldOnCost)).toBeCloseTo(100 / 95000, 8);
  });

  it("FX-converts XIRR cash flows to the display currency (#A)", async () => {
    const { fxRates } = await import("@portfolio/db");
    const t = await token("xirr-fx-user"); // display currency defaults to IDR
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "USD cash", baseCurrency: "USD" },
      })
    ).json().id;
    await app.db
      .insert(fxRates)
      .values({
        base: "USD",
        quote: "IDR",
        rate: "16000",
        date: new Date().toISOString().slice(0, 10),
      })
      .onConflictDoNothing();

    // A single foreign-currency deposit, no holdings → net worth is just the cash.
    await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: {
        type: "deposit",
        price: "1000",
        currency: "USD",
        executedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    const nw = (await app.inject({ method: "GET", url: "/networth", headers: auth(t) })).json();

    // Cash 1000 USD → 16,000,000 IDR.
    expect(nw.netWorth).toBe("16000000");
    // The deposit flow is converted to IDR (−16,000,000) to match the IDR terminal
    // value, so the money-weighted return is ~0. Pre-fix the flow stayed −1000 (raw
    // USD) against a +16,000,000 terminal, yielding a wildly large bogus rate.
    expect(Math.abs(nw.xirr)).toBeLessThan(0.01);
  });

  it("fetches a single instrument and its price history", async () => {
    const t = await token("user-a");
    const [inst] = await app.db
      .insert(instruments)
      .values({
        symbol: "HIST",
        market: "IDX",
        assetClass: "equity",
        currency: "IDR",
        name: "Histco",
      })
      .returning();

    const one = await app.inject({
      method: "GET",
      url: `/instruments/${inst.id}`,
      headers: auth(t),
    });
    expect(one.statusCode).toBe(200);
    expect(one.json().symbol).toBe("HIST");

    // History returns an array (empty under the fixture provider, which has no history).
    const hist = await app.inject({
      method: "GET",
      url: `/instruments/${inst.id}/history?range=1y`,
      headers: auth(t),
    });
    expect(hist.statusCode).toBe(200);
    expect(Array.isArray(hist.json())).toBe(true);

    // Unknown instrument 404s (a fixed, non-existent UUID — deterministic).
    const missing = await app.inject({
      method: "GET",
      url: "/instruments/00000000-0000-0000-0000-000000000000/history",
      headers: auth(t),
    });
    expect(missing.statusCode).toBe(404);
  });

  it("isolates portfolios between users", async () => {
    const tA = await token("user-a");
    const tB = await token("user-b");
    const portfolioId = (
      await app.inject({ method: "GET", url: "/portfolios", headers: auth(tA) })
    ).json()[0].id;

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

  it("serves net-worth history from snapshots (per portfolio + aggregate)", async () => {
    const { portfolioSnapshots } = await import("@portfolio/db");
    const t = await token("hist-user");
    const mk = async (name: string) =>
      (
        await app.inject({
          method: "POST",
          url: "/portfolios",
          headers: auth(t),
          payload: { name, baseCurrency: "IDR" },
        })
      ).json().id;
    const p1 = await mk("H1");
    const p2 = await mk("H2");

    await app.db.insert(portfolioSnapshots).values([
      { portfolioId: p1, date: "2026-02-01", netWorth: "1000000", currency: "IDR" },
      { portfolioId: p1, date: "2026-02-02", netWorth: "1100000", currency: "IDR" },
      { portfolioId: p2, date: "2026-02-02", netWorth: "500000", currency: "IDR" },
    ]);

    // Per-portfolio history, ordered by date.
    const h1 = await app.inject({
      method: "GET",
      url: `/portfolios/${p1}/history?range=all`,
      headers: auth(t),
    });
    expect(h1.statusCode).toBe(200);
    expect(h1.json()).toEqual([
      { date: "2026-02-01", netWorth: "1000000" },
      { date: "2026-02-02", netWorth: "1100000" },
    ]);

    // Aggregate sums same-date snapshots across the user's portfolios.
    const agg = await app.inject({
      method: "GET",
      url: "/networth/history?range=all",
      headers: auth(t),
    });
    expect(agg.statusCode).toBe(200);
    expect(agg.json()).toEqual([
      { date: "2026-02-01", netWorth: "1000000" },
      { date: "2026-02-02", netWorth: "1600000" }, // 1,100,000 + 500,000
    ]);

    // A non-owner can't read the portfolio's history.
    const cross = await app.inject({
      method: "GET",
      url: `/portfolios/${p1}/history`,
      headers: auth(await token("user-b")),
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
    await post({
      type: "deposit",
      price: "1000000",
      currency: "IDR",
      executedAt: "2025-01-01T00:00:00.000Z",
    });
    await post({
      type: "withdrawal",
      price: "100000",
      currency: "IDR",
      executedAt: "2025-07-01T00:00:00.000Z",
    });

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
