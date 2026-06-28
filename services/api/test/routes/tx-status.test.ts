import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { generateKeyPair, SignJWT, exportJWK } from "jose";
import { instruments, loans, screenshotImports, transactions, trResolvedEvents, users } from "@portfolio/db";
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

  // Insert a sync-style draft transaction directly (sync is what creates these).
  async function addDraftBuy(portfolioId: string, externalId: string, qty: string) {
    const [row] = await app.db
      .insert(transactions)
      .values({
        portfolioId,
        instrumentId: acmeId,
        type: "buy",
        quantity: qty,
        price: "10",
        currency: "EUR",
        executedAt: new Date("2026-02-01T00:00:00.000Z"),
        source: "pytr",
        externalId,
        status: "draft",
      })
      .returning({ id: transactions.id });
    return row.id;
  }

  it("draft transactions are excluded from holdings until confirmed", async () => {
    const { t, portfolioId } = await setup();
    const draftId = await addDraftBuy(portfolioId, "ev-confirm-1", "7");

    // Draft is listed (so the table can show it) but excluded from derived holdings.
    const list = await app.inject({ method: "GET", url: `/portfolios/${portfolioId}/transactions`, headers: auth(t) });
    expect(list.json().find((r: { id: string }) => r.id === draftId).status).toBe("draft");
    const before = await app.inject({ method: "GET", url: `/portfolios/${portfolioId}/holdings`, headers: auth(t) });
    expect(before.json().holdings).toHaveLength(0);

    // Confirm → normal; now it counts, and the durable ledger records it.
    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions/resolve-drafts`,
      headers: auth(t),
      payload: { ids: [draftId], action: "confirm" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().updated).toBe(1);

    const after = await app.inject({ method: "GET", url: `/portfolios/${portfolioId}/holdings`, headers: auth(t) });
    expect(after.json().holdings).toHaveLength(1);
    expect(after.json().holdings[0].quantity).toBe("7");

    const ledger = await app.db
      .select()
      .from(trResolvedEvents)
      .where(and(eq(trResolvedEvents.portfolioId, portfolioId), eq(trResolvedEvents.eventId, "ev-confirm-1")));
    expect(ledger[0]?.resolution).toBe("confirmed");
  });

  it("discarding a draft archives it (stays excluded) and records the ledger", async () => {
    const { t, portfolioId } = await setup();
    const draftId = await addDraftBuy(portfolioId, "ev-discard-1", "3");

    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions/resolve-drafts`,
      headers: auth(t),
      payload: { ids: [draftId], action: "discard" },
    });
    expect(res.json().updated).toBe(1);

    // Row is archived (kept + visible), still excluded from holdings.
    const list = await app.inject({ method: "GET", url: `/portfolios/${portfolioId}/transactions`, headers: auth(t) });
    expect(list.json().find((r: { id: string }) => r.id === draftId).status).toBe("archived");
    const holdings = await app.inject({ method: "GET", url: `/portfolios/${portfolioId}/holdings`, headers: auth(t) });
    expect(holdings.json().holdings).toHaveLength(0);

    const ledger = await app.db
      .select()
      .from(trResolvedEvents)
      .where(and(eq(trResolvedEvents.portfolioId, portfolioId), eq(trResolvedEvents.eventId, "ev-discard-1")));
    expect(ledger[0]?.resolution).toBe("discarded");
  });

  it("resolve-drafts only touches draft rows and ignores non-draft ids", async () => {
    const { t, portfolioId, addBuy } = await setup();
    const normalId = await addBuy("1", "10"); // status 'normal'
    const draftId = await addDraftBuy(portfolioId, "ev-mixed-1", "2");

    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions/resolve-drafts`,
      headers: auth(t),
      payload: { ids: [normalId, draftId], action: "confirm" },
    });
    // Only the draft row was updated; the already-normal row is untouched.
    expect(res.json().updated).toBe(1);
  });

  // ── Reassignment ──────────────────────────────────────────────────────────
  async function newPortfolio(t: string, name: string) {
    return (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name, baseCurrency: "EUR", cashCounted: true },
      })
    ).json().id as string;
  }

  it("reassigns a transaction to another portfolio (holdings move with it)", async () => {
    const { t, portfolioId: a, addBuy } = await setup();
    const b = await newPortfolio(t, "Dest");
    const txId = await addBuy("10", "10");

    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${a}/transactions/reassign`,
      headers: auth(t),
      payload: { ids: [txId], targetPortfolioId: b },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ moved: 1, skippedConflicts: 0, skippedLoans: 0 });

    const aH = await app.inject({ method: "GET", url: `/portfolios/${a}/holdings`, headers: auth(t) });
    expect(aH.json().holdings).toHaveLength(0);
    const bH = await app.inject({ method: "GET", url: `/portfolios/${b}/holdings`, headers: auth(t) });
    expect(bH.json().holdings).toHaveLength(1);
    expect(bH.json().holdings[0].quantity).toBe("10");
  });

  it("reassign rejects moving to the same portfolio", async () => {
    const { t, portfolioId: a, addBuy } = await setup();
    const txId = await addBuy("1", "10");
    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${a}/transactions/reassign`,
      headers: auth(t),
      payload: { ids: [txId], targetPortfolioId: a },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("same_portfolio");
  });

  it("reassign skips a row whose (source, externalId) already exists in the target", async () => {
    const { t, portfolioId: a } = await setup();
    const b = await newPortfolio(t, "Dest2");
    // Same economic identity exists in both: moving A's row into B would hit the dedup index.
    const aRow = await addDraftBuy(a, "ev-collide", "5");
    await addDraftBuy(b, "ev-collide", "5");

    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${a}/transactions/reassign`,
      headers: auth(t),
      payload: { ids: [aRow], targetPortfolioId: b },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ moved: 0, skippedConflicts: 1 });
    // The row stays in A (not moved, not crashed on).
    const aList = await app.inject({ method: "GET", url: `/portfolios/${a}/transactions`, headers: auth(t) });
    expect(aList.json().find((r: { id: string }) => r.id === aRow)).toBeTruthy();
  });

  it("reassigns every transaction an import wrote to another portfolio", async () => {
    const { t, portfolioId: a } = await setup();
    const b = await newPortfolio(t, "Dest3");
    const [u] = await app.db.select().from(users).where(eq(users.authSub, "status-user"));
    const [imp] = await app.db
      .insert(screenshotImports)
      .values({ userId: u.id, parser: "csv", status: "confirmed", parsedJson: {} })
      .returning({ id: screenshotImports.id });
    // Two rows from this import live in A.
    for (const ext of ["imp-r-1", "imp-r-2"]) {
      await app.db.insert(transactions).values({
        portfolioId: a,
        instrumentId: acmeId,
        type: "buy",
        quantity: "2",
        price: "10",
        currency: "EUR",
        executedAt: new Date("2026-03-01T00:00:00.000Z"),
        source: "csv",
        externalId: ext,
        importId: imp.id,
        status: "draft",
      });
    }

    const res = await app.inject({
      method: "POST",
      url: `/imports/${imp.id}/reassign`,
      headers: auth(t),
      payload: { targetPortfolioId: b },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().moved).toBe(2);

    const bList = await app.inject({ method: "GET", url: `/portfolios/${b}/transactions`, headers: auth(t) });
    expect(bList.json().filter((r: { importId: string }) => r.importId === imp.id)).toHaveLength(2);
  });

  it("reassign returns 404 when the target portfolio isn't owned, and for an unknown import", async () => {
    const { t, portfolioId: a, addBuy } = await setup();
    const txId = await addBuy("1", "10");
    const badTarget = await app.inject({
      method: "POST",
      url: `/portfolios/${a}/transactions/reassign`,
      headers: auth(t),
      payload: { ids: [txId], targetPortfolioId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(badTarget.statusCode).toBe(404);

    const badImport = await app.inject({
      method: "POST",
      url: `/imports/00000000-0000-0000-0000-000000000000/reassign`,
      headers: auth(t),
      payload: { targetPortfolioId: a },
    });
    expect(badImport.statusCode).toBe(404);
  });

  it("reassign skips financed-gold legs (can't split a leg from its loan)", async () => {
    const { t, portfolioId: a } = await setup();
    const b = await newPortfolio(t, "Dest4");
    const [loan] = await app.db
      .insert(loans)
      .values({
        portfolioId: a,
        instrumentId: acmeId,
        purchasePrice: "100",
        principal: "100",
        tenorMonths: 12,
        startDate: "2026-01-01",
      })
      .returning({ id: loans.id });
    const [leg] = await app.db
      .insert(transactions)
      .values({
        portfolioId: a,
        instrumentId: acmeId,
        type: "buy",
        quantity: "1",
        price: "100",
        currency: "EUR",
        executedAt: new Date("2026-01-01T00:00:00.000Z"),
        source: "screenshot",
        loanId: loan.id,
        status: "normal",
      })
      .returning({ id: transactions.id });

    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${a}/transactions/reassign`,
      headers: auth(t),
      payload: { ids: [leg.id], targetPortfolioId: b },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ moved: 0, skippedLoans: 1 });
  });
});
