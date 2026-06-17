import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import {
  parsedGoldContractSchema,
  type ParsedGoldContract,
  type ParsedTransaction,
} from "@portfolio/schema";
import type { ScreenshotParser } from "../../src/services/parsers/types.js";

// Mock parser so the screenshot flow is hermetic (no Anthropic/Gemini/OpenRouter call).
function mockParser(
  drafts: ParsedTransaction[],
  configured = true,
  contracts: ParsedGoldContract[] = [],
): ScreenshotParser {
  return {
    name: "mock",
    isConfigured: () => configured,
    parse: async () => ({ drafts, contracts }),
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

const CSV = `date,action,assetClass,ticker,name,quantity,unit,price,fees,currency
2026-01-15,buy,equity,BBCA,Bank Central Asia,100,shares,9500,0,IDR`;

// A DKB Girokonto Umsatzliste (anonymised): a savings-plan buy, a dividend, a cash
// deposit and a cash withdrawal — the four row kinds the parser must classify.
const DKB_GIRO_CSV = [
  '"Girokonto";"DE78120300001066505387"',
  '"Zeitraum:";"01.01.2026 - 15.06.2026"',
  '""',
  '"Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";"Verwendungszweck";"Umsatztyp";"IBAN";"Betrag (€)";"Gläubiger-ID";"Mandatsreferenz";"Kundenreferenz"',
  '"15.06.26";"12.06.26";"Gebucht";"DKB AG";"Max Mustermann";"Depot 0506740786 Wertpapierertrag 12.06.2026 000066336002660 WKN 870747 MICROSOFT    DL-,00000625 ISIN US5949181045";"Eingang";"0000000000";"0,67";"";"";""',
  '"08.06.26";"09.06.26";"Gebucht";"Max Mustermann";"DKB AG";"Depot 0506740786 Wertp.Abrechn. 05.06.2026 000006520078300 WKN A2H9Q0 Gesch.Art KV AIS-A.CO.MSCI E.M.UETFDRD ISIN LU1737652583 Ihr Wertpapier-Sparplan Preis       74,50600000 EUR Stück           0,3355";"Ausgang";"0000000000";"-25";"";"";""',
  '"01.06.26";"01.06.26";"Gebucht";"Erika Mustermann";"FRAU MAX MUSTERMANN";"Sparplan";"Eingang";"DE69120300001053487276";"75";"";"";""',
  '"13.04.26";"11.04.26";"Gebucht";"Max Mustermann";"Erika Mustermann";"Übertrag";"Ausgang";"DE15100123450587698301";"-509,59";"";"";""',
].join("\n");

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

  it("imports a DKB Girokonto export: securities + cash, idempotent on re-import", async () => {
    const t = await token("dkb-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "DKB", baseCurrency: "EUR" },
      })
    ).json().id;

    const imp = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/imports/csv`,
      headers: auth(t),
      payload: { content: DKB_GIRO_CSV, format: "dkb" },
    });
    expect(imp.statusCode).toBe(201);
    const { importId, drafts } = imp.json();
    expect(drafts).toHaveLength(4); // dividend, savings-plan buy, deposit, withdrawal

    const stored = await app.inject({
      method: "GET",
      url: `/imports/${importId}`,
      headers: auth(t),
    });
    expect(stored.json().parser).toBe("dkb");

    const confirm = await app.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(t),
      payload: { transactions: drafts },
    });
    expect(confirm.statusCode).toBe(201);
    const txns = confirm.json().transactions as Array<{
      type: string;
      source: string;
      currency: string;
      instrumentId: string | null;
    }>;
    expect(txns).toHaveLength(4);
    expect(txns.every((x) => x.source === "csv")).toBe(true);
    expect(txns.every((x) => x.currency === "EUR")).toBe(true);
    // Cash rows have no instrument; securities rows do.
    const cash = txns.filter((x) => x.type === "deposit" || x.type === "withdrawal");
    const securities = txns.filter((x) => x.type === "savings_plan" || x.type === "dividend");
    expect(cash).toHaveLength(2);
    expect(cash.every((x) => x.instrumentId === null)).toBe(true);
    expect(securities.every((x) => x.instrumentId !== null)).toBe(true);

    // Re-importing the same export confirms zero new transactions (stable externalIds).
    const reImp = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/imports/csv`,
      headers: auth(t),
      payload: { content: DKB_GIRO_CSV, format: "dkb" },
    });
    const reConfirm = await app.inject({
      method: "POST",
      url: `/imports/${reImp.json().importId}/confirm`,
      headers: auth(t),
      payload: { transactions: reImp.json().drafts },
    });
    expect(reConfirm.statusCode).toBe(201);
    expect(reConfirm.json().confirmed).toBe(0);
  });

  it("auto-detects the parser when format is omitted (DKB vs generic)", async () => {
    const t = await token("auto-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Auto", baseCurrency: "EUR" },
      })
    ).json().id;

    // No format → the DKB Girokonto export is recognised and parsed as DKB.
    const dkb = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/imports/csv`,
      headers: auth(t),
      payload: { content: DKB_GIRO_CSV },
    });
    expect(dkb.statusCode).toBe(201);
    expect(dkb.json().drafts).toHaveLength(4);
    const dkbDetail = (
      await app.inject({ method: "GET", url: `/imports/${dkb.json().importId}`, headers: auth(t) })
    ).json();
    expect(dkbDetail.parser).toBe("dkb");
    // The single-import endpoint returns the parsed drafts (powers the review screen).
    expect(dkbDetail.drafts).toHaveLength(4);
    expect(dkbDetail.status).toBe("draft");

    // No format → the generic column CSV falls through to the generic parser.
    const generic = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/imports/csv`,
      headers: auth(t),
      payload: { content: CSV },
    });
    expect(generic.statusCode).toBe(201);
    expect(generic.json().drafts).toHaveLength(1);
    expect(
      (await app.inject({ method: "GET", url: `/imports/${generic.json().importId}`, headers: auth(t) })).json().parser,
    ).toBe("csv");
  });

  it("lists imports, discards a draft, and undoes a confirmed import", async () => {
    const t = await token("hist-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Hist", baseCurrency: "IDR" },
      })
    ).json().id;

    // One draft we'll discard, one we'll confirm then undo.
    const draftImp = (
      await app.inject({
        method: "POST",
        url: `/portfolios/${portfolioId}/imports/csv`,
        headers: auth(t),
        payload: { content: CSV },
      })
    ).json();
    const confirmImp = (
      await app.inject({
        method: "POST",
        url: `/portfolios/${portfolioId}/imports/csv`,
        headers: auth(t),
        payload: { content: CSV },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/imports/${confirmImp.importId}/confirm`,
      headers: auth(t),
      payload: { transactions: confirmImp.drafts },
    });

    // List: newest first, with status + count.
    const list = await app.inject({ method: "GET", url: "/imports", headers: auth(t) });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as Array<{ id: string; status: string; count: number }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toContain(draftImp.importId);
    expect(rows.find((r) => r.id === confirmImp.importId)!.status).toBe("confirmed");
    expect(rows.find((r) => r.id === draftImp.importId)!.count).toBe(1);

    // Discard the draft (confirmed imports can't be discarded — 409).
    expect(
      (await app.inject({ method: "POST", url: `/imports/${draftImp.importId}/discard`, headers: auth(t) }))
        .statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: "POST", url: `/imports/${confirmImp.importId}/discard`, headers: auth(t) }))
        .statusCode,
    ).toBe(409);

    // Undo the confirmed import: its transaction is removed and it's marked discarded.
    const undo = await app.inject({
      method: "DELETE",
      url: `/imports/${confirmImp.importId}`,
      headers: auth(t),
    });
    expect(undo.statusCode).toBe(200);
    expect(undo.json().removed).toBe(1);
    const holdings = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/holdings`,
      headers: auth(t),
    });
    expect(holdings.json()).toHaveLength(0);
    expect(
      (await app.inject({ method: "GET", url: `/imports/${confirmImp.importId}`, headers: auth(t) }))
        .json().status,
    ).toBe("discarded");

    // Another user can't touch these imports.
    const other = await token("hist-other");
    expect(
      (await app.inject({ method: "DELETE", url: `/imports/${draftImp.importId}`, headers: auth(other) }))
        .statusCode,
    ).toBe(404);
  });

  it("auto-detects and imports an IBKR Flex Trades CSV", async () => {
    const t = await token("ibkr-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "IBKR", baseCurrency: "USD" },
      })
    ).json().id;

    const ibkr = [
      "Symbol,DateTime,Quantity,TradePrice,IBCommission,CurrencyPrimary,AssetClass,Description,TradeID",
      'AAPL,"20260115;093000",10,190.50,-1.00,USD,STK,"APPLE INC",111',
      'TSLA,"20260116;100000",-5,250.00,-1.25,USD,STK,"TESLA INC",112',
    ].join("\n");

    const imp = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/imports/csv`,
      headers: auth(t),
      payload: { content: ibkr }, // format omitted → auto
    });
    expect(imp.statusCode).toBe(201);
    expect(imp.json().drafts).toHaveLength(2);

    const confirm = await app.inject({
      method: "POST",
      url: `/imports/${imp.json().importId}/confirm`,
      headers: auth(t),
      payload: { transactions: imp.json().drafts },
    });
    expect(confirm.statusCode).toBe(201);
    const txns = confirm.json().transactions as Array<{ type: string; source: string }>;
    expect(txns.map((x) => x.type).sort()).toEqual(["buy", "sell"]);
    expect(txns.every((x) => x.source === "csv")).toBe(true);
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
  let ssKey: CryptoKey;

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

  it("accepts a PDF document and rejects an unsupported media type", async () => {
    const t = await ssToken("ss-pdf-user");
    const portfolioId = (
      await ssApp.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "PDF", baseCurrency: "IDR" },
      })
    ).json().id;

    const pdf = await ssApp.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/imports/screenshot`,
      headers: auth(t),
      payload: {
        image: Buffer.from("%PDF-1.4 fake").toString("base64"),
        mimeType: "application/pdf",
      },
    });
    expect(pdf.statusCode).toBe(201);
    expect(pdf.json().drafts).toHaveLength(1);

    const bad = await ssApp.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/imports/screenshot`,
      headers: auth(t),
      payload: { image: "abc", mimeType: "text/plain" },
    });
    expect(bad.statusCode).toBe(400);
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

describe("gold installment contract import → confirm → undo", () => {
  let gApp: App;
  let gKey: CryptoKey;

  // A future-dated contract: no installment is due yet, so the round-trip is
  // deterministic (0 repayments booked, liability == principal) regardless of the
  // wall clock. The repayment/now-dependent path is covered in gold-contract.test.ts.
  const CONTRACT = parsedGoldContractSchema.parse({
    provider: "GALERI24",
    contractNo: "TEST-CONTRACT-1",
    currency: "IDR",
    grams: "50",
    goldName: "LM 50 Gram",
    purchasePrice: "80243000",
    downPayment: "12036450",
    adminFee: "50000",
    discount: "1250000",
    principal: "68206550",
    marginTotal: "8858832",
    tenorMonths: 12,
    monthlyInstallment: "6422116",
    startDate: "2099-01-13",
    schedule: Array.from({ length: 12 }, (_, i) => ({
      n: i + 1,
      dueDate: `2099-${String((i % 11) + 2).padStart(2, "0")}-13`,
      pokok: "5683880",
      sewaModal: "738236",
      angsuran: "6422116",
      sisaPokok: "0",
    })),
    confidence: 0.95,
  });

  async function gToken(sub: string) {
    return new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(gKey);
  }

  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    gKey = kp.privateKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    gApp = await buildApp({
      authKey: kp.publicKey,
      screenshotParser: mockParser([], true, [CONTRACT]),
    });
  });

  afterAll(async () => {
    await gApp.close();
    await closeDb();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
  });

  it("parses a contract, confirms it to a gold holding + loan, then undoes it", async () => {
    const t = await gToken("gold-contract-user");
    const portfolioId = (
      await gApp.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Cicilan", baseCurrency: "IDR" },
      })
    ).json().id;

    const imp = await gApp.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/imports/screenshot`,
      headers: auth(t),
      payload: { image: Buffer.from("fake-pdf").toString("base64"), mimeType: "application/pdf" },
    });
    expect(imp.statusCode).toBe(201);
    const { importId, drafts, contracts } = imp.json();
    expect(drafts).toHaveLength(0);
    expect(contracts).toHaveLength(1);
    expect(contracts[0].grams).toBe("50");

    // Confirm with the (user-reviewed) contract.
    const confirm = await gApp.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(t),
      payload: { contracts },
    });
    expect(confirm.statusCode).toBe(201);
    // 4 booking legs (buy, drawdown, admin, discount); no installments due yet.
    expect(confirm.json().confirmed).toBe(4);

    const holdings = (
      await gApp.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/holdings`,
        headers: auth(t),
      })
    ).json();
    expect(holdings).toHaveLength(1);
    expect(holdings[0].quantity).toBe("50");

    const summary = (
      await gApp.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/summary`,
        headers: auth(t),
      })
    ).json();
    expect(summary.totalLiabilities).toBe("68206550");
    // Default (purchase_price) cost basis is the G24 purchase price.
    expect(summary.holdings[0].costBasis).toBe("80243000");

    // The cost-basis toggle moves only the holding's cost basis, never net worth.
    const totalPaid = (
      await gApp.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/summary?costBasis=total_paid`,
        headers: auth(t),
      })
    ).json();
    expect(totalPaid.netWorth).toBe(summary.netWorth);
    expect(totalPaid.totalLiabilities).toBe(summary.totalLiabilities);
    // financing to date = admin 50,000 − discount 1,250,000 (no installments due yet).
    expect(totalPaid.holdings[0].costBasis).toBe("79043000");

    // Undo removes the legs and the loan; liability and holdings return to zero.
    const undo = await gApp.inject({
      method: "DELETE",
      url: `/imports/${importId}`,
      headers: auth(t),
    });
    expect(undo.statusCode).toBe(200);
    expect(undo.json().removed).toBe(4);

    const afterHoldings = (
      await gApp.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/holdings`,
        headers: auth(t),
      })
    ).json();
    expect(afterHoldings).toHaveLength(0);

    const afterSummary = (
      await gApp.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/summary`,
        headers: auth(t),
      })
    ).json();
    expect(afterSummary.totalLiabilities).toBe("0");
  });
});
