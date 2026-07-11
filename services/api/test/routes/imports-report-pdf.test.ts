import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { generateKeyPair, SignJWT } from "jose";

// Mock the PDF text extractor so the route's report-PDF detection runs against a known
// title without needing a real PDF binary. Kept in its own test file (mirrors
// imports-dkb-pdf.test.ts) so this mock never leaks into other route tests.
const REPORT_TEXT =
  "TRADE REPUBLIC BANK GMBH BRUNNENSTRASSE 19-21 10119 BERLIN SEITE 1 von 12 " +
  "Jährlicher Steuerbericht 2025 für das Kalenderjahr 2025 Max Mustermann Musterstr. 1 12345 Musterstadt";

vi.mock("../../src/services/parsers/pdf-text.js", () => ({
  extractPdfText: async () => REPORT_TEXT,
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
import { screenshotImports, documents } from "@portfolio/db";
import type { ScreenshotParser } from "../../src/services/parsers/types.js";

const ISSUER = "https://auth.test/o/rp/";
const AUDIENCE = "portfolio-tracker";

// A vision parser that fails loudly: if report detection short-circuits correctly, it is
// never reached.
const explodingParser: ScreenshotParser = {
  name: "should-not-run",
  isConfigured: () => true,
  parse: async () => {
    throw new Error("vision parser must not be called for a detected report PDF");
  },
};

function pdfPart(buf: Buffer, filename = "steuerbericht.pdf") {
  const boundary = "----ReportPdfTestBoundary";
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

describe("report-PDF detection in POST /imports/screenshot", () => {
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

  it("returns isReport:true without calling the vision parser or writing any rows", async () => {
    const t = await token("report-pdf-detect");
    const form = pdfPart(Buffer.from("%PDF-1.4 (content irrelevant — extractor is mocked)"));
    const res = await app.inject({
      method: "POST",
      url: "/imports/screenshot",
      headers: { ...auth(t), ...form.headers },
      payload: form.payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      isReport: true,
      reportCategory: "tax_report",
      reportTaxYear: 2025,
      reportTitle: "Jährlicher Steuerbericht 2025",
    });

    // Side-effect-free: no draft import row, no document row for this upload. The
    // exploding vision parser not throwing already proves it was never called (its parse()
    // always throws) — the report check runs before importStrategy is even read, so it's
    // unconditional regardless of the admin-configured strategy by construction.
    const imports = await app.db.select().from(screenshotImports);
    expect(imports).toHaveLength(0);
    const docs = await app.db.select().from(documents);
    expect(docs).toHaveLength(0);
  });
});
