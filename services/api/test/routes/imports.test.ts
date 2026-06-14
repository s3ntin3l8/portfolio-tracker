import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT, type KeyLike } from "jose";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

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
