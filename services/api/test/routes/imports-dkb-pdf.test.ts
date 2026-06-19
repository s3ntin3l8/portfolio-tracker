import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { generateKeyPair, SignJWT } from "jose";

// Mock the PDF text extractor so the route's deterministic DKB-PDF fast-path runs against a
// known DKB dividend text without needing a real PDF binary. Kept in its own test file so
// this mock never leaks into the vision-fallback assertions in imports.test.ts.
const DKB_DIVIDEND_TEXT =
  "Frau Max Mustermann Depotnummer 999999001 Kundennummer 0000000000 Abrechnungsnr. " +
  "11111111111 Datum 12.12.2025 Dividendengutschrift Nominale Wertpapierbezeichnung ISIN " +
  "(WKN) Stück 1 MICROSOFT CORP. REGISTERED SHARES DL-,00000625 US5949181045 (870747) " +
  "Devisenkurs EUR / USD 1,1777 Dividende pro Stück 0,91 USD Dividendengutschrift 0,91 USD " +
  "0,77+ EUR Einbehaltene Quellensteuer 15 % auf 0,91 USD 0,12- EUR Verrechneter " +
  "Sparer-Pauschbetrag 0,77 - EUR Ausmachender Betrag 0,65+ EUR Den Betrag buchen wir mit " +
  "Wertstellung 12.12.2025 zu Gunsten des Kontos 0000000000 (IBAN DE00 0000 0000 0000 0000 " +
  "00), BLZ 120 300 00 (BIC BYLADEM1001).";

vi.mock("../../src/services/parsers/pdf-text.js", () => ({
  extractPdfText: async () => DKB_DIVIDEND_TEXT,
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
import type { ScreenshotParser } from "../../src/services/parsers/types.js";

const ISSUER = "https://auth.test/o/p/";
const AUDIENCE = "portfolio-tracker";

// A vision parser that fails loudly: if the deterministic DKB path works, it is never called.
const explodingParser: ScreenshotParser = {
  name: "should-not-run",
  isConfigured: () => true,
  parse: async () => {
    throw new Error("vision parser must not be called for a recognised DKB PDF");
  },
};

function pdfPart(buf: Buffer, filename = "stmt.pdf") {
  const boundary = "----DkbPdfTestBoundary";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`,
    ),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload };
}

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

describe("DKB PDF deterministic import path", () => {
  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    app = await buildApp({ authKey: kp.publicKey, screenshotParser: explodingParser });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
  });

  it("parses a DKB dividend PDF deterministically, without calling the vision parser", async () => {
    const t = await token("dkb-pdf-user");
    const form = pdfPart(Buffer.from("%PDF-1.4 (content irrelevant — extractor is mocked)"));
    const res = await app.inject({
      method: "POST",
      url: "/imports/screenshot",
      headers: { ...auth(t), ...form.headers },
      payload: form.payload,
    });
    expect(res.statusCode).toBe(201);
    const { drafts } = res.json();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      action: "dividend",
      isin: "US5949181045",
      wkn: "870747",
      price: "0.65",
      total: "0.77",
      tax: "0.12",
      fxRate: "1.1777",
      currency: "EUR",
      externalId: "dkb:11111111111",
    });
  });

  it("confirms the dividend draft into a transaction carrying tax + fxRate", async () => {
    const t = await token("dkb-pdf-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "DKB", baseCurrency: "EUR" },
      })
    ).json().id;

    const form = pdfPart(Buffer.from("%PDF-1.4 second-upload"), "stmt2.pdf");
    const imp = await app.inject({
      method: "POST",
      url: "/imports/screenshot",
      headers: { ...auth(t), ...form.headers },
      payload: form.payload,
    });
    const { importId, drafts } = imp.json();

    const confirm = await app.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId, transactions: drafts },
    });
    expect(confirm.statusCode).toBe(201);

    const txns = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
    });
    const list = txns.json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ type: "dividend", tax: "0.12", fxRate: "1.1777" });
  });
});
