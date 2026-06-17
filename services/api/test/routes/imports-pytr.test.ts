import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { generateKeyPair, SignJWT } from "jose";
import { instruments, portfolios, screenshotImports, trResolvedEvents } from "@portfolio/db";
import type { ParsedTransaction } from "@portfolio/schema";
import { buildApp } from "../../src/app.js";
import { getDb, closeDb } from "../../src/db/client.js";

const ISSUER = "https://auth.test/o/p/";
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

// pytr drafts: a security buy (has ISIN) and a pure-cash deposit (no instrument).
const DRAFTS: ParsedTransaction[] = [
  {
    assetClass: "equity",
    action: "buy",
    isin: "DE0007236101",
    name: "Siemens",
    quantity: "10",
    unit: "shares",
    price: "100",
    fees: "0",
    currency: "EUR",
    executedAt: new Date("2026-03-01T10:00:00.000Z"),
    confidence: 1,
    externalId: "tr-1",
  },
  {
    assetClass: "equity",
    action: "deposit",
    isin: null,
    name: "Deposit",
    quantity: "0",
    unit: "shares",
    price: "500",
    fees: "0",
    currency: "EUR",
    executedAt: new Date("2026-03-02T10:00:00.000Z"),
    confidence: 1,
    externalId: "tr-2",
  },
];

async function stagePytrImport(portfolioId: string, userId: string): Promise<string> {
  const [imp] = await getDb()
    .insert(screenshotImports)
    .values({
      userId,
      portfolioId,
      parser: "pytr",
      parsedJson: { drafts: DRAFTS, errors: [] },
      status: "draft",
    })
    .returning();
  return imp.id;
}

describe("pytr import → confirm", () => {
  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
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

  it("confirms with source=pytr, event-id externalIds, and null instrument for cash", async () => {
    const t = await token("pytr-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "TR", baseCurrency: "EUR" },
      })
    ).json().id;
    const [pf] = await getDb()
      .select()
      .from(portfolios)
      .where(eq(portfolios.id, portfolioId));

    const importId = await stagePytrImport(portfolioId, pf.userId);
    const confirm = await app.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(t),
      payload: { transactions: DRAFTS },
    });
    expect(confirm.statusCode).toBe(201);
    const { confirmed, transactions } = confirm.json();
    expect(confirmed).toBe(2);

    const buy = transactions.find((x: { externalId: string }) => x.externalId === "tr-1");
    const deposit = transactions.find(
      (x: { externalId: string }) => x.externalId === "tr-2",
    );
    expect(buy).toMatchObject({ source: "pytr", type: "buy" });
    expect(buy.instrumentId).toBeTruthy();
    expect(deposit).toMatchObject({ source: "pytr", type: "deposit" });
    expect(deposit.instrumentId).toBeNull();
  });

  // Stage + confirm one security draft for a fresh TR portfolio, returning the stored instrument.
  async function confirmDraftInstrument(t: string, draft: ParsedTransaction) {
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "TR", baseCurrency: "EUR" },
      })
    ).json().id;
    const [pf] = await getDb()
      .select()
      .from(portfolios)
      .where(eq(portfolios.id, portfolioId));
    const [imp] = await getDb()
      .insert(screenshotImports)
      .values({
        userId: pf.userId,
        portfolioId,
        parser: "pytr",
        parsedJson: { drafts: [draft], errors: [] },
        status: "draft",
      })
      .returning();
    const confirm = await app.inject({
      method: "POST",
      url: `/imports/${imp.id}/confirm`,
      headers: auth(t),
      payload: { transactions: [draft] },
    });
    expect(confirm.statusCode).toBe(201);
    const instrumentId = confirm.json().transactions[0].instrumentId as string;
    const [inst] = await getDb()
      .select()
      .from(instruments)
      .where(eq(instruments.id, instrumentId));
    return inst;
  }

  const securityDraft = (over: Partial<ParsedTransaction>): ParsedTransaction => ({
    assetClass: "equity",
    action: "buy",
    isin: null,
    name: "Security",
    quantity: "1",
    unit: "shares",
    price: "100",
    fees: "0",
    currency: "EUR",
    executedAt: new Date("2026-03-01T10:00:00.000Z"),
    confidence: 1,
    externalId: "x",
    ...over,
  });

  it("routes a TR crypto ISIN (XF000…) to CoinGecko: crypto/CRYPTO, EUR", async () => {
    const inst = await confirmDraftInstrument(
      await token("tr-btc"),
      securityDraft({ isin: "XF000BTC0017", name: "Bitcoin", externalId: "btc-1" }),
    );
    expect(inst).toMatchObject({
      symbol: "BTC",
      market: "CRYPTO",
      assetClass: "crypto",
      currency: "EUR",
    });
  });

  it("adopts the US venue/currency for a US stock resolved off the Xetra default", async () => {
    const inst = await confirmDraftInstrument(
      await token("tr-us"),
      securityDraft({ isin: "US7561091049", name: "Realty Income", externalId: "o-1" }),
    );
    expect(inst).toMatchObject({ symbol: "O", market: "US", currency: "USD" });
  });

  it("keeps an unresolved EU ISIN pinned to the broker's Xetra/EUR default", async () => {
    const inst = await confirmDraftInstrument(
      await token("tr-eu"),
      securityDraft({ isin: "IE00BK5BQT80", name: "Vanguard FTSE All-World", externalId: "vwce-1" }),
    );
    expect(inst).toMatchObject({ market: "XETRA", currency: "EUR" });
  });

  it("persists detail enrichment (tax, executedPrice, fxRate, kind, docs) on the transaction", async () => {
    const t = await token("pytr-enrich");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "TR", baseCurrency: "EUR" },
      })
    ).json().id;
    const [pf] = await getDb().select().from(portfolios).where(eq(portfolios.id, portfolioId));
    const [imp] = await getDb()
      .insert(screenshotImports)
      .values({
        userId: pf.userId,
        portfolioId,
        parser: "pytr",
        parsedJson: {
          drafts: [
            {
              ...DRAFTS[0],
              externalId: "enrich-1",
              tax: "2.31",
              executedPrice: "142.76",
              fxRate: "0.8449",
              venue: "LS Exchange",
              kind: "saveback",
              description: "ACME · DE12",
              documentRefs: [{ id: "d1", type: "TRADE_INVOICE", date: "01.03.2026" }],
            },
          ],
          errors: [],
        },
        status: "draft",
      })
      .returning();

    const confirm = await app.inject({
      method: "POST",
      url: `/imports/${imp.id}/confirm`,
      headers: auth(t),
      payload: {
        transactions: [
          {
            ...DRAFTS[0],
            externalId: "enrich-1",
            tax: "2.31",
            executedPrice: "142.76",
            fxRate: "0.8449",
            venue: "LS Exchange",
            kind: "saveback",
            description: "ACME · DE12",
            documentRefs: [{ id: "d1", type: "TRADE_INVOICE", date: "01.03.2026" }],
          },
        ],
      },
    });
    expect(confirm.statusCode).toBe(201);
    const tx = confirm.json().transactions[0];
    expect(tx).toMatchObject({
      tax: "2.31",
      executedPrice: "142.76",
      fxRate: "0.8449",
      venue: "LS Exchange",
      kind: "saveback",
      description: "ACME · DE12",
    });
    expect(tx.documentRefs).toEqual([{ id: "d1", type: "TRADE_INVOICE", date: "01.03.2026" }]);
  });

  it("discarding a pytr draft records its events as resolved (won't resurface)", async () => {
    const t = await token("pytr-discard");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "TR", baseCurrency: "EUR" },
      })
    ).json().id;
    const [pf] = await getDb().select().from(portfolios).where(eq(portfolios.id, portfolioId));
    const importId = await stagePytrImport(portfolioId, pf.userId);

    const res = await app.inject({
      method: "POST",
      url: `/imports/${importId}/discard`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(204);

    const resolved = await getDb()
      .select()
      .from(trResolvedEvents)
      .where(eq(trResolvedEvents.portfolioId, portfolioId));
    expect(resolved.map((r) => r.eventId).sort()).toEqual(["tr-1", "tr-2"]);
    expect(resolved.every((r) => r.resolution === "discarded")).toBe(true);
  });

  it("drops a mapped issue from the import once its event is confirmed", async () => {
    const t = await token("pytr-mapissue");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "TR", baseCurrency: "EUR" },
      })
    ).json().id;
    const [pf] = await getDb().select().from(portfolios).where(eq(portfolios.id, portfolioId));
    // One draft + one attention issue (an unmapped event the user will complete).
    const [imp] = await getDb()
      .insert(screenshotImports)
      .values({
        userId: pf.userId,
        portfolioId,
        parser: "pytr",
        parsedJson: {
          drafts: [DRAFTS[0]],
          errors: [
            { eventId: "iss-1", eventType: "MYSTERY", severity: "attention", message: "unmapped event type: MYSTERY" },
          ],
        },
        status: "draft",
      })
      .returning();

    // Confirm both the original draft and the mapped issue (externalId = the event id).
    await app.inject({
      method: "POST",
      url: `/imports/${imp.id}/confirm`,
      headers: auth(t),
      payload: {
        transactions: [
          DRAFTS[0],
          { ...DRAFTS[0], externalId: "iss-1", action: "deposit", isin: null, name: "Mapped" },
        ],
      },
    });

    // Everything is resolved → the import closes (no drafts, no issues left).
    const [done] = await getDb()
      .select()
      .from(screenshotImports)
      .where(eq(screenshotImports.id, imp.id));
    expect(done.status).toBe("confirmed");
  });

  it("partial confirm keeps the import open with the un-confirmed remainder", async () => {
    const t = await token("pytr-passes");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "TR", baseCurrency: "EUR" },
      })
    ).json().id;
    const [pf] = await getDb()
      .select()
      .from(portfolios)
      .where(eq(portfolios.id, portfolioId));
    const importId = await stagePytrImport(portfolioId, pf.userId);

    // Confirm only the first draft (tr-1).
    const first = await app.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(t),
      payload: { transactions: [DRAFTS[0]] },
    });
    expect(first.json().confirmed).toBe(1);

    // The import stays a draft, now holding only the un-confirmed remainder (tr-2).
    const [mid] = await getDb()
      .select()
      .from(screenshotImports)
      .where(eq(screenshotImports.id, importId));
    expect(mid.status).toBe("draft");
    expect((mid.parsedJson as { drafts: { externalId: string }[] }).drafts.map((d) => d.externalId)).toEqual(["tr-2"]);

    // Confirm the rest → the import closes.
    const second = await app.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(t),
      payload: { transactions: [DRAFTS[1]] },
    });
    expect(second.json().confirmed).toBe(1);
    const [done] = await getDb()
      .select()
      .from(screenshotImports)
      .where(eq(screenshotImports.id, importId));
    expect(done.status).toBe("confirmed");
  });

  it("is idempotent: a re-synced import with the same event ids inserts nothing new", async () => {
    const t = await token("pytr-idem");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "TR", baseCurrency: "EUR" },
      })
    ).json().id;
    const [pf] = await getDb()
      .select()
      .from(portfolios)
      .where(eq(portfolios.id, portfolioId));

    const first = await app.inject({
      method: "POST",
      url: `/imports/${await stagePytrImport(portfolioId, pf.userId)}/confirm`,
      headers: auth(t),
      payload: { transactions: DRAFTS },
    });
    expect(first.json().confirmed).toBe(2);

    // A second import (e.g. next hourly sync) carrying the same TR event ids.
    const second = await app.inject({
      method: "POST",
      url: `/imports/${await stagePytrImport(portfolioId, pf.userId)}/confirm`,
      headers: auth(t),
      payload: { transactions: DRAFTS },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().confirmed).toBe(0); // dedup index skips the duplicates
  });
});
