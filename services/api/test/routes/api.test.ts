import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT, exportJWK, type JWK } from "jose";
import { eq } from "drizzle-orm";
import { instruments, prices } from "@portfolio/db";
import { toDateKey } from "@portfolio/core";
import { FixtureProvider, MarketDataService } from "@portfolio/market-data";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { overrideMarketData, invalidateMarketData } from "../../src/services/market-data.js";

const ISSUER = "https://auth.test/application/o/portfolio/";
const AUDIENCE = "portfolio-tracker";
const ADMIN_GROUP = "Admins";

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let privateKey: CryptoKey;
let publicJwk: JWK;

async function token(sub: string, email = `${sub}@example.com`, groups?: string[]) {
  return new SignJWT({ email, ...(groups ? { groups } : {}) })
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

// A token whose `groups` claim includes the configured admin group — for
// requireAdmin-gated routes (instrument PATCH, corporate-actions writes).
async function adminToken(sub: string) {
  return token(sub, `${sub}@example.com`, [ADMIN_GROUP]);
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe("auth + portfolios + transactions", () => {
  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    publicJwk = await exportJWK(kp.publicKey);
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    process.env.AUTHENTIK_ADMIN_GROUP = ADMIN_GROUP;
    // This suite shares one app across many requests in a single rate-limit window.
    process.env.RATE_LIMIT_MAX = "10000";
    app = await buildApp({ authKey: kp.publicKey });
    overrideMarketData(
      new MarketDataService([new FixtureProvider({ BBCA: "9500" }, undefined, { BBCA: "9000" })]),
    );
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    invalidateMarketData();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    delete process.env.AUTHENTIK_ADMIN_GROUP;
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

  it("GET /portfolios reports transactionCount per portfolio", async () => {
    const t = await token("count-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Counted", baseCurrency: "idr" },
      })
    ).json().id;

    // A fresh portfolio has no transactions.
    const before = await app.inject({ method: "GET", url: "/portfolios", headers: auth(t) });
    expect(before.json()[0]).toMatchObject({ id: portfolioId, transactionCount: 0 });

    const [bbri] = await app.db
      .insert(instruments)
      .values({ symbol: "BBRI", market: "IDX", assetClass: "equity", currency: "IDR", name: "BRI" })
      .returning();
    for (let i = 0; i < 2; i++) {
      await app.inject({
        method: "POST",
        url: `/portfolios/${portfolioId}/transactions`,
        headers: auth(t),
        payload: {
          type: "buy",
          instrumentId: bbri.id,
          quantity: "10",
          price: "5000",
          currency: "IDR",
          executedAt: "2026-02-10T03:00:00.000Z",
        },
      });
    }

    const after = await app.inject({ method: "GET", url: "/portfolios", headers: auth(t) });
    expect(after.json()[0]).toMatchObject({ id: portfolioId, transactionCount: 2 });
  });

  it("GET /portfolios/values returns id+netWorth for each portfolio", async () => {
    const t = await token("values-user");
    const p1Id = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Main", baseCurrency: "idr" },
      })
    ).json().id;
    const p2Id = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Euro", baseCurrency: "eur" },
      })
    ).json().id;

    const res = await app.inject({ method: "GET", url: "/portfolios/values", headers: auth(t) });
    expect(res.statusCode).toBe(200);
    const values: { id: string; netWorth: string }[] = res.json();
    expect(values).toHaveLength(2);
    const ids = values.map((v) => v.id).sort();
    expect(ids).toEqual([p1Id, p2Id].sort());
    // Empty portfolios have zero net worth.
    for (const v of values) {
      expect(v).toHaveProperty("netWorth");
      expect(typeof v.netWorth).toBe("string");
    }
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

  it("links a portfolio to an account holder and derives its name via the holder", async () => {
    const t = await token("holder-user");
    const emma = (
      await app.inject({
        method: "POST",
        url: "/account-holders",
        headers: auth(t),
        payload: { name: "Emma", type: "child", birthYear: 2017 },
      })
    ).json();
    const luca = (
      await app.inject({
        method: "POST",
        url: "/account-holders",
        headers: auth(t),
        payload: { name: "Luca", type: "child" },
      })
    ).json();

    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Kids", baseCurrency: "idr", accountHolderId: emma.id },
      })
    ).json().id;

    // The holder's name + birth year + child type surface as derived read fields.
    const created = await app.inject({ method: "GET", url: "/portfolios", headers: auth(t) });
    expect(created.json()[0]).toMatchObject({
      accountHolderId: emma.id,
      accountHolder: "Emma",
      birthYear: 2017,
      portfolioType: "child",
    });

    // Re-link to another holder.
    const updated = await app.inject({
      method: "PATCH",
      url: `/portfolios/${portfolioId}`,
      headers: auth(t),
      payload: { accountHolderId: luca.id },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ accountHolderId: luca.id, accountHolder: "Luca" });

    // Explicit null unassigns it → derives back to standard with no name/birth year.
    const cleared = await app.inject({
      method: "PATCH",
      url: `/portfolios/${portfolioId}`,
      headers: auth(t),
      payload: { accountHolderId: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({
      name: "Kids",
      accountHolderId: null,
      accountHolder: null,
      birthYear: null,
      portfolioType: "standard",
    });
  });

  it("rejects linking a portfolio to another user's account holder", async () => {
    const owner = await token("holder-owner");
    const intruder = await token("holder-intruder");
    const holder = (
      await app.inject({
        method: "POST",
        url: "/account-holders",
        headers: auth(owner),
        payload: { name: "Mine", type: "self" },
      })
    ).json();

    const res = await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(intruder),
      payload: { name: "Sneaky", baseCurrency: "idr", accountHolderId: holder.id },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("account_holder_not_found");
  });

  it("sets and clears the account number via PATCH", async () => {
    const t = await token("acct-num-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: {
          name: "Stockbit",
          baseCurrency: "IDR",
          accountNumber: "SID12345678",
          iban: "DE78120300001066505387",
        },
      })
    ).json().id;

    // accountNumber and iban persisted on create.
    const created = await app.inject({ method: "GET", url: "/portfolios", headers: auth(t) });
    expect(created.json()[0].accountNumber).toBe("SID12345678");
    expect(created.json()[0].iban).toBe("DE78120300001066505387");

    // PATCH updates both.
    const updated = await app.inject({
      method: "PATCH",
      url: `/portfolios/${portfolioId}`,
      headers: auth(t),
      payload: { accountNumber: "SID99999999", iban: "DE00000000000000000000" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      accountNumber: "SID99999999",
      iban: "DE00000000000000000000",
    });

    // Explicit null clears both.
    const cleared = await app.inject({
      method: "PATCH",
      url: `/portfolios/${portfolioId}`,
      headers: auth(t),
      payload: { accountNumber: null, iban: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ accountNumber: null, iban: null });
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
    expect(holdings.json().holdings).toEqual([
      {
        instrumentId: bbca.id,
        quantity: "100",
        avgCost: "9500",
        costBasis: "950000",
        realizedPnL: "0",
        costCurrency: "IDR",
      },
    ]);

    // The transaction list carries instrument metadata for rendering.
    const txList = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
    });
    expect(txList.json()[0].instrument).toMatchObject({
      symbol: "BBCA",
      name: "BCA",
      assetClass: "equity",
      unit: "shares",
      market: "IDX",
      sector: null,
    });
  });

  it("filters the paginated transaction list by year across a calendar boundary", async () => {
    // Regression: the year filter went from `EXTRACT(YEAR FROM executed_at) = y` to a
    // sargable [start, end) date range — this pins the boundary dates (Dec 31 23:59 vs
    // Jan 1 00:00 UTC) so a future refactor can't silently shift a row into the wrong year.
    const t = await token("year-filter-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Year filter test", baseCurrency: "idr" },
      })
    ).json().id;
    const [inst] = await app.db
      .insert(instruments)
      .values({
        symbol: "BBYF",
        market: "IDX",
        assetClass: "equity",
        currency: "IDR",
        name: "Year Filter Test Co",
      })
      .returning();

    const buy = (executedAt: string) =>
      app.inject({
        method: "POST",
        url: `/portfolios/${portfolioId}/transactions`,
        headers: auth(t),
        payload: {
          type: "buy",
          instrumentId: inst.id,
          quantity: "10",
          price: "1000",
          currency: "IDR",
          executedAt,
        },
      });

    await buy("2024-12-31T23:59:59.000Z"); // last instant of 2024
    await buy("2025-01-01T00:00:00.000Z"); // first instant of 2025
    await buy("2025-06-15T12:00:00.000Z");

    const y2024 = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions?page=1&year=2024`,
      headers: auth(t),
    });
    expect(y2024.statusCode).toBe(200);
    expect(y2024.json().total).toBe(1);
    expect(y2024.json().rows[0].executedAt).toBe("2024-12-31T23:59:59.000Z");

    const y2025 = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions?page=1&year=2025`,
      headers: auth(t),
    });
    expect(y2025.statusCode).toBe(200);
    expect(y2025.json().total).toBe(2);
  });

  it("reports total + summary correctly on a normal page and on an out-of-range page", async () => {
    // Regression: count + summary are folded into the page query via COUNT(*)/SUM(...)
    // OVER () (one scan instead of three). A window aggregate only rides along on rows
    // the query actually returns, so requesting a page whose offset skips past every
    // matching row (rows come back empty) must still report the true total/summary via
    // the separate fallback query, not silently report zero.
    const t = await token("pagination-total-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Pagination total test", baseCurrency: "idr" },
      })
    ).json().id;
    const [inst] = await app.db
      .insert(instruments)
      .values({
        symbol: "BBPT",
        market: "IDX",
        assetClass: "equity",
        currency: "IDR",
        name: "Pagination Test Co",
      })
      .returning();

    for (const [type, price] of [
      ["buy", "1000"],
      ["buy", "1000"],
      ["sell", "1200"],
      ["dividend", "50"],
    ] as const) {
      const res = await app.inject({
        method: "POST",
        url: `/portfolios/${portfolioId}/transactions`,
        headers: auth(t),
        payload: {
          type,
          instrumentId: inst.id,
          quantity: type === "dividend" ? "0" : "10",
          price,
          currency: "IDR",
          executedAt: "2025-03-01T00:00:00.000Z",
        },
      });
      expect(res.statusCode).toBe(201);
    }

    // pageSize=2 → page 1 has rows and an accurate window-derived total/summary.
    const page1 = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions?page=1&pageSize=2`,
      headers: auth(t),
    });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json();
    expect(body1.rows).toHaveLength(2);
    expect(body1.total).toBe(4);
    expect(body1.summary).toMatchObject({
      totalInvested: "20000", // 2 buys × 10 × 1000
      totalProceeds: "12000", // 1 sell × 10 × 1200
    });

    // page 10 is entirely beyond the 4 available rows → empty page, but total/summary
    // must still reflect all 4 rows, not fall back to 0 (the merged-query edge case).
    const page10 = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions?page=10&pageSize=2`,
      headers: auth(t),
    });
    expect(page10.statusCode).toBe(200);
    const body10 = page10.json();
    expect(body10.rows).toHaveLength(0);
    expect(body10.total).toBe(4);
    expect(body10.summary).toEqual(body1.summary);
  });

  it("reports the true total on an out-of-range page of /networth/transactions", async () => {
    // Same merged-query fallback as the per-portfolio endpoint, exercised on the
    // cross-portfolio aggregate path.
    const t = await token("networth-pagination-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Networth pagination test", baseCurrency: "idr" },
      })
    ).json().id;
    const [inst] = await app.db
      .insert(instruments)
      .values({
        symbol: "BBNP",
        market: "IDX",
        assetClass: "equity",
        currency: "IDR",
        name: "Networth Pagination Test Co",
      })
      .returning();

    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "POST",
        url: `/portfolios/${portfolioId}/transactions`,
        headers: auth(t),
        payload: {
          type: "buy",
          instrumentId: inst.id,
          quantity: "1",
          price: "100",
          currency: "IDR",
          executedAt: "2025-03-01T00:00:00.000Z",
        },
      });
      expect(res.statusCode).toBe(201);
    }

    const page1 = await app.inject({
      method: "GET",
      url: "/networth/transactions?page=1&pageSize=2",
      headers: auth(t),
    });
    expect(page1.statusCode).toBe(200);
    expect(page1.json().rows).toHaveLength(2);
    expect(page1.json().total).toBe(3);

    const page10 = await app.inject({
      method: "GET",
      url: "/networth/transactions?page=10&pageSize=2",
      headers: auth(t),
    });
    expect(page10.statusCode).toBe(200);
    expect(page10.json().rows).toHaveLength(0);
    expect(page10.json().total).toBe(3);
  });

  it("returns a type/year-filter-independent `years` list from /networth/transactions", async () => {
    // Regression: the year filter chip on the Activity screen relies on `years` covering
    // every year with transactions, not just the years present in the currently filtered
    // page — otherwise the chip only shows up once a filter happens to span multiple years.
    const t = await token("networth-years-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Networth years test", baseCurrency: "idr" },
      })
    ).json().id;
    const [inst] = await app.db
      .insert(instruments)
      .values({
        symbol: "BBNY",
        market: "IDX",
        assetClass: "equity",
        currency: "IDR",
        name: "Networth Years Test Co",
      })
      .returning();

    for (const executedAt of ["2022-06-01T00:00:00.000Z", "2024-06-01T00:00:00.000Z"]) {
      const res = await app.inject({
        method: "POST",
        url: `/portfolios/${portfolioId}/transactions`,
        headers: auth(t),
        payload: {
          type: "buy",
          instrumentId: inst.id,
          quantity: "1",
          price: "100",
          currency: "IDR",
          executedAt,
        },
      });
      expect(res.statusCode).toBe(201);
    }

    // A type filter that matches neither transaction (both are "buy") — `rows`/`total`
    // reflect the filter, but `years` must still list both years.
    const byType = await app.inject({
      method: "GET",
      url: "/networth/transactions?page=1&pageSize=25&type=income",
      headers: auth(t),
    });
    expect(byType.statusCode).toBe(200);
    const byTypeBody = byType.json();
    expect(byTypeBody.rows).toHaveLength(0);
    expect(byTypeBody.years).toEqual(expect.arrayContaining(["2022", "2024"]));

    // A year filter narrows `rows`, but `years` must still list both years so the
    // dropdown itself isn't filtered by the currently-selected year.
    const byYear = await app.inject({
      method: "GET",
      url: "/networth/transactions?page=1&pageSize=25&year=2022",
      headers: auth(t),
    });
    expect(byYear.statusCode).toBe(200);
    const byYearBody = byYear.json();
    expect(byYearBody.rows).toHaveLength(1);
    expect(byYearBody.years).toEqual(expect.arrayContaining(["2022", "2024"]));
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
    expect(summary.holdings[0].instrument).toMatchObject({
      symbol: "BBCA",
      name: "BCA",
      assetClass: "equity",
      unit: "shares",
      market: "IDX",
      sector: null,
    });
    expect(summary.totalUnrealizedPnL).toBe("0");
    // Default boundary is cash-outside: uninvested (here negative) cash is excluded, so
    // net worth is the securities sleeve only. This also avoids the negative-cash artifact
    // from importing buys without their funding deposit.
    expect(summary.cash.IDR).toBeUndefined();
    expect(summary.netWorth).toBe("950000");
    // Day change from the fixture's prior close (BBCA 9000 → 9500): 100 × 500.
    expect(summary.holdings[0].previousClose).toBe("9000");
    expect(summary.holdings[0].dayChange).toBe("50000");
    expect(summary.totalDayChange).toBe("50000");
  });

  it("attaches a per-holding sparkline series on /summary and /networth", async () => {
    const t = await token("user-a");
    const portfolioId = (
      await app.inject({ method: "GET", url: "/portfolios", headers: auth(t) })
    ).json()[0].id;

    const [bbca] = await app.db.select().from(instruments).where(eq(instruments.symbol, "BBCA"));
    // Seed three stored daily closes (ascending).
    await app.db.insert(prices).values([
      { instrumentId: bbca.id, date: "2026-01-13", close: "9000", currency: "IDR" },
      { instrumentId: bbca.id, date: "2026-01-14", close: "9200", currency: "IDR" },
      { instrumentId: bbca.id, date: "2026-01-15", close: "9500", currency: "IDR" },
    ]);

    const summary = (
      await app.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/summary`,
        headers: auth(t),
      })
    ).json();
    // Ordered oldest→newest and attached to the held instrument.
    expect(summary.holdings[0].sparkline).toEqual([9000, 9200, 9500]);

    // The aggregate net-worth path rebuilds holdings — the series must survive there too.
    const networth = (
      await app.inject({ method: "GET", url: "/networth", headers: auth(t) })
    ).json();
    const bbcaHolding = networth.holdings.find(
      (h: { instrumentId: string }) => h.instrumentId === bbca.id,
    );
    expect(bbcaHolding.sparkline).toEqual([9000, 9200, 9500]);
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

  it("patches an instrument's ISIN and WKN (admin only)", async () => {
    const t = await token("user-a");
    const admin = await adminToken("instrument-admin");
    const create = await app.inject({
      method: "POST",
      url: "/instruments",
      headers: auth(t),
      payload: {
        symbol: "SIE",
        market: "XETRA",
        assetClass: "equity",
        currency: "EUR",
        name: "Siemens AG",
      },
    });
    const inst = create.json();

    // A non-admin (even the instrument's own creator) is rejected.
    const forbidden = await app.inject({
      method: "PATCH",
      url: `/instruments/${inst.id}`,
      headers: auth(t),
      payload: { isin: "DE0007236101", wkn: "723610" },
    });
    expect(forbidden.statusCode).toBe(403);

    const patch = await app.inject({
      method: "PATCH",
      url: `/instruments/${inst.id}`,
      headers: auth(admin),
      payload: { isin: "DE0007236101", wkn: "723610" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ id: inst.id, isin: "DE0007236101", wkn: "723610" });
  });

  it("patches an instrument's market (corrects a mis-mapped import)", async () => {
    const t = await token("user-a");
    const admin = await adminToken("instrument-admin");
    const create = await app.inject({
      method: "POST",
      url: "/instruments",
      headers: auth(t),
      payload: {
        symbol: "AMZN",
        market: "PE",
        assetClass: "equity",
        currency: "USD",
        name: "Amazon",
      },
    });
    const inst = create.json();

    const patch = await app.inject({
      method: "PATCH",
      url: `/instruments/${inst.id}`,
      headers: auth(admin),
      payload: { market: "US" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ id: inst.id, market: "US" });
  });

  it("returns 409 when patching an instrument with an ISIN already owned by another row", async () => {
    const t = await token("user-a");
    const admin = await adminToken("instrument-admin");
    const isin = "DE000SAP0011";
    await app.inject({
      method: "POST",
      url: "/instruments",
      headers: auth(t),
      payload: {
        symbol: "SAP",
        market: "XETRA",
        assetClass: "equity",
        currency: "EUR",
        name: "SAP SE",
        isin,
      },
    });
    const row2 = await app.inject({
      method: "POST",
      url: "/instruments",
      headers: auth(t),
      payload: {
        symbol: "SAP2",
        market: "XETRA",
        assetClass: "equity",
        currency: "EUR",
        name: "SAP Clone",
      },
    });
    const conflict = await app.inject({
      method: "PATCH",
      url: `/instruments/${row2.json().id}`,
      headers: auth(admin),
      payload: { isin },
    });
    expect(conflict.statusCode).toBe(409);
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

  it("creates a savings_plan transaction with kind and returns it", async () => {
    const t = await token("user-sp");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "SP Test", baseCurrency: "eur" },
      })
    ).json().id;
    const [eq] = await app.db
      .insert(instruments)
      .values({
        symbol: "XETRA",
        market: "XETRA",
        assetClass: "equity",
        currency: "EUR",
        name: "Test ETF",
      })
      .returning();

    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: {
        type: "savings_plan",
        instrumentId: eq.id,
        quantity: "1.5",
        price: "200",
        currency: "EUR",
        executedAt: "2026-03-01T00:00:00.000Z",
        kind: "saveback",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ type: "savings_plan", kind: "saveback", quantity: "1.5" });
  });

  it("PATCH preserves kind and provenance (source/externalId)", async () => {
    // Simulate an imported transaction that had source+externalId set.
    const t = await token("user-prov");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Prov Test", baseCurrency: "eur" },
      })
    ).json().id;
    const [eq] = await app.db
      .insert(instruments)
      .values({
        symbol: "PROV",
        market: "XETRA",
        assetClass: "equity",
        currency: "EUR",
        name: "Prov Inst",
      })
      .returning();

    // Create with kind + externalId to simulate an import.
    const created = (
      await app.inject({
        method: "POST",
        url: `/portfolios/${portfolioId}/transactions`,
        headers: auth(t),
        payload: {
          type: "buy",
          instrumentId: eq.id,
          quantity: "10",
          price: "100",
          currency: "EUR",
          executedAt: "2026-03-10T00:00:00.000Z",
          source: "csv",
          externalId: "csv-row-42",
          kind: "saveback",
        },
      })
    ).json();
    const txId: string = created.id;

    // PATCH that sends back the original source/externalId (as the edit form does).
    const res = await app.inject({
      method: "PATCH",
      url: `/portfolios/${portfolioId}/transactions/${txId}`,
      headers: auth(t),
      payload: {
        type: "buy",
        instrumentId: eq.id,
        quantity: "10",
        price: "100",
        fees: "0",
        currency: "EUR",
        executedAt: "2026-03-10T00:00:00.000Z",
        source: "csv",
        externalId: "csv-row-42",
        kind: "saveback",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: txId,
      source: "csv",
      externalId: "csv-row-42",
      kind: "saveback",
    });
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

  it("returns 404 for gold when no live provider is configured (no fixture gold price)", async () => {
    const t = await token("user-a");
    const res = await app.inject({
      method: "GET",
      url: "/quotes?symbol=GOLD&market=XAU&assetClass=gold&currency=IDR",
      headers: auth(t),
    });
    // No fixture gold price and no live provider in tests → quote unavailable.
    expect(res.statusCode).toBe(404);

    // Unknown symbol → also no provider.
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
      date: toDateKey(new Date()),
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
    const admin = await adminToken("ca-admin");
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

    // A non-admin cannot record a corporate action, even for their own holding.
    const forbidden = await app.inject({
      method: "POST",
      url: "/corporate-actions",
      headers: auth(t),
      payload: { instrumentId: inst.id, type: "split", ratio: "2", exDate: "2026-02-01" },
    });
    expect(forbidden.statusCode).toBe(403);

    // 2:1 split with an ex-date after the purchase.
    const ca = await app.inject({
      method: "POST",
      url: "/corporate-actions",
      headers: auth(admin),
      payload: { instrumentId: inst.id, type: "split", ratio: "2", exDate: "2026-02-01" },
    });
    expect(ca.statusCode).toBe(201);

    const holdings = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/holdings`,
      headers: auth(t),
    });
    const held = holdings
      .json()
      .holdings.find((h: { instrumentId: string }) => h.instrumentId === inst.id);
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
    const admin = await adminToken("ca-edit-admin");
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
        headers: auth(admin),
        payload: { instrumentId: inst.id, type: "split", ratio: "2", exDate: "2026-02-01" },
      })
    ).json();

    // A non-admin can neither edit nor delete it.
    const forbiddenPatch = await app.inject({
      method: "PATCH",
      url: `/corporate-actions/${ca.id}`,
      headers: auth(t),
      payload: { ratio: "3" },
    });
    expect(forbiddenPatch.statusCode).toBe(403);
    const forbiddenDelete = await app.inject({
      method: "DELETE",
      url: `/corporate-actions/${ca.id}`,
      headers: auth(t),
    });
    expect(forbiddenDelete.statusCode).toBe(403);

    // PATCH the ratio 2:1 → 3:1; holdings recompute to 300 shares.
    const patched = await app.inject({
      method: "PATCH",
      url: `/corporate-actions/${ca.id}`,
      headers: auth(admin),
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
      afterEdit.json().holdings.find((h: { instrumentId: string }) => h.instrumentId === inst.id)
        .quantity,
    ).toBe("300");

    // DELETE removes it; holdings fall back to the raw 100 shares.
    const del = await app.inject({
      method: "DELETE",
      url: `/corporate-actions/${ca.id}`,
      headers: auth(admin),
    });
    expect(del.statusCode).toBe(204);
    const afterDelete = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/holdings`,
      headers: auth(t),
    });
    expect(
      afterDelete.json().holdings.find((h: { instrumentId: string }) => h.instrumentId === inst.id)
        .quantity,
    ).toBe("100");

    // Unknown ids 404 (for an admin — a non-admin would 403 before reaching that check).
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/corporate-actions/${ca.id}`,
          headers: auth(admin),
          payload: { ratio: "5" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/corporate-actions/${ca.id}`,
          headers: auth(admin),
        })
      ).statusCode,
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
          payload: { name, baseCurrency: "IDR", cashCounted: true },
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
    const maturity = toDateKey(new Date(Date.now() + 100 * 86_400_000));
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

  it("surfaces the clean displayName on yields/events/byInstrument when set on the instrument (#480)", async () => {
    // MSFT-shaped fixture: a raw broker-style name that the displayName enrichment
    // is meant to clean up. The income response must prefer displayName everywhere a
    // name appears, so the UI doesn't have to fall back to the dirty string.
    // Uses a bond (faceValue → marketValue, no fixture price required) so the
    // yield denominator is non-zero regardless of the market-data provider.
    const t = await token("income-displayname-user");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });
    await app.inject({
      method: "PATCH",
      url: "/me",
      headers: auth(t),
      payload: { displayCurrency: "usd" },
    });
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "DisplayName test", baseCurrency: "USD" },
      })
    ).json().id;

    const maturity = toDateKey(new Date(Date.now() + 100 * 86_400_000));
    const recentCoupon = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const [bond] = await app.db
      .insert(instruments)
      .values({
        symbol: "DN480",
        market: "IDX",
        assetClass: "bond",
        currency: "USD",
        name: "DN480 RAW BROKER NAME",
        displayName: "DisplayName Test Bond",
        faceValue: "1000000",
        couponRate: "0.06",
        couponSchedule: "semiannual",
        maturityDate: maturity,
      })
      .returning();

    // Buy the bond so summary.holdings includes it (par valuation → marketValueDisplay).
    await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: {
        type: "buy",
        instrumentId: bond.id,
        quantity: "10",
        price: "1000000",
        currency: "USD",
        executedAt: "2026-01-05T00:00:00.000Z",
      },
    });

    // A coupon within the trailing 12-month window — populates events, byInstrument,
    // and (via par valuation) the yields row.
    await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: {
        type: "coupon",
        instrumentId: bond.id,
        quantity: "0",
        price: "30000",
        currency: "USD",
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

    // Top contributors (byInstrument) — displayName surfaces here.
    expect(body.byInstrument).toHaveLength(1);
    expect(body.byInstrument[0]).toMatchObject({
      symbol: "DN480",
      displayName: "DisplayName Test Bond",
    });

    // Event log — displayName rides along with the historical event.
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      symbol: "DN480",
      displayName: "DisplayName Test Bond",
    });

    // Trailing yield row — displayName here is the headline fix for #480.
    expect(body.yields).toHaveLength(1);
    expect(body.yields[0]).toMatchObject({
      symbol: "DN480",
      displayName: "DisplayName Test Bond",
    });
  });

  it("surfaces cash interest as a separate subtotal without polluting dividend totals", async () => {
    const { fxRates } = await import("@portfolio/db");
    const t = await token("income-interest-user");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) }); // upsert
    // /networth/income uses the user's displayCurrency; /portfolios/:id/income uses
    // the portfolio's baseCurrency. Align both to EUR so a single set of expected
    // totals holds for both endpoints below.
    await app.inject({
      method: "PATCH",
      url: "/me",
      headers: auth(t),
      payload: { displayCurrency: "eur" },
    });
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Interest test", baseCurrency: "EUR" },
      })
    ).json().id;

    const [instr] = await app.db
      .insert(instruments)
      .values({
        symbol: "INTTEST",
        market: "XETRA",
        assetClass: "equity",
        currency: "EUR",
        name: "Interest Test Co",
      })
      .returning();

    const post = (payload: object) =>
      app.inject({
        method: "POST",
        url: `/portfolios/${portfolioId}/transactions`,
        headers: auth(t),
        payload,
      });

    // One dividend (position-linked) this year.
    await post({
      type: "dividend",
      instrumentId: instr.id,
      quantity: "0",
      price: "246.72",
      currency: "EUR",
      executedAt: "2026-03-01T00:00:00.000Z",
    });

    // Cash interest — no instrument, same-currency (EUR) for the base case.
    await post({
      type: "interest",
      price: "20.00",
      currency: "EUR",
      executedAt: "2026-02-01T00:00:00.000Z",
    });
    await post({
      type: "interest",
      price: "13.04",
      currency: "EUR",
      executedAt: "2026-04-01T00:00:00.000Z",
    });

    // A second, multi-currency interest payment guards the FX-prefetch widening —
    // its currency (USD) never appears among the dividend transactions.
    await app.db
      .insert(fxRates)
      .values({
        base: "USD",
        quote: "EUR",
        rate: "0.9",
        date: toDateKey(new Date()),
      })
      .onConflictDoNothing();
    await post({
      type: "interest",
      price: "10.00",
      currency: "USD",
      executedAt: "2026-05-01T00:00:00.000Z",
    });

    for (const url of ["/networth/income", `/portfolios/${portfolioId}/income`]) {
      const res = await app.inject({ method: "GET", url, headers: auth(t) });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      // Interest subtotal: 20.00 + 13.04 + (10.00 × 0.9) = 42.04, all in the display
      // currency — FX-converted even though USD never fed the dividend set.
      expect(body.interest).toMatchObject({
        ytd: "42.04",
        ttm: "42.04",
        lifetime: "42.04",
        currency: "EUR",
      });

      // The dividend headline is untouched by interest.
      expect(body.thisYear).toBe("246.72");
      expect(body.ttm).toBe("246.72");
      expect(body.lifetimeTotal).toBe("246.72");
      expect(body.byYear).toEqual([{ year: "2026", total: "246.72", paymentCount: 1 }]);
      expect(body.byCurrency).toEqual([
        { currency: "EUR", totalNative: "246.72", totalNormalized: "246.72" },
      ]);

      // No interest row leaks into the dividend/coupon event log.
      expect(body.events).toHaveLength(1);
      expect(body.events.some((e: { type: string }) => e.type === "interest")).toBe(false);
    }
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
        date: toDateKey(new Date()),
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

  it("includes quarterly dividends in forecastRestOfYear when dividend_events has future announced rows", async () => {
    const { dividendEvents, fxRates } = await import("@portfolio/db");
    const t = await token("msft-forecast-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "MSFT Forecast", baseCurrency: "IDR" },
      })
    ).json().id;

    const [msft] = await app.db
      .insert(instruments)
      .values({
        symbol: "MSFT",
        market: "NASDAQ",
        assetClass: "equity",
        currency: "USD",
        name: "Microsoft",
      })
      .returning();

    await app.db
      .insert(fxRates)
      .values({
        base: "USD",
        quote: "IDR",
        rate: "16000",
        date: toDateKey(new Date()),
      })
      .onConflictDoNothing();

    await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: {
        type: "buy",
        instrumentId: msft.id,
        quantity: "10",
        price: "450",
        currency: "USD",
        executedAt: "2025-01-10T00:00:00.000Z",
      },
    });

    // Quarterly dividends: Mar/Jun 2025 (outside source window), Sep/Dec 2025 (inside)
    for (const [date, amt] of [
      ["2025-03-12", "0.75"],
      ["2025-06-12", "0.75"],
      ["2025-09-12", "0.80"],
      ["2025-12-12", "0.80"],
    ]) {
      await app.inject({
        method: "POST",
        url: `/portfolios/${portfolioId}/transactions`,
        headers: auth(t),
        payload: {
          type: "dividend",
          instrumentId: msft.id,
          quantity: "0",
          price: amt,
          currency: "USD",
          executedAt: `${date}T00:00:00.000Z`,
        },
      });
    }

    // Simulate refreshDividends with TwelveData/EODHD (returns future announced dividends)
    await app.db.insert(dividendEvents).values([
      {
        instrumentId: msft.id,
        exDate: "2025-03-12",
        amountPerShare: "0.75",
        currency: "USD",
        status: "paid",
        source: "test",
        fetchedAt: new Date(),
      },
      {
        instrumentId: msft.id,
        exDate: "2025-06-12",
        amountPerShare: "0.75",
        currency: "USD",
        status: "paid",
        source: "test",
        fetchedAt: new Date(),
      },
      {
        instrumentId: msft.id,
        exDate: "2025-09-12",
        amountPerShare: "0.80",
        currency: "USD",
        status: "paid",
        source: "test",
        fetchedAt: new Date(),
      },
      {
        instrumentId: msft.id,
        exDate: "2025-12-12",
        amountPerShare: "0.80",
        currency: "USD",
        status: "paid",
        source: "test",
        fetchedAt: new Date(),
      },
      // Future announced — trigger instrumentsWithAnnounced path
      {
        instrumentId: msft.id,
        exDate: "2026-09-12",
        amountPerShare: "0.80",
        currency: "USD",
        status: "announced",
        source: "test",
        fetchedAt: new Date(),
      },
      {
        instrumentId: msft.id,
        exDate: "2026-12-12",
        amountPerShare: "0.80",
        currency: "USD",
        status: "announced",
        source: "test",
        fetchedAt: new Date(),
      },
    ]);

    const body = (
      await app.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/income`,
        headers: auth(t),
      })
    ).json();

    // MSFT should appear in forecastRestOfYear via futureAnnounced
    // (0.80 USD × 10 shares × 2 quarters = 16 USD × 16000 IDR)
    const forecastRestOfYear = Number(body.forecastRestOfYear);
    expect(forecastRestOfYear).toBeGreaterThan(0);

    // MSFT's announced dividends should appear in upcoming (rest-of-year window).
    // The upcoming stream now also includes next-year cadence projections, so we filter
    // to the announced entries to verify the 2026 rest-of-year total.
    const upcomingDividends = body.upcoming.filter(
      (u: { kind: string; instrumentId: string }) =>
        u.kind === "dividend" && u.instrumentId === msft.id,
    );
    const announcedEntries = upcomingDividends.filter(
      (u: { status: string }) => u.status === "announced",
    );
    expect(announcedEntries.length).toBeGreaterThanOrEqual(2);

    // Announced portion: 0.80 USD × 10 shares × 2 quarters = 16 USD.
    const totalAnnouncedUSD = announcedEntries.reduce(
      (sum: number, u: { amount: string }) => sum + Number(u.amount),
      0,
    );
    expect(totalAnnouncedUSD).toBeCloseTo(16.0, 1);

    // Next-year projected entries are also included in upcoming (cadence engine projects
    // the 4 quarterly payments for Jan–Dec next year beyond the announced window).
    const projectedEntries = upcomingDividends.filter(
      (u: { status: string }) => u.status === "projected" || u.status === "grown",
    );
    expect(projectedEntries.length).toBeGreaterThan(0);

    // Announced entries should carry perShare (= amountPerShare from dividend_events)
    // and quantity (= held shares = 10).
    for (const entry of announcedEntries) {
      expect(entry.perShare).toBeDefined();
      expect(entry.quantity).toBeDefined();
      expect(Number(entry.perShare)).toBeCloseTo(0.8, 2); // amountPerShare
      expect(Number(entry.quantity)).toBeCloseTo(10, 2); // held qty
    }

    // Projected entries should carry perShare and quantity; perShare × quantity ≈ amount.
    for (const entry of projectedEntries) {
      expect(entry.perShare).toBeDefined();
      expect(entry.quantity).toBeDefined();
      const reconstructed = Number(entry.perShare) * Number(entry.quantity);
      expect(reconstructed).toBeCloseTo(Number(entry.amount), 4);
    }

    // Historical dividend events should carry perShare and quantity.
    const histDivEvents = body.events.filter(
      (e: { type: string; instrumentId: string }) =>
        e.type === "dividend" && e.instrumentId === msft.id,
    );
    for (const ev of histDivEvents) {
      expect(ev.perShare).toBeDefined();
      expect(ev.quantity).toBeDefined();
      const reconstructed = Number(ev.perShare) * Number(ev.quantity);
      expect(reconstructed).toBeCloseTo(Number(ev.amount), 4);
    }
  });

  it("uses projected dividends when dividend_events has only past paid rows (Yahoo Finance scenario)", async () => {
    const { dividendEvents, fxRates } = await import("@portfolio/db");
    const t = await token("msft-yahoo-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "MSFT Yahoo", baseCurrency: "IDR" },
      })
    ).json().id;

    const [msft] = await app.db
      .insert(instruments)
      .values({
        symbol: "MSFT2",
        market: "NASDAQ",
        assetClass: "equity",
        currency: "USD",
        name: "Microsoft 2",
      })
      .returning();

    await app.db
      .insert(fxRates)
      .values({
        base: "USD",
        quote: "IDR",
        rate: "16000",
        date: toDateKey(new Date()),
      })
      .onConflictDoNothing();

    await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: {
        type: "buy",
        instrumentId: msft.id,
        quantity: "10",
        price: "450",
        currency: "USD",
        executedAt: "2025-01-10T00:00:00.000Z",
      },
    });

    for (const [date, amt] of [
      ["2025-09-12", "0.80"],
      ["2025-12-12", "0.80"],
    ]) {
      await app.inject({
        method: "POST",
        url: `/portfolios/${portfolioId}/transactions`,
        headers: auth(t),
        payload: {
          type: "dividend",
          instrumentId: msft.id,
          quantity: "0",
          price: amt,
          currency: "USD",
          executedAt: `${date}T00:00:00.000Z`,
        },
      });
    }

    // Only past paid rows (Yahoo Finance — no future announced dividends)
    await app.db.insert(dividendEvents).values([
      {
        instrumentId: msft.id,
        exDate: "2025-09-12",
        amountPerShare: "0.80",
        currency: "USD",
        status: "paid",
        source: "yahoo",
        fetchedAt: new Date(),
      },
      {
        instrumentId: msft.id,
        exDate: "2025-12-12",
        amountPerShare: "0.80",
        currency: "USD",
        status: "paid",
        source: "yahoo",
        fetchedAt: new Date(),
      },
    ]);

    const body = (
      await app.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/income`,
        headers: auth(t),
      })
    ).json();

    // forecastRestOfYear should include projected dividends (Sep/Dec 2026)
    // MSFT should NOT be in instrumentsWithAnnounced (no future rows)
    // So blendedProjected should include MSFT's projected entries
    expect(Number(body.forecastRestOfYear)).toBeGreaterThan(0);

    const upcomingMsft = body.upcoming.filter(
      (u: { kind: string; instrumentId: string }) =>
        u.kind === "dividend" && u.instrumentId === msft.id,
    );
    // upcoming now spans two windows: rest-of-year (2 projected entries from projectDividends)
    // and next-year (cadence engine projects quarterly payments for Jan–Dec next year).
    expect(upcomingMsft.length).toBeGreaterThanOrEqual(2);

    // Rest-of-year entries (current calendar year) should be "projected" since there are
    // no future announced rows in dividend_events for this instrument.
    const currentYear = new Date().getUTCFullYear().toString();
    const restOfYearEntries = upcomingMsft.filter((u: { date: string }) =>
      u.date.startsWith(currentYear),
    );
    expect(restOfYearEntries.length).toBeGreaterThanOrEqual(0);
    expect(restOfYearEntries.every((u: { status: string }) => u.status === "projected")).toBe(true);

    // All entries (both windows) should be projection-based, not announced.
    expect(
      upcomingMsft.every(
        (u: { status: string }) => u.status === "projected" || u.status === "grown",
      ),
    ).toBe(true);

    // Projected upcoming dividend rows should carry perShare and quantity.
    for (const u of upcomingMsft) {
      expect(u.perShare).toBeDefined();
      expect(u.quantity).toBeDefined();
      const reconstructed = Number(u.perShare) * Number(u.quantity);
      expect(reconstructed).toBeCloseTo(Number(u.amount), 4);
    }
  });

  it("does not forecast dividends for an instrument with no recorded position", async () => {
    // Regression test for the root cause of the MSFT production bug:
    // 14 dividend transactions were imported from the DKB Girokonto CSV but the
    // opening purchase predated the exported window, leaving net_qty = 0.
    // projectDividends gates on heldQty > 0 (packages/core/src/income.ts:146-147),
    // so MSFT was silently skipped: historical income visible, forecast zero.
    // Fix: add the missing opening buy transaction.
    const { fxRates } = await import("@portfolio/db");
    const t = await token("msft-nopos-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "No-Position Test", baseCurrency: "IDR" },
      })
    ).json().id;

    const [msft] = await app.db
      .insert(instruments)
      .values({
        symbol: "MSFT3",
        market: "NASDAQ",
        assetClass: "equity",
        currency: "USD",
        name: "Microsoft (no position)",
      })
      .returning();

    await app.db
      .insert(fxRates)
      .values({
        base: "USD",
        quote: "IDR",
        rate: "16000",
        date: toDateKey(new Date()),
      })
      .onConflictDoNothing();

    // Dividend-only transactions — no buy; mirrors the DKB CSV gap.
    // Sep and Dec of last year fall inside the projectDividends source window
    // (now-1yr → Dec 31 of last year).
    const yr = new Date().getUTCFullYear() - 1;
    const sepDate = new Date(Date.UTC(yr, 8, 12)).toISOString(); // Sep 12
    const decDate = new Date(Date.UTC(yr, 11, 12)).toISOString(); // Dec 12
    for (const executedAt of [sepDate, decDate]) {
      await app.inject({
        method: "POST",
        url: `/portfolios/${portfolioId}/transactions`,
        headers: auth(t),
        payload: {
          type: "dividend",
          instrumentId: msft.id,
          quantity: "0",
          price: "8.00",
          currency: "USD",
          executedAt,
        },
      });
    }

    const body = (
      await app.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/income`,
        headers: auth(t),
      })
    ).json();

    // Historical income is recorded correctly...
    expect(Number(body.lastYear)).toBeGreaterThan(0);
    // ...but there is no forecast because the instrument is not held.
    expect(Number(body.forecastRestOfYear)).toBe(0);
    // Nothing appears in upcoming either.
    const upcoming = (body.upcoming ?? []) as { instrumentId: string }[];
    expect(upcoming.filter((u) => u.instrumentId === msft.id)).toHaveLength(0);
  });

  it("FX-converts XIRR cash flows to the display currency (#A)", async () => {
    const { fxRates } = await import("@portfolio/db");
    const t = await token("xirr-fx-user"); // display currency defaults to IDR
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "USD cash", baseCurrency: "USD", cashCounted: true },
      })
    ).json().id;
    await app.db
      .insert(fxRates)
      .values({
        base: "USD",
        quote: "IDR",
        rate: "16000",
        date: toDateKey(new Date()),
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
    expect(h1.json()).toMatchObject([
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
    expect(agg.json()).toMatchObject([
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

  it("serves 1D/7D net-worth history from intraday snapshots (per portfolio + aggregate)", async () => {
    const { portfolioIntradaySnapshots } = await import("@portfolio/db");
    const t = await token("intraday-hist-user");
    const mk = async (name: string) =>
      (
        await app.inject({
          method: "POST",
          url: "/portfolios",
          headers: auth(t),
          payload: { name, baseCurrency: "IDR" },
        })
      ).json().id;
    const p1 = await mk("IH1");
    const p2 = await mk("IH2");

    const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);
    const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000);
    const recent = hoursAgo(2); // within both 1d and 7d windows
    const midWeek = daysAgo(3); // within 7d but outside 1d
    const stale = daysAgo(10); // outside both windows

    await app.db.insert(portfolioIntradaySnapshots).values([
      { portfolioId: p1, capturedAt: stale, netWorth: "1", marketValue: "1", currency: "IDR" },
      {
        portfolioId: p1,
        capturedAt: midWeek,
        netWorth: "900000",
        marketValue: "900000",
        currency: "IDR",
      },
      {
        portfolioId: p1,
        capturedAt: recent,
        netWorth: "1000000",
        marketValue: "1000000",
        currency: "IDR",
      },
      {
        portfolioId: p2,
        capturedAt: recent,
        netWorth: "500000",
        marketValue: "500000",
        currency: "IDR",
      },
    ]);

    // 1D: only the "recent" point (2h ago) is in-window.
    const h1d = await app.inject({
      method: "GET",
      url: `/portfolios/${p1}/history?range=1d`,
      headers: auth(t),
    });
    expect(h1d.statusCode).toBe(200);
    const points1d = h1d.json();
    expect(points1d).toHaveLength(1);
    expect(points1d[0]).toMatchObject({ netWorth: "1000000", marketValue: "1000000" });
    expect(typeof points1d[0].at).toBe("string");

    // 7D: both the "recent" and "midWeek" points are in-window, ordered oldest first.
    const h7d = await app.inject({
      method: "GET",
      url: `/portfolios/${p1}/history?range=7d`,
      headers: auth(t),
    });
    expect(h7d.statusCode).toBe(200);
    const points7d = h7d.json();
    expect(points7d).toHaveLength(2);
    expect(points7d.map((p: { netWorth: string }) => p.netWorth)).toEqual(["900000", "1000000"]);

    // Aggregate 1D sums same-timestamp points across the user's portfolios.
    const agg1d = await app.inject({
      method: "GET",
      url: "/networth/history?range=1d",
      headers: auth(t),
    });
    expect(agg1d.statusCode).toBe(200);
    const aggPoints = agg1d.json();
    expect(aggPoints).toHaveLength(1);
    expect(aggPoints[0].netWorth).toBe("1500000"); // 1,000,000 + 500,000

    // A non-owner can't read the portfolio's intraday history either.
    const cross = await app.inject({
      method: "GET",
      url: `/portfolios/${p1}/history?range=1d`,
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
        payload: { name: "Perf", baseCurrency: "IDR", cashCounted: true },
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

  it("filters /networth/income by holderId", async () => {
    const t = await token("holder-income");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });

    const childHolder = (
      await app.inject({
        method: "POST",
        url: "/account-holders",
        headers: auth(t),
        payload: { name: "Income Child", type: "child", birthYear: 2018 },
      })
    ).json();
    const selfHolder = (
      await app.inject({
        method: "POST",
        url: "/account-holders",
        headers: auth(t),
        payload: { name: "Income Self", type: "self" },
      })
    ).json();

    const childPf = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Child income pf", baseCurrency: "IDR", accountHolderId: childHolder.id },
      })
    ).json().id;
    const selfPf = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Self income pf", baseCurrency: "IDR", accountHolderId: selfHolder.id },
      })
    ).json().id;

    const [div] = await app.db
      .insert(instruments)
      .values({
        symbol: "BBCA2",
        market: "IDX",
        assetClass: "equity",
        currency: "IDR",
        name: "BCA2",
      })
      .returning();

    // Child portfolio: a buy + a dividend.
    await app.inject({
      method: "POST",
      url: `/portfolios/${childPf}/transactions`,
      headers: auth(t),
      payload: {
        type: "buy",
        instrumentId: div.id,
        quantity: "100",
        price: "9000",
        currency: "IDR",
        executedAt: "2025-01-01T00:00:00.000Z",
      },
    });
    await app.inject({
      method: "POST",
      url: `/portfolios/${childPf}/transactions`,
      headers: auth(t),
      payload: {
        type: "dividend",
        instrumentId: div.id,
        quantity: "0",
        price: "500",
        currency: "IDR",
        executedAt: "2025-06-01T00:00:00.000Z",
      },
    });

    // Self portfolio: a different dividend amount.
    await app.inject({
      method: "POST",
      url: `/portfolios/${selfPf}/transactions`,
      headers: auth(t),
      payload: {
        type: "buy",
        instrumentId: div.id,
        quantity: "50",
        price: "9000",
        currency: "IDR",
        executedAt: "2025-01-01T00:00:00.000Z",
      },
    });
    await app.inject({
      method: "POST",
      url: `/portfolios/${selfPf}/transactions`,
      headers: auth(t),
      payload: {
        type: "dividend",
        instrumentId: div.id,
        quantity: "0",
        price: "200",
        currency: "IDR",
        executedAt: "2025-06-01T00:00:00.000Z",
      },
    });

    // Unfiltered aggregate = 500 + 200 = 700.
    const allRes = (
      await app.inject({ method: "GET", url: "/networth/income", headers: auth(t) })
    ).json();
    expect(Number(allRes.lifetimeTotal)).toBe(700);

    // Filtered by child holder = 500 only.
    const childRes = (
      await app.inject({
        method: "GET",
        url: `/networth/income?holderId=${childHolder.id}`,
        headers: auth(t),
      })
    ).json();
    expect(childRes.lifetimeTotal).toBe("500");

    // Filtered by self holder = 200 only.
    const selfRes = (
      await app.inject({
        method: "GET",
        url: `/networth/income?holderId=${selfHolder.id}`,
        headers: auth(t),
      })
    ).json();
    expect(selfRes.lifetimeTotal).toBe("200");

    // Unknown holder → 404.
    const bad = await app.inject({
      method: "GET",
      url: "/networth/income?holderId=00000000-0000-0000-0000-000000000000",
      headers: auth(t),
    });
    expect(bad.statusCode).toBe(404);
  });

  it("filters /networth by holderId (net-worth aggregate)", async () => {
    const t = await token("holder-networth");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });

    const holderA = (
      await app.inject({
        method: "POST",
        url: "/account-holders",
        headers: auth(t),
        payload: { name: "Holder A", type: "self" },
      })
    ).json();
    const holderB = (
      await app.inject({
        method: "POST",
        url: "/account-holders",
        headers: auth(t),
        payload: { name: "Holder B", type: "other" },
      })
    ).json();

    // Two portfolios for holderA, one for holderB — all cash-inside so deposits appear.
    const pfA1 = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: {
          name: "A1",
          baseCurrency: "IDR",
          accountHolderId: holderA.id,
          cashCounted: true,
        },
      })
    ).json().id;
    const pfA2 = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: {
          name: "A2",
          baseCurrency: "IDR",
          accountHolderId: holderA.id,
          cashCounted: true,
        },
      })
    ).json().id;
    const pfB = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "B", baseCurrency: "IDR", accountHolderId: holderB.id, cashCounted: true },
      })
    ).json().id;

    // Deposit a known amount into each portfolio so net worth differs by holder.
    await app.inject({
      method: "POST",
      url: `/portfolios/${pfA1}/transactions`,
      headers: auth(t),
      payload: {
        type: "deposit",
        price: "1000",
        currency: "IDR",
        executedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    await app.inject({
      method: "POST",
      url: `/portfolios/${pfA2}/transactions`,
      headers: auth(t),
      payload: {
        type: "deposit",
        price: "2000",
        currency: "IDR",
        executedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    await app.inject({
      method: "POST",
      url: `/portfolios/${pfB}/transactions`,
      headers: auth(t),
      payload: {
        type: "deposit",
        price: "500",
        currency: "IDR",
        executedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    // Aggregate without filter = 1000 + 2000 + 500 = 3500 net worth.
    const allRes = (await app.inject({ method: "GET", url: "/networth", headers: auth(t) })).json();
    expect(Number(allRes.netWorth)).toBe(3500);
    expect(allRes.portfolioCount).toBe(3);

    // Filtered by holderA = 1000 + 2000 = 3000.
    const aRes = (
      await app.inject({ method: "GET", url: `/networth?holderId=${holderA.id}`, headers: auth(t) })
    ).json();
    expect(Number(aRes.netWorth)).toBe(3000);
    expect(aRes.portfolioCount).toBe(2);

    // Filtered by holderB = 500.
    const bRes = (
      await app.inject({ method: "GET", url: `/networth?holderId=${holderB.id}`, headers: auth(t) })
    ).json();
    expect(Number(bRes.netWorth)).toBe(500);
    expect(bRes.portfolioCount).toBe(1);

    // Unknown / other-user holder → 404.
    const bad = await app.inject({
      method: "GET",
      url: "/networth?holderId=00000000-0000-0000-0000-000000000000",
      headers: auth(t),
    });
    expect(bad.statusCode).toBe(404);
    expect(bad.json().error).toBe("holder_not_found");
  });

  it("filters /networth/trades by holderId", async () => {
    const t = await token("holder-trades");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });

    const holderT = (
      await app.inject({
        method: "POST",
        url: "/account-holders",
        headers: auth(t),
        payload: { name: "Trader", type: "self" },
      })
    ).json();

    const [stock] = await app.db
      .insert(instruments)
      .values({
        symbol: "TLKM3",
        market: "IDX",
        assetClass: "equity",
        currency: "IDR",
        name: "Telkom3",
      })
      .returning();

    const pfT = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Trade pf", baseCurrency: "IDR", accountHolderId: holderT.id },
      })
    ).json().id;
    const pfOther = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Other pf", baseCurrency: "IDR" },
      })
    ).json().id;

    // Buy in holderT's portfolio.
    await app.inject({
      method: "POST",
      url: `/portfolios/${pfT}/transactions`,
      headers: auth(t),
      payload: {
        type: "buy",
        instrumentId: stock.id,
        quantity: "10",
        price: "1000",
        currency: "IDR",
        executedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    // Buy in unrelated portfolio.
    await app.inject({
      method: "POST",
      url: `/portfolios/${pfOther}/transactions`,
      headers: auth(t),
      payload: {
        type: "buy",
        instrumentId: stock.id,
        quantity: "5",
        price: "1000",
        currency: "IDR",
        executedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    // Unfiltered = 2 separate trade episodes (one per portfolio), total 15 shares.
    const allTrades = (
      await app.inject({ method: "GET", url: "/networth/trades", headers: auth(t) })
    ).json();
    const allPositions = allTrades.trades.filter(
      (tr: { instrument: { symbol: string } }) => tr.instrument?.symbol === "TLKM3",
    );
    const allQuantity = allPositions.reduce(
      (s: number, tr: { quantity: string }) => s + Number(tr.quantity),
      0,
    );
    expect(allQuantity).toBe(15);

    // Filtered by holderT = only pfT's episode, 10 shares.
    const filteredTrades = (
      await app.inject({
        method: "GET",
        url: `/networth/trades?holderId=${holderT.id}`,
        headers: auth(t),
      })
    ).json();
    const filteredPositions = filteredTrades.trades.filter(
      (tr: { instrument: { symbol: string } }) => tr.instrument?.symbol === "TLKM3",
    );
    const filteredQuantity = filteredPositions.reduce(
      (s: number, tr: { quantity: string }) => s + Number(tr.quantity),
      0,
    );
    expect(filteredQuantity).toBe(10);

    // Unknown holder → 404.
    const bad = await app.inject({
      method: "GET",
      url: "/networth/trades?holderId=00000000-0000-0000-0000-000000000000",
      headers: auth(t),
    });
    expect(bad.statusCode).toBe(404);
    expect(bad.json().error).toBe("holder_not_found");
  });

  it("filters /networth/history by holderId (composes with includeInAggregate)", async () => {
    const t = await token("holder-history");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });

    const holderH = (
      await app.inject({
        method: "POST",
        url: "/account-holders",
        headers: auth(t),
        payload: { name: "History holder", type: "self" },
      })
    ).json();

    // Without snapshots the endpoint just returns []; assert it doesn't 500 and that
    // an unknown holder returns 404 (the filter composes correctly).
    const pfH = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Hist pf", baseCurrency: "IDR", accountHolderId: holderH.id },
      })
    ).json().id;
    expect(pfH).toBeTruthy();

    const res = await app.inject({
      method: "GET",
      url: `/networth/history?holderId=${holderH.id}`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    // No snapshots yet → empty array, not an error.
    expect(res.json()).toEqual([]);

    // Unknown holder → 404.
    const bad = await app.inject({
      method: "GET",
      url: "/networth/history?holderId=00000000-0000-0000-0000-000000000000",
      headers: auth(t),
    });
    expect(bad.statusCode).toBe(404);
    expect(bad.json().error).toBe("holder_not_found");
  });
});
