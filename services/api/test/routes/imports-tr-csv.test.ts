import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

const ISSUER = "https://auth.test/o/p/";
const AUDIENCE = "portfolio-tracker";

// A minimal but representative Trade Republic transaction export (sanitised). Covers a
// cash deposit, a stock buy and a foreign dividend with withholding tax + FX.
const HEADER =
  "datetime,date,account_type,category,type,asset_class,name,symbol,shares,price,amount,fee,tax,currency,original_amount,original_currency,fx_rate,description,transaction_id,counterparty_name,counterparty_iban,payment_reference,mcc_code";
const TR_CSV = [
  HEADER,
  '"2023-01-31T22:20:28.617262Z","2023-01-31","DEFAULT","CASH","CUSTOMER_INPAYMENT","","","","","","500.000000","","","EUR","","","","inpayment","00000000-0000-0000-0000-000000000001","","","",""',
  '"2022-08-18T19:17:06.465Z","2022-08-18","DEFAULT","TRADING","BUY","STOCK","Alphabet (C)","US02079K1079","2.0000000000","120.260000","-240.52","-1.00","","EUR","","","","","00000000-0000-0000-0000-000000000002","","","",""',
  '"2025-05-09T01:10:00.000000Z","2025-05-09","DEFAULT","CASH","DIVIDEND","STOCK","Altria Group","US02209S1033","11.0000000000","","3.940000","","-0.59","EUR","3.57","USD","1.103400","","00000000-0000-0000-0000-000000000003","","","",""',
  '"2025-02-03T15:59:12.456716Z","2025-02-03","DEFAULT","CASH","BENEFITS_SAVEBACK","FUND","Core S&amp;P 500 USD (Acc)","IE00B5BMR087","","","0.550000","","","EUR","","","","Your Saveback payment","00000000-0000-0000-0000-000000000004","","","",""',
].join("\n");

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

describe("Trade Republic CSV import path", () => {
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

  it("auto-detects the TR export and round-trips a dividend through confirm with tax + FX", async () => {
    const t = await token("tr-csv-user");
    await app.inject({ method: "GET", url: "/me", headers: auth(t) }); // upsert user
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "TR", baseCurrency: "EUR" },
      })
    ).json().id;

    const imp = await app.inject({
      method: "POST",
      url: "/imports/csv",
      headers: auth(t),
      payload: { content: TR_CSV, format: "auto" }, // auto must resolve to tr-csv
    });
    expect(imp.statusCode).toBe(201);
    const { importId, drafts } = imp.json();
    expect(drafts).toHaveLength(4);
    const dividend = drafts.find((d: { action: string }) => d.action === "dividend");
    expect(dividend).toMatchObject({ price: "3.35", total: "3.94", tax: "0.59", fxRate: "1.103400" });
    // Saveback is a reward-funded buy, not a contribution → bonus_cash (it would collapse into
    // its funding buy, but this fixture has no Core S&P 500 buy, so it stays a standalone row).
    const saveback = drafts.find((d: { kind?: string }) => d.kind === "bonus");
    expect(saveback).toMatchObject({ action: "bonus_cash", price: "0.55" });

    const confirm = await app.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId, transactions: drafts },
    });
    expect(confirm.statusCode).toBe(201);

    const list = (
      await app.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/transactions`,
        headers: auth(t),
      })
    ).json();
    expect(list).toHaveLength(4);
    const persisted = list.find((tx: { type: string }) => tx.type === "dividend");
    // The EU-broker path resolved the US ISIN to an instrument and persisted the enrichment.
    expect(persisted).toMatchObject({ type: "dividend", tax: "0.59", fxRate: "1.103400" });
    expect(persisted.instrumentId).toBeTruthy();

    // A TR account is the mixed-cash case → cash-outside (the default), so contribution is
    // the invested capital: the €241.52 buy (2 × 120.26 + €1 fee). The €500 deposit is
    // ignored (cash outside the boundary), and the saveback (now `bonus_cash`) and the
    // dividend are income — neither inflates the contributed total.
    const contrib = (
      await app.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/contributions`,
        headers: auth(t),
      })
    ).json();
    expect(contrib.totalContributed).toBe("241.52");
  });
});
