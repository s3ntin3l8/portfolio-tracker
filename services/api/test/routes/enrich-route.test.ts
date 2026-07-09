/**
 * Route tests for the enrich contract fix + per-source document-url endpoint (PR2 backend addendum).
 *
 * Enrich route contract (after the draftIndex→draft-payload fix):
 *  - accepts { draft: ParsedTransaction, targetTransactionId } — NOT a draftIndex
 *  - 404 if the importId is unknown or belongs to another user
 *  - enriches the target tx and writes a source row on success
 *  - skips (index into enrichments array) when targetTransactionId is IDOR-blocked
 *
 * Per-source document-url:
 *  - 404 when sourceId not found, or source row has no documentId
 *  - 403/404 when the source belongs to another user's transaction (IDOR)
 *  - 200 with signed URL when the source row has a documentId owned by the user
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { generateKeyPair, SignJWT } from "jose";
import { buildApp } from "../../src/app.js";
import { closeDb, getDb } from "../../src/db/client.js";
import {
  documents,
  screenshotImports,
  transactions,
  transactionSources,
  users,
} from "@portfolio/db";
import type { StorageProvider } from "../../src/storage/types.js";

const ISSUER = "https://auth.test/application/o/portfolio/";
const AUDIENCE = "portfolio-tracker";
type App = Awaited<ReturnType<typeof buildApp>>;

// ---------------------------------------------------------------------------
// In-memory storage
// ---------------------------------------------------------------------------

function makeStorage(): StorageProvider & { data: Map<string, Buffer> } {
  const data = new Map<string, Buffer>();
  return {
    data,
    put: async (key, body, _meta) => { data.set(key, body instanceof Buffer ? body : Buffer.from("pdf-bytes")); },
    getSignedUrl: async (key) => `https://fake.storage/${key}?sig=test`,
    delete: async (key) => { data.delete(key); },
    exists: async (key) => data.has(key),
    get: async (key) => data.get(key) ?? null,
    move: async (src, dest) => {
      const buf = data.get(src);
      if (buf) { data.set(dest, buf); data.delete(src); }
    },
  };
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

async function makeToken(privateKey: CryptoKey, sub: string) {
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

// ---------------------------------------------------------------------------
// Shared app
// ---------------------------------------------------------------------------

let app: App;
let storage: ReturnType<typeof makeStorage>;
let privateKey: CryptoKey;

beforeAll(async () => {
  const kp = await generateKeyPair("ES256");
  privateKey = kp.privateKey;
  process.env.AUTHENTIK_ISSUER = ISSUER;
  process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
  process.env.RATE_LIMIT_MAX = "50000";
  storage = makeStorage();
  app = await buildApp({ authKey: kp.publicKey, storage });
}, 30_000);

afterAll(async () => {
  await app.close();
  await closeDb();
  delete process.env.AUTHENTIK_ISSUER;
  delete process.env.AUTHENTIK_AUDIENCE;
  delete process.env.RATE_LIMIT_MAX;
});

// ---------------------------------------------------------------------------
// Per-test helpers
// ---------------------------------------------------------------------------

let uidSuffix = 0;
function nextSub() { return `enrich-rt-${++uidSuffix}`; }

/** Register a user (via /me) and create a portfolio. Returns token + ids. */
async function setupUser(sub: string, documentRetention = false) {
  const t = await makeToken(privateKey, sub);
  await app.inject({ method: "GET", url: "/me", headers: auth(t) });
  const portRes = await app.inject({
    method: "POST",
    url: "/portfolios",
    headers: auth(t),
    payload: { name: "Test", baseCurrency: "EUR", documentRetention },
  });
  expect(portRes.statusCode).toBe(201);
  const portfolioId = portRes.json().id as string;
  // Retrieve the internal DB user id (needed for direct DB inserts).
  const db = getDb();
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.authSub, sub))
    .limit(1);
  if (!user) throw new Error(`user not found for sub=${sub}`);
  return { t, portfolioId, userId: user.id };
}

/** Insert a minimal transaction directly into the DB. */
async function insertTx(portfolioId: string) {
  const db = getDb();
  const [tx] = await db
    .insert(transactions)
    .values({
      portfolioId,
      type: "buy",
      source: "csv",
      quantity: "10",
      price: "100.00",
      currency: "EUR",
      executedAt: new Date("2025-03-01"),
    })
    .returning();
  return tx;
}

/** Insert a minimal screenshotImports row for the enrich route's ownedImport check. */
async function insertImport(userId: string, portfolioId: string) {
  const db = getDb();
  const [imp] = await db
    .insert(screenshotImports)
    .values({
      userId,
      portfolioId,
      parser: "csv",
      status: "confirmed",
      parsedJson: { drafts: [] },
    })
    .returning();
  return imp;
}

// A minimal valid ParsedTransaction payload (draft payload the frontend sends to the enrich route).
const VALID_DRAFT = {
  action: "buy",
  isin: "IE00B5BMR087",
  name: "iShares Core MSCI World",
  quantity: "10",
  price: "100.00",
  currency: "EUR",
  executedAt: new Date("2025-03-01").toISOString(),
  confidence: 1,
  unit: "shares",
  tax: "3.96",
  fees: "1.00",
  taxComponents: { kapitalertragsteuer: "3.75", solidaritaetszuschlag: "0.21" },
};

// =============================================================================
// Enrich route — draft payload contract
// =============================================================================

describe("POST /imports/:importId/enrich — draft payload (not draftIndex)", () => {
  it("returns 404 for an unknown importId", async () => {
    const { t } = await setupUser(nextSub());
    const res = await app.inject({
      method: "POST",
      url: "/imports/00000000-0000-0000-0000-000000000001/enrich",
      headers: auth(t),
      payload: {
        enrichments: [{
          draft: VALID_DRAFT,
          targetTransactionId: "00000000-0000-0000-0000-000000000002",
        }],
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("import_not_found");
  });

  it("enriches the target tx, writes a source row, and returns enriched=1", async () => {
    const sub = nextSub();
    const { t, portfolioId, userId } = await setupUser(sub);
    const tx = await insertTx(portfolioId);
    const imp = await insertImport(userId, portfolioId);

    const res = await app.inject({
      method: "POST",
      url: `/imports/${imp.id}/enrich`,
      headers: auth(t),
      payload: {
        portfolioId,
        enrichments: [{ draft: VALID_DRAFT, targetTransactionId: tx.id }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { enriched: number; skipped: number[] };
    expect(body.enriched).toBe(1);
    expect(body.skipped).toHaveLength(0);

    // A transaction_sources row must have been written.
    const db = getDb();
    const sourceRows = await db
      .select({ sourceType: transactionSources.sourceType, tax: transactionSources.tax })
      .from(transactionSources)
      .where(eq(transactionSources.transactionId, tx.id));
    expect(sourceRows).toHaveLength(1);
    // Draft carries taxComponents → sourceType should be "pdf".
    expect(sourceRows[0].sourceType).toBe("pdf");
    expect(Number(sourceRows[0].tax)).toBeCloseTo(3.96, 2);
  });

  it("skips (IDOR) and returns skipped=[0] when targetTransactionId belongs to another user", async () => {
    const sub = nextSub();
    const sub2 = nextSub();
    const { t, portfolioId, userId } = await setupUser(sub);
    const { portfolioId: otherPortfolioId } = await setupUser(sub2);
    const otherTx = await insertTx(otherPortfolioId);
    const imp = await insertImport(userId, portfolioId);

    const res = await app.inject({
      method: "POST",
      url: `/imports/${imp.id}/enrich`,
      headers: auth(t),
      payload: {
        portfolioId,
        enrichments: [{ draft: VALID_DRAFT, targetTransactionId: otherTx.id }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { enriched: number; skipped: number[] };
    expect(body.enriched).toBe(0);
    expect(body.skipped).toContain(0);
  });
});

// =============================================================================
// GET /portfolios/:portfolioId/transactions/:txId/sources/:sourceId/document-url
// =============================================================================

describe("GET …/sources/:sourceId/document-url", () => {
  it("returns 404 when sourceId is not found", async () => {
    const { t, portfolioId } = await setupUser(nextSub());
    const tx = await insertTx(portfolioId);
    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions/${tx.id}/sources/00000000-0000-0000-0000-000000000099/document-url`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("source_not_found");
  });

  it("returns 404 when the source row has no documentId", async () => {
    const { t, portfolioId } = await setupUser(nextSub());
    const tx = await insertTx(portfolioId);
    const db = getDb();
    const [srcRow] = await db
      .insert(transactionSources)
      .values({ transactionId: tx.id, sourceType: "csv", documentId: null, externalId: "ext-no-doc" })
      .returning();

    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions/${tx.id}/sources/${srcRow.id}/document-url`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("document_not_found");
  });

  it("returns a signed URL when the source row has a documentId", async () => {
    const sub = nextSub();
    const { t, portfolioId, userId } = await setupUser(sub, true);
    const tx = await insertTx(portfolioId);
    const db = getDb();

    // Create import + document.
    const [imp] = await db
      .insert(screenshotImports)
      .values({ userId, portfolioId, parser: "csv", status: "confirmed", parsedJson: {} })
      .returning();
    const storageKey = `receipts/${userId}/${imp.id}/settlement.pdf`;
    await storage.put(storageKey, Buffer.from("pdf"), { mimeType: "application/pdf" });
    const [doc] = await db
      .insert(documents)
      .values({
        userId,
        portfolioId,
        importId: imp.id,
        transactionId: tx.id,
        storageKey,
        originalFilename: "settlement.pdf",
        mimeType: "application/pdf",
        sizeBytes: 3,
        status: "retained",
      })
      .returning();

    // Create source row linked to the document.
    const [srcRow] = await db
      .insert(transactionSources)
      .values({ transactionId: tx.id, sourceType: "pdf", documentId: doc.id, externalId: "tr:exec:src-url-1" })
      .returning();

    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions/${tx.id}/sources/${srcRow.id}/document-url`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { url: string; filename: string; mimeType: string };
    expect(body.url).toContain(storageKey);
    // filename is now a structured date-first name (the original "settlement.pdf" is no
    // longer returned — the endpoint builds a human-readable name from the transaction).
    expect(body.filename).toMatch(/^\d{4}-\d{2}-\d{2}_.*\.pdf$/);
    expect(body.mimeType).toBe("application/pdf");
  });

  it("IDOR-rejects when source belongs to another user's transaction", async () => {
    const sub = nextSub();
    const sub2 = nextSub();
    const { t, portfolioId } = await setupUser(sub);
    const { portfolioId: otherPortfolioId } = await setupUser(sub2);
    const otherTx = await insertTx(otherPortfolioId);
    const db = getDb();
    const [otherSrc] = await db
      .insert(transactionSources)
      .values({ transactionId: otherTx.id, sourceType: "csv" })
      .returning();

    // User tries to fetch a source row that belongs to another user's tx.
    // The tx is in otherPortfolioId, but we query as portfolioId (user's own),
    // so the transaction_not_found guard fires (the tx lookup includes portfolioId).
    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions/${otherTx.id}/sources/${otherSrc.id}/document-url`,
      headers: auth(t),
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it("resolves a synthetic doc:<documentId> source id (always-show-every-PDF entries)", async () => {
    const sub = nextSub();
    const { t, portfolioId, userId } = await setupUser(sub, true);
    const tx = await insertTx(portfolioId);
    const db = getDb();

    const [imp] = await db
      .insert(screenshotImports)
      .values({ userId, portfolioId, parser: "pytr", status: "confirmed", parsedJson: {} })
      .returning();
    const storageKey = `receipts/${userId}/${imp.id}/reklassifizierung.pdf`;
    await storage.put(storageKey, Buffer.from("pdf"), { mimeType: "application/pdf" });
    const [doc] = await db
      .insert(documents)
      .values({
        userId,
        portfolioId,
        importId: imp.id,
        transactionId: tx.id,
        storageKey,
        originalFilename: "reklassifizierung.pdf",
        mimeType: "application/pdf",
        sizeBytes: 3,
        status: "retained",
      })
      .returning();
    // No transaction_sources row claims this document — it's a rejected/unparsed doc that
    // sourcesForTransactions surfaces as a synthetic `doc:<id>` entry.

    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions/${tx.id}/sources/doc:${doc.id}/document-url`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { url: string; mimeType: string };
    expect(body.url).toContain(storageKey);
    expect(body.mimeType).toBe("application/pdf");
  });

  it("404s a doc:<documentId> id whose document isn't pinned to the requested transaction", async () => {
    const sub = nextSub();
    const { t, portfolioId, userId } = await setupUser(sub, true);
    const tx = await insertTx(portfolioId);
    const otherTx = await insertTx(portfolioId);
    const db = getDb();
    const storageKey = `receipts/${userId}/other-tx.pdf`;
    await storage.put(storageKey, Buffer.from("pdf"), { mimeType: "application/pdf" });
    const [doc] = await db
      .insert(documents)
      .values({
        userId,
        portfolioId,
        transactionId: otherTx.id, // pinned to a DIFFERENT transaction
        storageKey,
        originalFilename: "other-tx.pdf",
        mimeType: "application/pdf",
        sizeBytes: 3,
        status: "retained",
      })
      .returning();

    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions/${tx.id}/sources/doc:${doc.id}/document-url`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("document_not_found");
  });
});
