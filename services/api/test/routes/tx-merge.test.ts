import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { generateKeyPair, SignJWT, exportJWK } from "jose";
import {
  documents,
  instruments,
  loans,
  transactions,
  transactionSources,
  trResolvedEvents,
  users,
} from "@portfolio/db";
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

describe("merge transactions", () => {
  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    await exportJWK(kp.publicKey);
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    process.env.RATE_LIMIT_MAX = "10000";
    app = await buildApp({ authKey: kp.publicKey });
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

  async function setup(sub: string) {
    const t = await token(sub);
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });
    const created = await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(t),
      payload: { name: "S", baseCurrency: "EUR", cashCounted: true },
    });
    const portfolioId = created.json().id as string;
    const [u] = await app.db.select().from(users).where(eq(users.authSub, sub));
    return { t, portfolioId, userId: u.id };
  }

  async function insertTx(
    portfolioId: string,
    overrides: Partial<typeof transactions.$inferInsert> = {},
  ) {
    const [row] = await app.db
      .insert(transactions)
      .values({
        portfolioId,
        instrumentId: acmeId,
        type: "buy",
        quantity: "10",
        price: "10",
        fees: "0",
        currency: "EUR",
        executedAt: new Date("2026-03-01T00:00:00.000Z"),
        source: "manual",
        ...overrides,
      })
      .returning();
    return row;
  }

  it("merges two rows: rollup picks the higher-rank source regardless of which row survives", async () => {
    const { t, portfolioId } = await setup("merge-user-1");
    const csvTx = await insertTx(portfolioId, { source: "csv", fees: "4.50", tax: null });
    await app.db.insert(transactionSources).values({
      transactionId: csvTx.id,
      sourceType: "csv",
      fees: "4.50",
    });
    const pdfTx = await insertTx(portfolioId, {
      source: "pdf",
      fees: "4.75",
      tax: "0.30",
      venue: "Xetra",
    });
    await app.db.insert(transactionSources).values({
      transactionId: pdfTx.id,
      sourceType: "pdf",
      fees: "4.75",
      tax: "0.30",
      venue: "Xetra",
    });

    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions/merge`,
      headers: auth(t),
      payload: { survivorId: csvTx.id, absorbedId: pdfTx.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ survivorId: csvTx.id });

    const [survivor] = await app.db.select().from(transactions).where(eq(transactions.id, csvTx.id));
    // PDF outranks CSV — its fees/tax/venue win the rollup even though CSV is the survivor.
    expect(survivor.fees).toBe("4.75");
    expect(survivor.tax).toBe("0.30");
    expect(survivor.venue).toBe("Xetra");

    const absorbedGone = await app.db.select().from(transactions).where(eq(transactions.id, pdfTx.id));
    expect(absorbedGone).toHaveLength(0);

    const sourcesNow = await app.db
      .select()
      .from(transactionSources)
      .where(eq(transactionSources.transactionId, csvTx.id));
    expect(sourcesNow.map((s) => s.sourceType).sort()).toEqual(["csv", "pdf"]);
  });

  it("protects a manual entry's hand-set value even though it never had a source row", async () => {
    const { t, portfolioId } = await setup("merge-user-2");
    // Manual entry: no transaction_sources row at all (POST /transactions never writes one).
    const manualTx = await insertTx(portfolioId, { source: "manual", fees: "5.00" });
    const csvTx = await insertTx(portfolioId, { source: "csv", fees: "4.50" });
    await app.db.insert(transactionSources).values({
      transactionId: csvTx.id,
      sourceType: "csv",
      fees: "4.50",
    });

    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions/merge`,
      headers: auth(t),
      payload: { survivorId: manualTx.id, absorbedId: csvTx.id },
    });
    expect(res.statusCode).toBe(200);

    const [survivor] = await app.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, manualTx.id));
    // hasManual protection: the rollup recompute is skipped entirely, so the manual row's
    // own fees are left untouched rather than silently overwritten.
    expect(survivor.fees).toBe("5.00");

    const manualSourceRow = await app.db
      .select()
      .from(transactionSources)
      .where(and(eq(transactionSources.transactionId, manualTx.id), eq(transactionSources.sourceType, "manual")));
    expect(manualSourceRow).toHaveLength(1);
  });

  it("drops a colliding duplicate source row instead of throwing on re-parent", async () => {
    const { t, portfolioId } = await setup("merge-user-3");
    const survivorTx = await insertTx(portfolioId, { source: "pdf" });
    await app.db.insert(transactionSources).values({
      transactionId: survivorTx.id,
      sourceType: "pdf",
      externalId: "tr:exec:shared-1",
    });
    const absorbedTx = await insertTx(portfolioId, { source: "pdf" });
    await app.db.insert(transactionSources).values({
      transactionId: absorbedTx.id,
      sourceType: "pdf",
      externalId: "tr:exec:shared-1",
    });

    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions/merge`,
      headers: auth(t),
      payload: { survivorId: survivorTx.id, absorbedId: absorbedTx.id },
    });
    expect(res.statusCode).toBe(200);

    const sourcesNow = await app.db
      .select()
      .from(transactionSources)
      .where(eq(transactionSources.transactionId, survivorTx.id));
    // The colliding duplicate was dropped, not re-parented — exactly one pdf row remains.
    expect(sourcesNow).toHaveLength(1);
  });

  it("tombstones a pytr-sourced absorbed row so a later sync can't re-create it", async () => {
    const { t, portfolioId } = await setup("merge-user-4");
    const survivorTx = await insertTx(portfolioId, { source: "manual" });
    const absorbedTx = await insertTx(portfolioId, {
      source: "pytr",
      externalId: "tr-event-42",
    });

    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions/merge`,
      headers: auth(t),
      payload: { survivorId: survivorTx.id, absorbedId: absorbedTx.id },
    });
    expect(res.statusCode).toBe(200);

    const [tombstone] = await app.db
      .select()
      .from(trResolvedEvents)
      .where(
        and(
          eq(trResolvedEvents.portfolioId, portfolioId),
          eq(trResolvedEvents.source, "pytr"),
          eq(trResolvedEvents.eventId, "tr-event-42"),
        ),
      );
    expect(tombstone).toMatchObject({ resolution: "confirmed" });
  });

  it("re-parents documents from the absorbed row onto the survivor", async () => {
    const { t, portfolioId, userId } = await setup("merge-user-5");
    const survivorTx = await insertTx(portfolioId, { source: "csv" });
    const absorbedTx = await insertTx(portfolioId, { source: "pdf" });
    const [doc] = await app.db
      .insert(documents)
      .values({
        userId,
        portfolioId,
        transactionId: absorbedTx.id,
        storageKey: "receipts/test/doc.pdf",
        mimeType: "application/pdf",
        status: "retained",
      })
      .returning({ id: documents.id });

    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions/merge`,
      headers: auth(t),
      payload: { survivorId: survivorTx.id, absorbedId: absorbedTx.id },
    });
    expect(res.statusCode).toBe(200);

    const [movedDoc] = await app.db.select().from(documents).where(eq(documents.id, doc.id));
    expect(movedDoc.transactionId).toBe(survivorTx.id);
  });

  it("blocks merging transactions of different instruments", async () => {
    const { t, portfolioId } = await setup("merge-user-6");
    const [other] = await app.db
      .insert(instruments)
      .values({ symbol: "OTHR", market: "XETRA", assetClass: "equity", currency: "EUR", name: "Other" })
      .returning();
    const a = await insertTx(portfolioId, { instrumentId: acmeId });
    const b = await insertTx(portfolioId, { instrumentId: other.id });

    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions/merge`,
      headers: auth(t),
      payload: { survivorId: a.id, absorbedId: b.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("cannot_merge_different_instrument");
  });

  it("blocks merging incompatible types (buy vs sell)", async () => {
    const { t, portfolioId } = await setup("merge-user-7");
    const a = await insertTx(portfolioId, { type: "buy" });
    const b = await insertTx(portfolioId, { type: "sell" });

    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions/merge`,
      headers: auth(t),
      payload: { survivorId: a.id, absorbedId: b.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("cannot_merge_incompatible_type");
  });

  it("allows merging compatible action classes (buy vs savings_plan)", async () => {
    const { t, portfolioId } = await setup("merge-user-7b");
    const a = await insertTx(portfolioId, { type: "buy" });
    const b = await insertTx(portfolioId, { type: "savings_plan" });

    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions/merge`,
      headers: auth(t),
      payload: { survivorId: a.id, absorbedId: b.id },
    });
    expect(res.statusCode).toBe(200);
  });

  it("blocks merging a financed-gold leg (can't split from its loan)", async () => {
    const { t, portfolioId } = await setup("merge-user-8");
    const [loan] = await app.db
      .insert(loans)
      .values({
        portfolioId,
        instrumentId: acmeId,
        purchasePrice: "100",
        principal: "100",
        tenorMonths: 12,
        startDate: "2026-01-01",
      })
      .returning({ id: loans.id });
    const a = await insertTx(portfolioId, { loanId: loan.id });
    const b = await insertTx(portfolioId);

    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions/merge`,
      headers: auth(t),
      payload: { survivorId: a.id, absorbedId: b.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("cannot_merge_loan_linked");
  });

  it("returns 404 for an unknown transaction id or unowned portfolio", async () => {
    const { t, portfolioId } = await setup("merge-user-9");
    const a = await insertTx(portfolioId);
    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions/merge`,
      headers: auth(t),
      payload: { survivorId: a.id, absorbedId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("cannot_merge_not_found");

    const badPortfolio = await app.inject({
      method: "POST",
      url: `/portfolios/00000000-0000-0000-0000-000000000000/transactions/merge`,
      headers: auth(t),
      payload: { survivorId: a.id, absorbedId: a.id },
    });
    expect(badPortfolio.statusCode).toBe(404);
    expect(badPortfolio.json().error).toBe("portfolio_not_found");
  });

  it("merge-preview validates and previews without writing", async () => {
    const { t, portfolioId } = await setup("merge-user-10");
    const a = await insertTx(portfolioId, { source: "csv", fees: "4.50" });
    await app.db.insert(transactionSources).values({
      transactionId: a.id,
      sourceType: "csv",
      fees: "4.50",
    });
    const b = await insertTx(portfolioId, { source: "pdf", fees: "4.75", venue: "Xetra" });
    await app.db.insert(transactionSources).values({
      transactionId: b.id,
      sourceType: "pdf",
      fees: "4.75",
      venue: "Xetra",
    });

    const preview = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions/merge-preview?survivorId=${a.id}&absorbedId=${b.id}`,
      headers: auth(t),
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      ok: true,
      merged: { fees: "4.75", venue: "Xetra" },
    });

    // Nothing was written — both rows still exist untouched.
    const stillTwo = await app.db
      .select()
      .from(transactions)
      .where(eq(transactions.portfolioId, portfolioId));
    expect(stillTwo).toHaveLength(2);

    // Blocked case surfaces a reason instead of a 4xx.
    const [other] = await app.db
      .insert(instruments)
      .values({ symbol: "PVOT", market: "XETRA", assetClass: "equity", currency: "EUR", name: "Pivot" })
      .returning();
    const c = await insertTx(portfolioId, { instrumentId: other.id });
    const blocked = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions/merge-preview?survivorId=${a.id}&absorbedId=${c.id}`,
      headers: auth(t),
    });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json()).toMatchObject({ ok: false, blockedReason: "different_instrument" });
  });
});
