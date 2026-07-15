import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { portfolioSnapshots } from "@portfolio/db";
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

describe("GET /insights", () => {
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

  // Regression guard: drawdown must come from the cashflow-normalized TWR index
  // (marketValue/effectiveFlow), not raw snapshot net worth. A withdrawal shrinks net
  // worth (cash leaving the portfolio) without touching holdings market value at all —
  // feeding raw net worth into maxDrawdown manufactures a phantom drawdown for what is
  // just money leaving the boundary, not a loss.
  it("does not report a phantom drawdown from a net-worth-only withdrawal", async () => {
    const t = await token("insights-drawdown-user");
    const create = await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(t),
      payload: { name: "Drawdown Test", baseCurrency: "IDR" },
    });
    const portfolioId = create.json().id;

    // marketValue and effectiveFlow are flat across all three days (nothing bought,
    // sold, or otherwise flowed through holdings) — only netWorth (which includes
    // cash) drops sharply on day 2, as a large cash withdrawal would.
    await app.db.insert(portfolioSnapshots).values([
      { portfolioId, date: "2026-01-01", netWorth: "1000000", marketValue: "1000000", effectiveFlow: "0", currency: "IDR" },
      { portfolioId, date: "2026-01-02", netWorth: "200000", marketValue: "1000000", effectiveFlow: "0", currency: "IDR" },
      { portfolioId, date: "2026-01-03", netWorth: "1000000", marketValue: "1000000", effectiveFlow: "0", currency: "IDR" },
    ]);

    const res = await app.inject({ method: "GET", url: "/insights?range=all", headers: auth(t) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Number(body.drawdown.maxDrawdownPct)).toBeCloseTo(0, 6);
  });

  // Regression guard for the portfolio selector not reacting (#insights scope bug):
  // /insights must accept ?portfolioId= and scope every metric to that one portfolio,
  // not always aggregate across the user's whole account.
  it("scopes metrics to a single portfolio via ?portfolioId=, distinct from the aggregate", async () => {
    const t = await token("insights-scope-user");
    const mk = async (name: string) =>
      (
        await app.inject({
          method: "POST",
          url: "/portfolios",
          headers: auth(t),
          payload: { name, baseCurrency: "IDR" },
        })
      ).json().id;
    const flatId = await mk("Flat");
    const crashId = await mk("Crash");

    await app.db.insert(portfolioSnapshots).values([
      { portfolioId: flatId, date: "2026-01-01", netWorth: "1000000", marketValue: "1000000", effectiveFlow: "0", currency: "IDR" },
      { portfolioId: flatId, date: "2026-01-02", netWorth: "1000000", marketValue: "1000000", effectiveFlow: "0", currency: "IDR" },
      // A real holdings crash: marketValue halves with no offsetting effectiveFlow.
      { portfolioId: crashId, date: "2026-01-01", netWorth: "1000000", marketValue: "1000000", effectiveFlow: "0", currency: "IDR" },
      { portfolioId: crashId, date: "2026-01-02", netWorth: "500000", marketValue: "500000", effectiveFlow: "0", currency: "IDR" },
    ]);

    const flat = await app.inject({ method: "GET", url: `/insights?range=all&portfolioId=${flatId}`, headers: auth(t) });
    const crash = await app.inject({ method: "GET", url: `/insights?range=all&portfolioId=${crashId}`, headers: auth(t) });
    const aggregate = await app.inject({ method: "GET", url: "/insights?range=all", headers: auth(t) });

    expect(Number(flat.json().drawdown.maxDrawdownPct)).toBeCloseTo(0, 6);
    expect(Number(crash.json().drawdown.maxDrawdownPct)).toBeCloseTo(-0.5, 6);
    // The aggregate blends both portfolios, so it lands strictly between the two —
    // proving portfolioId genuinely filters rather than being ignored.
    const aggDd = Number(aggregate.json().drawdown.maxDrawdownPct);
    expect(aggDd).toBeLessThan(0);
    expect(aggDd).toBeGreaterThan(-0.5);

    // A portfolio owned by someone else must not be selectable.
    const other = await token("insights-scope-other-user");
    const cross = await app.inject({ method: "GET", url: `/insights?portfolioId=${flatId}`, headers: auth(other) });
    expect(cross.statusCode).toBe(200);
    expect(cross.json().drawdown.maxDrawdownPct).toBe("0");
  });

  // Regression guard: a stale/missing price for a still-held instrument gets recorded
  // upstream (snapshot generation) as marketValue=0 with no offsetting effectiveFlow —
  // a data artifact, not a real total loss. Before the chainIndex guard, this single
  // gap day permanently zeroed the TWR index, so drawdown read -100% "from the
  // beginning" no matter how healthy the portfolio actually was on every other day.
  it("does not report -100% drawdown from a single price-gap snapshot day", async () => {
    const t = await token("insights-gap-user");
    const create = await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(t),
      payload: { name: "Gap Test", baseCurrency: "IDR" },
    });
    const portfolioId = create.json().id;

    await app.db.insert(portfolioSnapshots).values([
      { portfolioId, date: "2026-01-01", netWorth: "1000000", marketValue: "1000000", effectiveFlow: "1000000", currency: "IDR" },
      { portfolioId, date: "2026-01-02", netWorth: "1100000", marketValue: "1100000", effectiveFlow: "0", currency: "IDR" },
      // Gap day: price missing for the held instrument → marketValue recorded as 0,
      // no compensating flow.
      { portfolioId, date: "2026-01-03", netWorth: "0", marketValue: "0", effectiveFlow: "0", currency: "IDR" },
      { portfolioId, date: "2026-01-04", netWorth: "1150000", marketValue: "1150000", effectiveFlow: "0", currency: "IDR" },
    ]);

    const res = await app.inject({ method: "GET", url: "/insights?range=all", headers: auth(t) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Must NOT be -1 (-100%) — the gap day is carried forward, not applied as a real loss.
    expect(Number(body.drawdown.maxDrawdownPct)).not.toBeCloseTo(-1, 2);
    expect(Number(body.drawdown.maxDrawdownPct)).toBeGreaterThan(-0.5);
  });
});
