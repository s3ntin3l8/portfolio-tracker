import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT, type KeyLike } from "jose";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import type { ParsedTransaction } from "@portfolio/schema";
import type { ScreenshotParser } from "../../src/services/parsers/types.js";

// Mock parser so the screenshot flow is hermetic (no Anthropic/Gemini/OpenRouter call).
function mockParser(
  drafts: ParsedTransaction[],
  configured = true,
): ScreenshotParser {
  return {
    name: "mock",
    isConfigured: () => configured,
    parse: async () => drafts,
  };
}

const GOLD_DRAFT = {
  assetClass: "gold",
  action: "buy",
  name: "Antam Gold",
  quantity: "5",
  unit: "grams",
  price: "1150000",
  fees: "0",
  currency: "IDR",
  executedAt: new Date("2026-02-08T00:00:00.000Z"),
  confidence: 0.9,
} satisfies ParsedTransaction;

const ISSUER = "https://auth.test/o/p/";
const AUDIENCE = "portfolio-tracker";

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
let privateKey: KeyLike;

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

const CSV = `date,action,assetClass,ticker,name,quantity,unit,price,fees,currency
2026-01-15,buy,equity,BBCA,Bank Central Asia,100,shares,9500,0,IDR`;

describe("CSV import → confirm flow", () => {
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

  it("imports drafts, confirms to transactions, and 409s on re-confirm", async () => {
    const t = await token("imp-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "BCA", baseCurrency: "IDR" },
      })
    ).json().id;

    const imp = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/imports/csv`,
      headers: auth(t),
      payload: { content: CSV },
    });
    expect(imp.statusCode).toBe(201);
    const { importId, drafts } = imp.json();
    expect(drafts).toHaveLength(1);

    const got = await app.inject({
      method: "GET",
      url: `/imports/${importId}`,
      headers: auth(t),
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().status).toBe("draft");

    const confirm = await app.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(t),
      payload: { transactions: drafts },
    });
    expect(confirm.statusCode).toBe(201);
    expect(confirm.json().confirmed).toBe(1);

    const holdings = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/holdings`,
      headers: auth(t),
    });
    expect(holdings.json()).toHaveLength(1);

    const again = await app.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(t),
      payload: { transactions: drafts },
    });
    expect(again.statusCode).toBe(409);
  });

  it("rejects importing into another user's portfolio", async () => {
    const tA = await token("imp-a");
    const tB = await token("imp-b");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(tA),
        payload: { name: "A" },
      })
    ).json().id;

    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/imports/csv`,
      headers: auth(tB),
      payload: { content: CSV },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("screenshot import → confirm flow", () => {
  let ssApp: App;
  let ssKey: KeyLike;

  async function ssToken(sub: string) {
    return new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(ssKey);
  }

  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    ssKey = kp.privateKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    ssApp = await buildApp({
      authKey: kp.publicKey,
      screenshotParser: mockParser([GOLD_DRAFT]),
    });
  });

  afterAll(async () => {
    await ssApp.close();
    await closeDb();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
  });

  it("parses a screenshot into a draft, confirms it, and records source=screenshot", async () => {
    const t = await ssToken("ss-user");
    const portfolioId = (
      await ssApp.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Gold", baseCurrency: "IDR" },
      })
    ).json().id;

    const imp = await ssApp.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/imports/screenshot`,
      headers: auth(t),
      payload: { image: Buffer.from("fake-png").toString("base64"), mimeType: "image/png" },
    });
    expect(imp.statusCode).toBe(201);
    const { importId, drafts } = imp.json();
    expect(drafts).toHaveLength(1);
    expect(drafts[0].assetClass).toBe("gold");

    const confirm = await ssApp.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(t),
      payload: { transactions: drafts },
    });
    expect(confirm.statusCode).toBe(201);
    expect(confirm.json().confirmed).toBe(1);
    expect(confirm.json().transactions[0].source).toBe("screenshot");
  });

  it("503s when the configured parser has no key", async () => {
    const kp = await generateKeyPair("ES256");
    const inertApp = await buildApp({
      authKey: kp.publicKey,
      screenshotParser: mockParser([], false),
    });
    const t = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("ss-inert")
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(kp.privateKey);

    const portfolioId = (
      await inertApp.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "P", baseCurrency: "IDR" },
      })
    ).json().id;

    const res = await inertApp.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/imports/screenshot`,
      headers: auth(t),
      payload: { image: "abc" },
    });
    expect(res.statusCode).toBe(503);
    await inertApp.close();
  });
});
