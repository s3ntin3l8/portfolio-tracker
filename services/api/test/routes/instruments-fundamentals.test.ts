/**
 * Route tests for GET /instruments/:id/fundamentals (issue #143).
 *
 * Contract:
 *  - 404 for an unknown instrument id
 *  - null (no fetch) for asset classes fundamentals aren't meaningful for
 *  - cache miss: fetches live via the market-data service, persists, returns the result
 *  - cache hit (fresh `fundamentalsCheckedAt`): serves the cached blob, never calls the provider
 *  - provider returns null OR throws (MarketDataService.getFundamentals() swallows a
 *    per-provider exception and returns null — same convention as getQuote/getProfile/etc.,
 *    so the two are indistinguishable at the route): bumps `fundamentalsCheckedAt` but does
 *    NOT wipe a previously-good cached blob
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { generateKeyPair, SignJWT } from "jose";
import {
  MarketDataService,
  type InstrumentFundamentals,
  type MarketDataProvider,
} from "@portfolio/market-data";
import { buildApp } from "../../src/app.js";
import { closeDb, getDb } from "../../src/db/client.js";
import { instruments } from "@portfolio/db";
import { overrideMarketData, invalidateMarketData } from "../../src/services/market-data.js";

const ISSUER = "https://auth.test/application/o/portfolio/";
const AUDIENCE = "portfolio-tracker";
type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let privateKey: CryptoKey;

beforeAll(async () => {
  const kp = await generateKeyPair("ES256");
  privateKey = kp.privateKey;
  process.env.AUTHENTIK_ISSUER = ISSUER;
  process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
  process.env.RATE_LIMIT_MAX = "50000";
  app = await buildApp({ authKey: kp.publicKey });
}, 30_000);

afterAll(async () => {
  await app.close();
  await closeDb();
  delete process.env.AUTHENTIK_ISSUER;
  delete process.env.AUTHENTIK_AUDIENCE;
  delete process.env.RATE_LIMIT_MAX;
});

// Every test overrides the cached market-data service with a fake provider — reset after
// each so it doesn't bleed into a later test in this file.
afterEach(() => {
  invalidateMarketData();
});

async function makeToken(sub: string) {
  return new SignJWT({ email: `${sub}@test.example` })
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

let uidSuffix = 0;
async function setupUser() {
  const t = await makeToken(`fund-rt-${++uidSuffix}`);
  await app.inject({ method: "GET", url: "/me", headers: auth(t) });
  return t;
}

let symSuffix = 0;
async function insertInstrument(overrides: Partial<typeof instruments.$inferInsert> = {}) {
  const db = getDb();
  const [inst] = await db
    .insert(instruments)
    .values({
      symbol: `FUND${++symSuffix}`,
      market: "US",
      assetClass: "equity",
      unit: "shares",
      currency: "USD",
      name: "Test Co",
      ...overrides,
    })
    .returning();
  return inst;
}

const FAKE_FUNDAMENTALS: InstrumentFundamentals = {
  currency: "USD",
  asOf: new Date().toISOString(),
  marketCap: "1000000000",
  trailingPE: 20.5,
};

/** A minimal MarketDataProvider stub — `supports` always true, `getFundamentals` returns
 *  a fixed result (or throws, or records whether it was ever called). */
function stubProvider(opts: {
  result?: InstrumentFundamentals | null;
  throws?: boolean;
  onCall?: () => void;
}): MarketDataProvider {
  return {
    name: "stub",
    supports: () => true,
    getQuote: async () => null,
    getFundamentals: async () => {
      opts.onCall?.();
      if (opts.throws) throw new Error("provider unreachable");
      return opts.result ?? null;
    },
  };
}

describe("GET /instruments/:id/fundamentals", () => {
  it("404s for an unknown instrument", async () => {
    const t = await setupUser();
    const res = await app.inject({
      method: "GET",
      url: "/instruments/00000000-0000-0000-0000-000000000001/fundamentals",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns null without ever calling the provider for an unsupported asset class", async () => {
    const t = await setupUser();
    const inst = await insertInstrument({ assetClass: "gold", symbol: "XAUFUND", market: "XAU" });
    let called = false;
    overrideMarketData(
      new MarketDataService([
        stubProvider({ result: FAKE_FUNDAMENTALS, onCall: () => (called = true) }),
      ]),
    );

    const res = await app.inject({
      method: "GET",
      url: `/instruments/${inst.id}/fundamentals`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
    expect(called).toBe(false);
  });

  it("fetches live, persists, and returns fundamentals on a cache miss", async () => {
    const t = await setupUser();
    const inst = await insertInstrument();
    overrideMarketData(new MarketDataService([stubProvider({ result: FAKE_FUNDAMENTALS })]));

    const res = await app.inject({
      method: "GET",
      url: `/instruments/${inst.id}/fundamentals`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ marketCap: "1000000000", trailingPE: 20.5 });

    const db = getDb();
    const [row] = await db.select().from(instruments).where(eq(instruments.id, inst.id)).limit(1);
    expect(row.fundamentalsCheckedAt).not.toBeNull();
    expect(row.fundamentals).toMatchObject({ marketCap: "1000000000" });
  });

  it("serves the cached blob without calling the provider when fresh", async () => {
    const t = await setupUser();
    const inst = await insertInstrument({
      fundamentals: { currency: "USD", asOf: new Date().toISOString(), marketCap: "42" },
      fundamentalsCheckedAt: new Date(), // fresh — within the 24h staleness window
    });
    let called = false;
    overrideMarketData(
      new MarketDataService([
        stubProvider({ result: FAKE_FUNDAMENTALS, onCall: () => (called = true) }),
      ]),
    );

    const res = await app.inject({
      method: "GET",
      url: `/instruments/${inst.id}/fundamentals`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ marketCap: "42" });
    expect(called).toBe(false);
  });

  it.each([
    ["returns null", { result: null }],
    ["throws (swallowed by MarketDataService, same as returning null)", { throws: true }],
  ] as const)(
    "bumps fundamentalsCheckedAt but keeps the old blob when the provider %s",
    async (_label, opts) => {
      const t = await setupUser();
      const staleDate = new Date(Date.now() - 48 * 60 * 60 * 1000); // well past the 24h cutoff
      const inst = await insertInstrument({
        fundamentals: { currency: "USD", asOf: staleDate.toISOString(), marketCap: "77" },
        fundamentalsCheckedAt: staleDate,
      });
      overrideMarketData(new MarketDataService([stubProvider(opts)]));

      const res = await app.inject({
        method: "GET",
        url: `/instruments/${inst.id}/fundamentals`,
        headers: auth(t),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ marketCap: "77" }); // old cache preserved, not wiped

      const db = getDb();
      const [row] = await db.select().from(instruments).where(eq(instruments.id, inst.id)).limit(1);
      expect(new Date(row.fundamentalsCheckedAt!).getTime()).toBeGreaterThan(staleDate.getTime());
    },
  );
});
