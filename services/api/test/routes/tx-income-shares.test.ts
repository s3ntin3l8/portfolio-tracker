import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT, exportJWK } from "jose";
import { instruments } from "@portfolio/db";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

// Issue #508: dividend transactions should surface shares/perShare. Covers two paths:
//  - Manual entry: the four fields round-trip through POST/PATCH untouched.
//  - The read-time derived fallback: a dividend with no source-provided shares/perShare
//    gets them filled from the portfolio's holdings history at the pay date, without ever
//    persisting the derived value (never overwrites, only fills what the response omits).

const ISSUER = "https://auth.test/application/o/portfolio/";
const AUDIENCE = "portfolio-tracker";

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let privateKey: CryptoKey;
let instrumentId: string;

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

describe("dividend perShare/shares (#508)", () => {
  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    await exportJWK(kp.publicKey);
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    process.env.RATE_LIMIT_MAX = "10000";
    app = await buildApp({ authKey: kp.publicKey });
    const [ins] = await app.db
      .insert(instruments)
      .values({
        symbol: "MO",
        market: "NYSE",
        assetClass: "equity",
        currency: "EUR",
        name: "Altria",
      })
      .returning();
    instrumentId = ins.id;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    delete process.env.RATE_LIMIT_MAX;
  });

  async function setup(suffix: string) {
    const t = await token(`income-shares-${suffix}`);
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });
    const created = await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(t),
      payload: { name: "Dividend book", baseCurrency: "EUR" },
    });
    const portfolioId = created.json().id as string;
    return { t, portfolioId };
  }

  it("round-trips manually-entered shares/perShare/nativeCurrency/grossNative on create and edit", async () => {
    const { t, portfolioId } = await setup("manual");

    const created = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: {
        type: "dividend",
        instrumentId,
        quantity: "0",
        price: "5.51",
        tax: "1.31",
        perShare: "0.26",
        shares: "28.876429",
        nativeCurrency: "USD",
        grossNative: "7.51",
        currency: "EUR",
        executedAt: "2026-06-16T00:00:00.000Z",
      },
    });
    expect(created.statusCode).toBe(201);
    const tx = created.json();
    expect(tx.perShare).toBe("0.26");
    expect(tx.shares).toBe("28.876429");
    expect(tx.nativeCurrency).toBe("USD");
    expect(tx.grossNative).toBe("7.51");

    // Edit: change perShare, leave shares alone.
    const updated = await app.inject({
      method: "PATCH",
      url: `/portfolios/${portfolioId}/transactions/${tx.id}`,
      headers: auth(t),
      payload: {
        type: "dividend",
        instrumentId,
        quantity: "0",
        price: "5.51",
        tax: "1.31",
        perShare: "0.27",
        shares: "28.876429",
        nativeCurrency: "USD",
        grossNative: "7.51",
        currency: "EUR",
        executedAt: "2026-06-16T00:00:00.000Z",
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().perShare).toBe("0.27");

    // The list endpoint returns the manually-entered value untouched — never overwritten
    // by the derived fallback (a buy exists for this instrument too, so a derivation is
    // possible but must not clobber the authoritative manual value).
    await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: {
        type: "buy",
        instrumentId,
        quantity: "10",
        price: "50",
        currency: "EUR",
        executedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const list = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
    });
    const row = (list.json() as { id: string; perShare: string; sharesEstimated?: boolean }[]).find(
      (r) => r.id === tx.id,
    );
    expect(row?.perShare).toBe("0.27");
    // A manually-entered (authoritative) value is never flagged as estimated, even though a
    // derivation is possible for this row (a buy exists for the same instrument above).
    expect(row?.sharesEstimated).toBeFalsy();
  });

  it("derives shares/perShare for a dividend with no source-provided value, from the holdings history at the pay date", async () => {
    const { t, portfolioId } = await setup("derived");

    // 10 shares bought before the dividend's pay date.
    await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: {
        type: "buy",
        instrumentId,
        quantity: "10",
        price: "50",
        currency: "EUR",
        executedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    // A dividend with only price/tax (net/gross convention) — no perShare/shares, as a
    // TR-CSV or IBKR import would leave it.
    const div = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: {
        type: "dividend",
        instrumentId,
        quantity: "0",
        price: "8",
        tax: "2",
        currency: "EUR",
        executedAt: "2026-06-01T00:00:00.000Z",
      },
    });
    expect(div.json().perShare).toBeNull();
    expect(div.json().shares).toBeNull();

    const list = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
    });
    const row = (
      list.json() as {
        id: string;
        type: string;
        perShare: string;
        shares: string;
        sharesEstimated?: boolean;
      }[]
    ).find((r) => r.id === div.json().id);
    // 10 shares held; gross = price(8) + tax(2) = 10 → perShare = 10/10 = 1.
    expect(row?.shares).toBe("10");
    expect(row?.perShare).toBe("1");
    // Flagged as derived (#508) — the UI hints this is approximate, not source-provided.
    expect(row?.sharesEstimated).toBe(true);
  });

  it("does not derive shares for a dividend on an instrument never held (no positive holding)", async () => {
    const { t, portfolioId } = await setup("no-holding");
    const [otherIns] = await app.db
      .insert(instruments)
      .values({
        symbol: "PEP",
        market: "NYSE",
        assetClass: "equity",
        currency: "EUR",
        name: "PepsiCo",
      })
      .returning();

    const div = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: {
        type: "dividend",
        instrumentId: otherIns.id,
        quantity: "0",
        price: "17.02",
        tax: "3.01",
        currency: "EUR",
        executedAt: "2026-06-30T00:00:00.000Z",
      },
    });

    const list = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
    });
    const row = (
      list.json() as { id: string; perShare: string | null; shares: string | null }[]
    ).find((r) => r.id === div.json().id);
    expect(row?.shares).toBeNull();
    expect(row?.perShare).toBeNull();
  });
});
