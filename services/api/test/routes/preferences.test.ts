import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

const ISSUER = "https://auth.test/application/o/portfolio/";
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

describe("preferences", () => {
  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
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

  it("GET /me/preferences returns defaults on first call", async () => {
    const t = await token("prefs-user-1");
    const res = await app.inject({
      method: "GET",
      url: "/me/preferences",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dashboardPeriod).toBe("max");
    expect(body.dashboardKpis).toBeNull();
  });

  it("PUT /me/preferences upserts and GET returns updated values", async () => {
    const t = await token("prefs-user-2");

    // Set preferences
    const put = await app.inject({
      method: "PUT",
      url: "/me/preferences",
      headers: auth(t),
      payload: { dashboardPeriod: "1y", dashboardKpis: ["netWorth", "xirr"] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().dashboardPeriod).toBe("1y");
    expect(put.json().dashboardKpis).toEqual(["netWorth", "xirr"]);

    // GET should reflect the update
    const get = await app.inject({
      method: "GET",
      url: "/me/preferences",
      headers: auth(t),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().dashboardPeriod).toBe("1y");
    expect(get.json().dashboardKpis).toEqual(["netWorth", "xirr"]);
  });

  it("PUT /me/preferences second call updates without clobbering unspecified fields", async () => {
    const t = await token("prefs-user-3");

    // First PUT: set period and kpis
    await app.inject({
      method: "PUT",
      url: "/me/preferences",
      headers: auth(t),
      payload: { dashboardPeriod: "5y", dashboardKpis: ["netWorth"] },
    });

    // Second PUT: update only kpis
    const put2 = await app.inject({
      method: "PUT",
      url: "/me/preferences",
      headers: auth(t),
      payload: { dashboardKpis: ["netWorth", "cash"] },
    });
    expect(put2.statusCode).toBe(200);
    expect(put2.json().dashboardKpis).toEqual(["netWorth", "cash"]);
  });

  it("GET /networth?period=ytd response includes period field", async () => {
    const t = await token("prefs-nw-user");
    const res = await app.inject({
      method: "GET",
      url: "/networth?period=ytd",
      headers: auth(t),
    });
    // Should return 200 even with no portfolios (returns empty data)
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.period).toBe("ytd");
  });

  it("GET /networth without period defaults to max", async () => {
    const t = await token("prefs-nw-user-2");
    const res = await app.inject({
      method: "GET",
      url: "/networth",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.period).toBe("max");
  });

  it("PUT /me/preferences rejects invalid period", async () => {
    const t = await token("prefs-user-bad");
    const res = await app.inject({
      method: "PUT",
      url: "/me/preferences",
      headers: auth(t),
      payload: { dashboardPeriod: "10y" },
    });
    expect(res.statusCode).toBe(400);
  });
});
