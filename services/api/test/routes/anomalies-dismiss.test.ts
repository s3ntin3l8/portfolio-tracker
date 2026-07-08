import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { instruments, portfolios, trConnections } from "@portfolio/db";
import { buildApp } from "../../src/app.js";
import { getDb, closeDb } from "../../src/db/client.js";

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

describe("anomaly dismissal + negative-cash guard", () => {
  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    process.env.RATE_LIMIT_MAX = "10000";
    app = await buildApp({ authKey: kp.publicKey });
    const [acme] = await app.db
      .insert(instruments)
      .values({ symbol: "ACME", market: "XETRA", assetClass: "equity", currency: "EUR", name: "Acme" })
      .returning();
    acmeId = acme.id;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    delete process.env.RATE_LIMIT_MAX;
  });

  // A cash-counted portfolio with a deposit then a larger buy a month later → the buy drives
  // EUR cash negative, producing a `negative_cash` anomaly attributed to the buy.
  async function setupWithNegativeCash(sub: string, allowNegativeCash = false) {
    const t = await token(sub);
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });
    const created = await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(t),
      payload: { name: "Neg", baseCurrency: "EUR", cashCounted: true, allowNegativeCash },
    });
    const portfolioId = created.json().id as string;
    await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: { type: "deposit", quantity: "0", price: "100", currency: "EUR", executedAt: "2024-01-01T00:00:00.000Z" },
    });
    const buy = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: {
        type: "buy",
        instrumentId: acmeId,
        quantity: "1",
        price: "150",
        currency: "EUR",
        executedAt: "2024-02-01T00:00:00.000Z",
      },
    });
    return { t, portfolioId, buyId: buy.json().id as string };
  }

  function negativeCash(holdingsBody: { anomalies: { code: string; transactionId?: string }[] }) {
    return holdingsBody.anomalies.filter((a) => a.code === "negative_cash");
  }

  it("surfaces a negative_cash anomaly, then hides it once dismissed", async () => {
    const { t, portfolioId, buyId } = await setupWithNegativeCash("dismiss-user");

    const before = await app.inject({ method: "GET", url: `/portfolios/${portfolioId}/holdings`, headers: auth(t) });
    const negs = negativeCash(before.json());
    expect(negs).toHaveLength(1);
    expect(negs[0].transactionId).toBe(buyId);

    const dismissed = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/anomalies/dismiss`,
      headers: auth(t),
      payload: { transactionId: buyId, code: "negative_cash" },
    });
    expect(dismissed.statusCode).toBe(204);

    // Idempotent: dismissing again is still 204.
    const again = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/anomalies/dismiss`,
      headers: auth(t),
      payload: { transactionId: buyId, code: "negative_cash" },
    });
    expect(again.statusCode).toBe(204);

    const after = await app.inject({ method: "GET", url: `/portfolios/${portfolioId}/holdings`, headers: auth(t) });
    expect(negativeCash(after.json())).toHaveLength(0);
  });

  it("undismiss brings the anomaly back", async () => {
    const { t, portfolioId, buyId } = await setupWithNegativeCash("undismiss-user");
    await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/anomalies/dismiss`,
      headers: auth(t),
      payload: { transactionId: buyId, code: "negative_cash" },
    });
    const gone = await app.inject({ method: "GET", url: `/portfolios/${portfolioId}/holdings`, headers: auth(t) });
    expect(negativeCash(gone.json())).toHaveLength(0);

    const undo = await app.inject({
      method: "DELETE",
      url: `/portfolios/${portfolioId}/anomalies/dismiss`,
      headers: auth(t),
      payload: { transactionId: buyId, code: "negative_cash" },
    });
    expect(undo.statusCode).toBe(204);

    const back = await app.inject({ method: "GET", url: `/portfolios/${portfolioId}/holdings`, headers: auth(t) });
    expect(negativeCash(back.json())).toHaveLength(1);
  });

  it("rejects dismissing a transaction that isn't in the portfolio (404)", async () => {
    const { t, portfolioId } = await setupWithNegativeCash("guard-user");
    // A transaction id from a different portfolio (here just a random uuid) → 404.
    const res = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/anomalies/dismiss`,
      headers: auth(t),
      payload: { transactionId: "00000000-0000-0000-0000-000000000000", code: "negative_cash" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("transaction_not_found");
  });

  it("allowNegativeCash=true suppresses the negative_cash guard entirely", async () => {
    const { t, portfolioId } = await setupWithNegativeCash("allow-user", true);
    const holdings = await app.inject({ method: "GET", url: `/portfolios/${portfolioId}/holdings`, headers: auth(t) });
    expect(negativeCash(holdings.json())).toHaveLength(0);
  });

  // 3b remediation: a manual `adjustment` transaction is the user's true-up for a known
  // TR feed-vs-reality gap the feed itself gives no signal to detect (see
  // .claude/plans/can-we-investigate-my-warm-honey.md). reconcileCash only ever reads the
  // raw feed, so without netManualAdjustments folding stored adjustments in at read time,
  // booking the true-up would move holdings cash but leave reconciliation_gap firing forever.
  function reconciliationGap(holdingsBody: { anomalies: { code: string; meta?: Record<string, unknown> }[] }) {
    return holdingsBody.anomalies.filter((a) => a.code === "reconciliation_gap");
  }

  it("a manual adjustment transaction clears a standing reconciliation_gap warning", async () => {
    const sub = "adjustment-user";
    const t = await token(sub);
    await app.inject({ method: "GET", url: "/me", headers: auth(t) });
    const created = await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(t),
      payload: { name: "Recon", baseCurrency: "EUR", cashCounted: true },
    });
    const portfolioId = created.json().id as string;
    await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: { type: "deposit", quantity: "0", price: "1000", currency: "EUR", executedAt: "2026-01-01T00:00:00.000Z" },
    });

    const db = getDb();
    const [{ userId }] = await db
      .select({ userId: portfolios.userId })
      .from(portfolios)
      .where(eq(portfolios.id, portfolioId));
    await db.insert(trConnections).values({
      userId,
      portfolioId,
      phoneEnc: "enc",
      pinEnc: "enc",
      lastReconciliation: {
        checkedAt: "2026-07-08T00:00:00.000Z",
        cash: [{ currency: "EUR", reported: "973.30", derived: "1000", diff: "-26.70" }],
      },
    });

    const before = await app.inject({ method: "GET", url: `/portfolios/${portfolioId}/holdings`, headers: auth(t) });
    expect(reconciliationGap(before.json())).toHaveLength(1);

    await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
      payload: {
        type: "adjustment",
        quantity: "0",
        price: "-26.70",
        currency: "EUR",
        executedAt: "2026-07-08T00:00:00.000Z",
        description: "TR feed reconciliation",
      },
    });

    const after = await app.inject({ method: "GET", url: `/portfolios/${portfolioId}/holdings`, headers: auth(t) });
    expect(reconciliationGap(after.json())).toHaveLength(0);
    // The adjustment also moved actual holdings cash (via /summary), not just the warning.
    const summary = await app.inject({ method: "GET", url: `/portfolios/${portfolioId}/summary`, headers: auth(t) });
    expect(summary.json().cash.EUR).toBe("973.3");
  });
});
