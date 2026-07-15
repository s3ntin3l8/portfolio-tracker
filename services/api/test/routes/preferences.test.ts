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
    // No-op safety: a user with no prefs row at all must see the exact same defaults
    // as before this change — German tax + purchase_price cost basis, unchanged.
    expect(body.costBasisMode).toBe("purchase_price");
    expect(body.taxRegime).toBe("DE");
  });

  it("PUT /me/preferences upserts costBasisMode and taxRegime independently", async () => {
    const t = await token("prefs-user-investing-1");

    const put1 = await app.inject({
      method: "PUT",
      url: "/me/preferences",
      headers: auth(t),
      payload: { taxRegime: "ID" },
    });
    expect(put1.statusCode).toBe(200);
    expect(put1.json().taxRegime).toBe("ID");
    // Unspecified costBasisMode falls back to the default, not clobbered/undefined.
    expect(put1.json().costBasisMode).toBe("purchase_price");

    const put2 = await app.inject({
      method: "PUT",
      url: "/me/preferences",
      headers: auth(t),
      payload: { costBasisMode: "total_paid" },
    });
    expect(put2.statusCode).toBe(200);
    expect(put2.json().costBasisMode).toBe("total_paid");
    // taxRegime from the first PUT must survive this second, unrelated PUT.
    expect(put2.json().taxRegime).toBe("ID");

    const get = await app.inject({
      method: "GET",
      url: "/me/preferences",
      headers: auth(t),
    });
    expect(get.json().costBasisMode).toBe("total_paid");
    expect(get.json().taxRegime).toBe("ID");
  });

  it("PUT /me/preferences rejects an invalid taxRegime", async () => {
    const t = await token("prefs-user-bad-regime");
    const res = await app.inject({
      method: "PUT",
      url: "/me/preferences",
      headers: auth(t),
      payload: { taxRegime: "US" },
    });
    expect(res.statusCode).toBe(400);
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

  it("PUT /me/preferences sets and clears benchmarkSymbol and riskFreeRate", async () => {
    const t = await token("prefs-user-benchmark-1");

    const get0 = await app.inject({
      method: "GET",
      url: "/me/preferences",
      headers: auth(t),
    });
    expect(get0.statusCode).toBe(200);
    expect(get0.json().benchmarkSymbol).toBeNull();
    expect(get0.json().riskFreeRate).toBeNull();

    const put1 = await app.inject({
      method: "PUT",
      url: "/me/preferences",
      headers: auth(t),
      payload: { benchmarkSymbol: "^GSPC", riskFreeRate: 0.05 },
    });
    expect(put1.statusCode).toBe(200);
    expect(put1.json().benchmarkSymbol).toBe("^GSPC");
    expect(put1.json().riskFreeRate).toBe(0.05);

    const get1 = await app.inject({
      method: "GET",
      url: "/me/preferences",
      headers: auth(t),
    });
    expect(get1.json().benchmarkSymbol).toBe("^GSPC");
    expect(get1.json().riskFreeRate).toBe(0.05);

    const put2 = await app.inject({
      method: "PUT",
      url: "/me/preferences",
      headers: auth(t),
      payload: { benchmarkSymbol: null, riskFreeRate: null },
    });
    expect(put2.statusCode).toBe(200);
    expect(put2.json().benchmarkSymbol).toBeNull();
    expect(put2.json().riskFreeRate).toBeNull();

    const get2 = await app.inject({
      method: "GET",
      url: "/me/preferences",
      headers: auth(t),
    });
    expect(get2.json().benchmarkSymbol).toBeNull();
    expect(get2.json().riskFreeRate).toBeNull();
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
