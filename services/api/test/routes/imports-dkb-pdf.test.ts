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
import { importSettings, screenshotImports, transactionSources, transactions } from "@portfolio/db";
import { eq } from "drizzle-orm";
import { IMPORT_SETTINGS_ID } from "../../src/services/import-settings.js";
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
    // Distinct sub per test: the extractPdfText mock returns a constant, so every PDF now
    // hashes to the same text-layer contentHash (#216). A shared user would dedup these
    // independent uploads together; separate subs keep the tests order-independent.
    const t = await token("dkb-pdf-parse");
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

  it("materializes the dividend straight into the table when the Depotnummer matches a portfolio (Phase 2)", async () => {
    const t = await token("dkb-pdf-materialize");
    // Portfolio carries the PDF's Depotnummer (999999001), so the upload auto-routes to it.
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "DKB matched", baseCurrency: "EUR", accountNumber: "999999001" },
      })
    ).json().id;

    const form = pdfPart(Buffer.from("%PDF-1.4 materialize"), "mat.pdf");
    const res = await app.inject({
      method: "POST",
      url: "/imports/screenshot",
      headers: { ...auth(t), ...form.headers },
      payload: form.payload,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.materialized).toBe(true);
    expect(body.portfolioId).toBe(portfolioId);
    expect(body.materializedCount).toBe(1);

    // The dividend row is in the table as status='draft', source='pdf' — excluded until confirmed.
    const list = (
      await app.inject({ method: "GET", url: `/portfolios/${portfolioId}/transactions`, headers: auth(t) })
    ).json() as Array<{ id: string; status: string; source: string; type: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "draft", source: "pdf", type: "dividend" });
  });

  it("confirms the dividend draft into a transaction carrying tax + fxRate", async () => {
    const t = await token("dkb-pdf-confirm");
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
    expect(list[0]).toMatchObject({ type: "dividend", tax: "0.12", fxRate: "1.1777", source: "pdf" });
  });

  it("stores parser='dkb-pdf' on the import row and writes a pdf source row", async () => {
    const t = await token("dkb-pdf-parser-tag");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "DKB-tag", baseCurrency: "EUR" },
      })
    ).json().id;

    const form = pdfPart(Buffer.from("%PDF-1.4 parser-tag-test"), "tag-test.pdf");
    const { importId, drafts } = (
      await app.inject({
        method: "POST",
        url: "/imports/screenshot",
        headers: { ...auth(t), ...form.headers },
        payload: form.payload,
      })
    ).json();

    // The import row must carry the deterministic-parser tag, not the LLM parser name.
    const [imp] = await app.db
      .select({ parser: screenshotImports.parser })
      .from(screenshotImports)
      .where(eq(screenshotImports.id, importId));
    expect(imp.parser).toBe("dkb-pdf");

    // After confirm the transaction_sources row must carry sourceType="pdf".
    await app.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId, transactions: drafts },
    });

    const [tx] = await app.db
      .select({ id: transactions.id, source: transactions.source })
      .from(transactions)
      .where(eq(transactions.portfolioId, portfolioId));
    expect(tx.source).toBe("pdf");

    const [src] = await app.db
      .select({ sourceType: transactionSources.sourceType })
      .from(transactionSources)
      .where(eq(transactionSources.transactionId, tx.id));
    expect(src.sourceType).toBe("pdf");
  });

  it("dedups a PDF re-export whose bytes differ but text layer is identical (#216)", async () => {
    // Two distinct byte buffers (as a re-exported/re-downloaded broker PDF would be) that
    // share the same text layer (the constant mock). File-level dedup must collapse them to
    // one import — proving the contentHash is derived from the text layer, not the raw bytes.
    const t = await token("dkb-pdf-reexport");

    const originalForm = pdfPart(Buffer.from("%PDF-1.7 original bytes"), "original.pdf");
    const first = await app.inject({
      method: "POST",
      url: "/imports/screenshot",
      headers: { ...auth(t), ...originalForm.headers },
      payload: originalForm.payload,
    });
    expect(first.statusCode).toBe(201);
    const firstId = first.json().importId;
    expect(first.json().alreadyExists).toBeFalsy();

    // Byte-different "copy" of the same statement → same text → same hash → deduplicated.
    const copyForm = pdfPart(Buffer.from("%PDF-1.7 re-exported, different bytes"), "copy.pdf");
    const second = await app.inject({
      method: "POST",
      url: "/imports/screenshot",
      headers: { ...auth(t), ...copyForm.headers },
      payload: copyForm.payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().importId).toBe(firstId);
    expect(second.json().alreadyExists).toBe(true);

    // Only one import row exists for this user (the copy did not create a second).
    const list = await app.inject({ method: "GET", url: "/imports", headers: auth(t) });
    expect(list.json()).toHaveLength(1);
  });

  it("/duplicates classifies a dkb-pdf re-import vs a committed pdf tx as duplicate", async () => {
    // Regression for the /duplicates double-conversion bug: the route used to pre-convert
    // imp.parser to a tx source ("dkb-pdf" → "pdf") and pass that to classifyMatch, which
    // converts AGAIN — and "pdf" isn't round-trip-stable ("pdf" → "screenshot"). So a PDF
    // re-import matching an existing pdf-sourced tx (same source → should be "duplicate") was
    // mis-badged "enrichment". Passing the raw parser tag fixes it.
    const t = await token("dkb-pdf-duplicates");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "DKB-dup", baseCurrency: "EUR" },
      })
    ).json().id;

    // 1) Import + confirm the DKB dividend PDF → a committed transaction with source="pdf".
    const form1 = pdfPart(Buffer.from("%PDF-1.4 dup-first"), "dup1.pdf");
    const imp1 = (
      await app.inject({
        method: "POST",
        url: "/imports/screenshot",
        headers: { ...auth(t), ...form1.headers },
        payload: form1.payload,
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/imports/${imp1.importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId, transactions: imp1.drafts },
    });

    // 2) Re-import the same statement (force past file-level dedup) → a fresh dkb-pdf draft.
    const form2 = pdfPart(Buffer.from("%PDF-1.4 dup-second"), "dup2.pdf");
    const imp2 = (
      await app.inject({
        method: "POST",
        url: "/imports/screenshot?force=true",
        headers: { ...auth(t), ...form2.headers },
        payload: form2.payload,
      })
    ).json();
    expect(imp2.drafts).toHaveLength(1);

    // 3) Preview: the draft matches the committed pdf tx; same source (pdf) → duplicate.
    const preview = await app.inject({
      method: "POST",
      url: `/imports/${imp2.importId}/duplicates`,
      headers: auth(t),
      payload: { portfolioId },
    });
    expect(preview.statusCode).toBe(200);
    const { annotations } = preview.json() as {
      annotations: Array<{ draftIndex: number; kind: string }>;
    };
    expect(annotations).toHaveLength(1);
    expect(annotations[0].kind).toBe("duplicate");
  });

  it("upload-time annotate flags a dkb-pdf re-import vs a committed pdf tx as duplicate", async () => {
    // Issue #351: the screenshot route used to pass the literal "screenshot" to
    // annotateLikelyDuplicates instead of the resolved parser tag, so a dkb-pdf re-import
    // matching an existing pdf-sourced tx was flagged "enrichment" at upload time — disagreeing
    // with the /duplicates review route (which says "duplicate"). Passing the real tag aligns them.
    const t = await token("dkb-pdf-upload-dup");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "DKB-upload-dup", baseCurrency: "EUR" },
      })
    ).json().id;

    // 1) Import + confirm the DKB dividend PDF → a committed transaction with source="pdf".
    const form1 = pdfPart(Buffer.from("%PDF-1.4 upload-dup-first"), "ud1.pdf");
    const imp1 = (
      await app.inject({
        method: "POST",
        url: "/imports/screenshot",
        headers: { ...auth(t), ...form1.headers },
        payload: form1.payload,
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/imports/${imp1.importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId, transactions: imp1.drafts },
    });

    // 2) Re-import the same statement (force past file-level dedup). The upload response's
    // drafts carry the upload-time likelyDuplicate annotation against the sole portfolio.
    const form2 = pdfPart(Buffer.from("%PDF-1.4 upload-dup-second"), "ud2.pdf");
    const res = await app.inject({
      method: "POST",
      url: "/imports/screenshot?force=true",
      headers: { ...auth(t), ...form2.headers },
      payload: form2.payload,
    });
    expect(res.statusCode).toBe(201);
    const draft = res.json().drafts[0] as { likelyDuplicate?: { kind: string } };
    expect(draft.likelyDuplicate?.kind).toBe("duplicate");
  });

  it("skips the deterministic parser when the strategy is vision_only", async () => {
    // Flip the global strategy: the same recognised DKB PDF must now go to vision,
    // which (the exploding parser) throws → 502, proving the deterministic path is bypassed.
    await app.db
      .insert(importSettings)
      .values({ id: IMPORT_SETTINGS_ID, strategy: "vision_only" })
      .onConflictDoUpdate({
        target: importSettings.id,
        set: { strategy: "vision_only" },
      });
    try {
      const t = await token("dkb-pdf-vision-only");
      const form = pdfPart(Buffer.from("%PDF-1.4 vision-only"), "vision-only.pdf");
      const res = await app.inject({
        method: "POST",
        url: "/imports/screenshot",
        headers: { ...auth(t), ...form.headers },
        payload: form.payload,
      });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ error: "screenshot_parse_failed" });
    } finally {
      // Restore the default so the deterministic assertions above stay order-independent.
      await app.db
        .insert(importSettings)
        .values({ id: IMPORT_SETTINGS_ID, strategy: "parser_first" })
        .onConflictDoUpdate({
          target: importSettings.id,
          set: { strategy: "parser_first" },
        });
    }
  });
});
