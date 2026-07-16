/**
 * Integration tests for the receipt-storage lifecycle wired into import routes:
 *
 * - CSV upload stages a document in storage
 * - retention=true → confirm keeps the doc (status="retained"), GET document-url works
 * - retention=false (default) → confirm deletes staged bytes, document-url 404s
 * - discard cleans staged bytes
 * - undo (DELETE /imports/:id) cleans retained bytes
 * - portfolio delete removes storage objects
 * - document-url rejects a cross-user document id (IDOR guard)
 * - documentRetention round-trips on portfolio create/PATCH
 *
 * Uses buildApp({ storage: makeTrackingStorage() }) so no real S3/MinIO needed.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import type { StorageProvider } from "../../src/storage/types.js";
import { documents, screenshotImports, users } from "@portfolio/db";
import { eq as _eq } from "drizzle-orm";

const ISSUER = "https://auth.test/application/o/portfolio/";
const AUDIENCE = "portfolio-tracker";

type App = Awaited<ReturnType<typeof buildApp>>;

/** In-memory storage that records put/delete calls and can serve signed URLs. */
function makeTrackingStorage(): StorageProvider & {
  puts: string[];
  deletes: string[];
  data: Map<string, Buffer>;
} {
  const puts: string[] = [];
  const deletes: string[] = [];
  const data = new Map<string, Buffer>();
  return {
    puts,
    deletes,
    data,
    put: async (key, body) => {
      puts.push(key);
      data.set(key, body instanceof Buffer ? body : Buffer.from("bytes"));
    },
    getSignedUrl: async (key) => `https://fake.storage/${key}?sig=test`,
    delete: async (key) => {
      deletes.push(key);
      data.delete(key);
    },
    exists: async (key) => data.has(key),
    get: async (key) => data.get(key) ?? null,
    move: async (src, dest) => {
      const buf = data.get(src);
      if (buf) {
        data.set(dest, buf);
        data.delete(src);
      }
    },
  };
}

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

// Minimal CSV to import one transaction.
const CSV = `date,action,assetClass,ticker,name,quantity,unit,price,fees,currency
2026-03-01,buy,equity,BBCA,Bank Central Asia,100,shares,9500,0,IDR`;

// ----- Shared app instance across all tests in this file ---------------------

let app: App;
let store: ReturnType<typeof makeTrackingStorage>;
let privateKey: CryptoKey;

beforeAll(async () => {
  const kp = await generateKeyPair("ES256");
  privateKey = kp.privateKey;
  process.env.AUTHENTIK_ISSUER = ISSUER;
  process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
  process.env.RATE_LIMIT_MAX = "50000";
  store = makeTrackingStorage();
  app = await buildApp({ authKey: kp.publicKey, storage: store });
}, 30_000);

afterAll(async () => {
  await app.close();
  await closeDb();
  delete process.env.AUTHENTIK_ISSUER;
  delete process.env.AUTHENTIK_AUDIENCE;
  delete process.env.RATE_LIMIT_MAX;
});

// Helper: register a user + portfolio, return their token, portfolioId, and the
// full create response (which includes documentRetention).
async function setup(sub: string, documentRetention = false) {
  const t = await makeToken(privateKey, sub);
  await app.inject({ method: "GET", url: "/me", headers: auth(t) }); // upsert user
  const portRes = await app.inject({
    method: "POST",
    url: "/portfolios",
    headers: auth(t),
    payload: { name: "Test", baseCurrency: "IDR", documentRetention },
  });
  expect(portRes.statusCode).toBe(201);
  const portfolio = portRes.json() as { id: string; documentRetention: boolean };
  return { t, portfolioId: portfolio.id, portfolio };
}

// Helper: upload a CSV and return the import record.
async function uploadCsv(t: string, content = CSV) {
  const res = await app.inject({
    method: "POST",
    url: "/imports/csv",
    headers: auth(t),
    payload: { content },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { importId: string; drafts: unknown[] };
}

// Helper: confirm an import.
async function confirmImport(t: string, portfolioId: string, importId: string, drafts: unknown[]) {
  const res = await app.inject({
    method: "POST",
    url: `/imports/${importId}/confirm`,
    headers: auth(t),
    payload: { portfolioId, transactions: drafts },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { confirmed: number; transactions: Array<{ id: string }> };
}

// =============================================================================
// documentRetention portfolio flag round-trip
// =============================================================================

describe("documentRetention portfolio flag", () => {
  it("defaults to false on portfolio create", async () => {
    const { portfolio } = await setup("ret-default");
    expect(portfolio.documentRetention).toBe(false);
  });

  it("round-trips documentRetention=true on create", async () => {
    const { portfolio } = await setup("ret-true", true);
    expect(portfolio.documentRetention).toBe(true);
  });

  it("can be toggled via PATCH", async () => {
    const { t, portfolioId } = await setup("ret-patch", false);
    const patch = await app.inject({
      method: "PATCH",
      url: `/portfolios/${portfolioId}`,
      headers: auth(t),
      payload: { documentRetention: true },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().documentRetention).toBe(true);
  });

  it("appears in GET /portfolios list", async () => {
    const { t, portfolioId } = await setup("ret-list", true);
    const listRes = await app.inject({ method: "GET", url: "/portfolios", headers: auth(t) });
    expect(listRes.statusCode).toBe(200);
    const row = (listRes.json() as Array<{ id: string; documentRetention: boolean }>).find(
      (r) => r.id === portfolioId,
    );
    expect(row?.documentRetention).toBe(true);
  });
});

// =============================================================================
// Stage at upload
// =============================================================================

describe("CSV upload stages a document in storage", () => {
  it("puts a receipts/ object immediately after upload", async () => {
    const { t } = await setup("stage-upload");
    const putsBefore = store.puts.length;
    await uploadCsv(t);
    const putsAfter = store.puts.length;
    const newPuts = store.puts.slice(putsBefore);
    expect(putsAfter).toBeGreaterThan(putsBefore);
    expect(newPuts.some((k) => k.startsWith("receipts/"))).toBe(true);
  });
});

// =============================================================================
// Retention OFF (default) — confirm deletes staged bytes
// =============================================================================

describe("retention=false (default) — confirm prunes staged bytes", () => {
  it("deletes the staged object after confirm when retention is off", async () => {
    const { t, portfolioId } = await setup("prune-user", false);
    const putsBefore = store.puts.length;
    const { importId, drafts } = await uploadCsv(t);

    // The file was staged.
    const newKey = store.puts.slice(putsBefore).find((k) => k.startsWith("receipts/"));
    expect(newKey).toBeTruthy();

    const deletesBefore = store.deletes.length;
    await confirmImport(t, portfolioId, importId, drafts as unknown[]);

    // The staged object was deleted at confirm.
    const newDeletes = store.deletes.slice(deletesBefore);
    expect(newDeletes).toContain(newKey);
  });

  it("document-url returns 404 for a non-retained import", async () => {
    const { t, portfolioId } = await setup("no-doc-user", false);
    const { importId, drafts } = await uploadCsv(t);
    await confirmImport(t, portfolioId, importId, drafts as unknown[]);

    const res = await app.inject({
      method: "GET",
      url: `/imports/${importId}/document-url`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(404);
  });
});

// =============================================================================
// Retention ON — confirm keeps bytes, download URL works
// =============================================================================

describe("retention=true — confirm retains bytes, download URL issued", () => {
  it("does NOT delete the staged object after confirm when retention is on", async () => {
    const { t, portfolioId } = await setup("retain-user", true);
    const putsBefore = store.puts.length;
    const { importId, drafts } = await uploadCsv(t);

    const newKey = store.puts.slice(putsBefore).find((k) => k.startsWith("receipts/"));
    expect(newKey).toBeTruthy();

    const deletesBefore = store.deletes.length;
    await confirmImport(t, portfolioId, importId, drafts as unknown[]);

    // The staged object was NOT deleted (retention is on).
    const newDeletes = store.deletes.slice(deletesBefore);
    expect(newDeletes).not.toContain(newKey);
  });

  it("document-url returns a signed URL for a retained import", async () => {
    const { t, portfolioId } = await setup("retain-url-user", true);
    const { importId, drafts } = await uploadCsv(t);
    await confirmImport(t, portfolioId, importId, drafts as unknown[]);

    const res = await app.inject({
      method: "GET",
      url: `/imports/${importId}/document-url`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { url: string; mimeType: string };
    expect(body.url).toMatch(/^https:\/\/fake\.storage\//);
    expect(body.mimeType).toBe("text/csv");
  });

  it("transaction document-url resolves the import's receipt", async () => {
    const { t, portfolioId } = await setup("tx-doc-user", true);
    const { importId, drafts } = await uploadCsv(t);
    const { transactions: txns } = await confirmImport(
      t,
      portfolioId,
      importId,
      drafts as unknown[],
    );
    const txId = txns[0].id;

    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions/${txId}/document-url`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toMatch(/^https:\/\/fake\.storage\//);
  });

  it("per-source document-url falls back to the import receipt when the CSV source row has no documentId", async () => {
    const { t, portfolioId } = await setup("src-doc-user", true);
    const { importId, drafts } = await uploadCsv(t);
    const { transactions: txns } = await confirmImport(
      t,
      portfolioId,
      importId,
      drafts as unknown[],
    );
    const txId = txns[0].id;

    // Read the transaction's source rows: a CSV source has documentId=null but is
    // downloadable via the import-linked receipt (hasDocument=true).
    const listRes = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions`,
      headers: auth(t),
    });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json() as Array<{
      id: string;
      sources: Array<{
        id: string;
        documentId: string | null;
        hasDocument: boolean;
        filename: string | null;
      }>;
    }>;
    const src = list.find((r) => r.id === txId)!.sources[0];
    expect(src.documentId).toBeNull();
    expect(src.hasDocument).toBe(true);

    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions/${txId}/sources/${src.id}/document-url`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { url: string; mimeType: string };
    expect(body.url).toMatch(/^https:\/\/fake\.storage\//);
    expect(body.mimeType).toBe("text/csv");
  });

  it("GET /imports includes document summary for retained docs", async () => {
    const { t, portfolioId } = await setup("list-doc-user", true);
    const { importId, drafts } = await uploadCsv(t);
    await confirmImport(t, portfolioId, importId, drafts as unknown[]);

    const listRes = await app.inject({ method: "GET", url: "/imports", headers: auth(t) });
    expect(listRes.statusCode).toBe(200);
    const row = (listRes.json() as Array<{ id: string; document: unknown }>).find(
      (r) => r.id === importId,
    );
    expect(row).toBeTruthy();
    expect(row!.document).not.toBeNull();
    const doc = row!.document as { mimeType: string };
    expect(doc.mimeType).toBe("text/csv");
  });
});

// =============================================================================
// Discard cleans staged bytes
// =============================================================================

describe("discard cleans staged bytes", () => {
  it("deletes the staged object when a draft is discarded", async () => {
    const { t } = await setup("discard-user");
    const putsBefore = store.puts.length;
    const { importId } = await uploadCsv(t);

    const newKey = store.puts.slice(putsBefore).find((k) => k.startsWith("receipts/"));
    expect(newKey).toBeTruthy();

    const deletesBefore = store.deletes.length;
    const discard = await app.inject({
      method: "POST",
      url: `/imports/${importId}/discard`,
      headers: auth(t),
    });
    expect(discard.statusCode).toBe(204);

    const newDeletes = store.deletes.slice(deletesBefore);
    expect(newDeletes).toContain(newKey);
  });
});

// =============================================================================
// Undo (DELETE /imports/:id) cleans retained bytes
// =============================================================================

describe("undo import cleans retained bytes", () => {
  it("deletes the retained object when an import is undone", async () => {
    const { t, portfolioId } = await setup("undo-user", true);
    const { importId, drafts } = await uploadCsv(t);
    await confirmImport(t, portfolioId, importId, drafts as unknown[]);

    const deletesBefore = store.deletes.length;
    const undo = await app.inject({
      method: "DELETE",
      url: `/imports/${importId}`,
      headers: auth(t),
    });
    expect(undo.statusCode).toBe(200);

    // After confirm, the document was re-keyed to a structured path; after undo it must
    // be cleaned up — whatever the current key is.
    const newDeletes = store.deletes.slice(deletesBefore);
    expect(newDeletes.some((k) => k.startsWith("receipts/"))).toBe(true);
  });
});

// =============================================================================
// IDOR guard — cross-user document access is rejected
// =============================================================================

describe("IDOR guard on document-url endpoints", () => {
  it("returns 404 when requesting another user's import document-url", async () => {
    // User A uploads + retains a doc.
    const userA = await setup("idor-user-a", true);
    const { importId, drafts } = await uploadCsv(userA.t);
    await confirmImport(userA.t, userA.portfolioId, importId, drafts as unknown[]);

    // User B tries to fetch the URL for user A's import.
    const userB = await setup("idor-user-b", false);
    const res = await app.inject({
      method: "GET",
      url: `/imports/${importId}/document-url`,
      headers: auth(userB.t),
    });
    // Must be 404 — should not reveal the document or its signed URL.
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 when requesting another user's transaction document-url", async () => {
    // User C: retain doc and get a transaction id.
    const userC = await setup("idor-user-c", true);
    const csv2 = `date,action,assetClass,ticker,name,quantity,unit,price,fees,currency\n2026-03-02,buy,equity,BMRI,Bank Mandiri,50,shares,6000,0,IDR`;
    const { importId, drafts } = await uploadCsv(userC.t, csv2);
    const { transactions: txns } = await confirmImport(
      userC.t,
      userC.portfolioId,
      importId,
      drafts as unknown[],
    );
    const txId = txns[0].id;

    // User D attempts to access user C's transaction document.
    const userD = await setup("idor-user-d", false);
    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${userC.portfolioId}/transactions/${txId}/document-url`,
      headers: auth(userD.t),
    });
    // The portfolio doesn't belong to user D → 404.
    expect(res.statusCode).toBe(404);
  });
});

// =============================================================================
// Portfolio delete removes storage objects
// =============================================================================

describe("portfolio delete removes retained storage objects", () => {
  it("deletes retained objects before removing the portfolio", async () => {
    const { t, portfolioId } = await setup("portdel-user", true);
    const { importId, drafts } = await uploadCsv(t);
    await confirmImport(t, portfolioId, importId, drafts as unknown[]);

    const deletesBefore = store.deletes.length;
    const del = await app.inject({
      method: "DELETE",
      url: `/portfolios/${portfolioId}`,
      headers: auth(t),
    });
    expect(del.statusCode).toBe(204);

    // After confirm the doc was re-keyed; on portfolio delete the structured key is removed.
    const newDeletes = store.deletes.slice(deletesBefore);
    expect(newDeletes.some((k) => k.startsWith("receipts/"))).toBe(true);
  });

  // Guards the DELETE /portfolios ownership-check-before-file-delete ordering: a
  // non-owner's request must 404 WITHOUT touching the victim's storage objects.
  it("a non-owner's delete attempt 404s and leaves the victim's storage objects untouched", async () => {
    const { t: victim, portfolioId } = await setup("portdel-victim", true);
    const { importId, drafts } = await uploadCsv(victim);
    await confirmImport(victim, portfolioId, importId, drafts as unknown[]);

    const attacker = await makeToken(privateKey, "portdel-attacker");
    await app.inject({ method: "GET", url: "/me", headers: auth(attacker) }); // upsert user

    const deletesBefore = store.deletes.length;
    const dataSizeBefore = store.data.size;
    const cross = await app.inject({
      method: "DELETE",
      url: `/portfolios/${portfolioId}`,
      headers: auth(attacker),
    });
    expect(cross.statusCode).toBe(404);

    // No storage objects were deleted, and the document row itself still exists.
    expect(store.deletes.length).toBe(deletesBefore);
    expect(store.data.size).toBe(dataSizeBefore);
    const [doc] = await app.db
      .select({ id: documents.id })
      .from(documents)
      .where(_eq(documents.portfolioId, portfolioId));
    expect(doc).toBeDefined();

    // The owner can still delete it for real afterwards.
    const ownerDelete = await app.inject({
      method: "DELETE",
      url: `/portfolios/${portfolioId}`,
      headers: auth(victim),
    });
    expect(ownerDelete.statusCode).toBe(204);
  });
});

// =============================================================================
// document-url auth guards
// =============================================================================

describe("document-url requires authentication", () => {
  it("GET /imports/:id/document-url returns 401 without token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/imports/00000000-0000-0000-0000-000000000000/document-url",
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /portfolios/:pid/transactions/:txId/document-url returns 401 without token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/portfolios/00000000-0000-0000-0000-000000000000/transactions/00000000-0000-0000-0000-000000000001/document-url",
    });
    expect(res.statusCode).toBe(401);
  });
});

// =============================================================================
// TR pytr: confirm links staged docs to transactions via sourceEventId (#243)
// =============================================================================

// Minimal pytr draft shape consumed by the confirm route.
const PYTR_DRAFT = {
  externalId: "ev-tr-1",
  action: "deposit" as const,
  ticker: null,
  isin: null,
  name: null,
  quantity: "0",
  price: "0",
  fees: "0",
  currency: "EUR",
  executedAt: "2026-03-01T10:00:00.000Z",
  assetClass: null,
  unit: null,
  confidence: 1,
  documentRefs: [{ id: "doc-tr-1", type: "SECURITIES_SETTLEMENT", date: "2026-03-01" }],
};

/** Resolve the userId for a test user (registered via /me). */
async function getUserId(email: string): Promise<string> {
  const [row] = await app.db
    .select({ id: users.id })
    .from(users)
    .where(_eq(users.email, email))
    .limit(1);
  if (!row) throw new Error(`user not found: ${email}`);
  return row.id;
}

describe("TR pytr confirm: links staged docs to transactions (AC #1, #2)", () => {
  it("sets transactionId on staged doc at confirm and document-url resolves by txId", async () => {
    const { t, portfolioId } = await setup("tr-link-user", true);
    const userId = await getUserId("tr-link-user@test.example");

    // Insert a fake pytr collector import (mirrors what syncTrConnection creates).
    const [collector] = await app.db
      .insert(screenshotImports)
      .values({
        userId,
        portfolioId,
        parser: "pytr",
        status: "draft",
        parsedJson: { drafts: [PYTR_DRAFT], errors: [] },
      })
      .returning();

    // Simulate what syncTrConnection would have staged: a doc with sourceEventId.
    const stagePutKey = `receipts/${userId}/${collector.id}/doc-tr-1.pdf`;
    await store.put(stagePutKey, Buffer.from("%PDF fake"), { mimeType: "application/pdf" });
    await app.db.insert(documents).values({
      userId,
      importId: collector.id,
      storageKey: stagePutKey,
      mimeType: "application/pdf",
      originalFilename: "doc-tr-1.pdf",
      sizeBytes: 9,
      status: "staged",
      source: "pytr",
      sourceEventId: "ev-tr-1",
    });

    // Confirm — triggers linkTrReceiptsToTransactions then finalizeReceipts.
    const confirmRes = await app.inject({
      method: "POST",
      url: `/imports/${collector.id}/confirm`,
      headers: auth(t),
      payload: { portfolioId, transactions: [PYTR_DRAFT] },
    });
    expect(confirmRes.statusCode).toBe(201);
    const { transactions: written } = confirmRes.json() as {
      confirmed: number;
      transactions: Array<{ id: string }>;
    };
    expect(written).toHaveLength(1);
    const txId = written[0].id;

    // The document row must have transactionId set and status="retained".
    const [doc] = await app.db
      .select()
      .from(documents)
      .where(_eq(documents.importId, collector.id));
    expect(doc.transactionId).toBe(txId);
    expect(doc.status).toBe("retained");

    // AC #2: GET document-url by transactionId returns a signed URL.
    const urlRes = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions/${txId}/document-url`,
      headers: auth(t),
    });
    expect(urlRes.statusCode).toBe(200);
    const body = urlRes.json() as { url: string; mimeType: string };
    expect(body.url).toMatch(/^https:\/\/fake\.storage\//);
    expect(body.mimeType).toBe("application/pdf");
  });

  it("retention=false: TR staged doc is deleted at confirm, document-url 404s", async () => {
    const { t, portfolioId } = await setup("tr-no-retain-user", false);
    const userId = await getUserId("tr-no-retain-user@test.example");

    const draft2 = { ...PYTR_DRAFT, externalId: "ev-tr-nore" };

    const [collector] = await app.db
      .insert(screenshotImports)
      .values({
        userId,
        portfolioId,
        parser: "pytr",
        status: "draft",
        parsedJson: { drafts: [draft2], errors: [] },
      })
      .returning();

    const stagePutKey = `receipts/${userId}/${collector.id}/doc-nore.pdf`;
    await store.put(stagePutKey, Buffer.from("%PDF fake"), { mimeType: "application/pdf" });
    await app.db.insert(documents).values({
      userId,
      importId: collector.id,
      storageKey: stagePutKey,
      mimeType: "application/pdf",
      originalFilename: "doc-nore.pdf",
      sizeBytes: 9,
      status: "staged",
      source: "pytr",
      sourceEventId: "ev-tr-nore",
    });

    const deletesBefore = store.deletes.length;
    const confirmRes = await app.inject({
      method: "POST",
      url: `/imports/${collector.id}/confirm`,
      headers: auth(t),
      payload: { portfolioId, transactions: [draft2] },
    });
    expect(confirmRes.statusCode).toBe(201);
    const { transactions: written } = confirmRes.json() as { transactions: Array<{ id: string }> };
    const txId = written[0].id;

    // The staged doc should have been deleted (retention=false).
    const newDeletes = store.deletes.slice(deletesBefore);
    expect(newDeletes).toContain(stagePutKey);

    // document-url must 404 (no retained doc).
    const urlRes = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions/${txId}/document-url`,
      headers: auth(t),
    });
    expect(urlRes.statusCode).toBe(404);
  });
});
