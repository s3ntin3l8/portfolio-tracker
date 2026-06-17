import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { generateKeyPair, SignJWT } from "jose";
import { instruments, portfolios, screenshotImports } from "@portfolio/db";
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
