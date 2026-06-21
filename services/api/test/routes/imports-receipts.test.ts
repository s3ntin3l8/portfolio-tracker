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
    const { transactions: txns } = await confirmImport(t, portfolioId, importId, drafts as unknown[]);
    const txId = txns[0].id;

    const res = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/transactions/${txId}/document-url`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toMatch(/^https:\/\/fake\.storage\//);
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
    const putsBefore = store.puts.length;
    const { importId, drafts } = await uploadCsv(t);

    const newKey = store.puts.slice(putsBefore).find((k) => k.startsWith("receipts/"));
    expect(newKey).toBeTruthy();

    await confirmImport(t, portfolioId, importId, drafts as unknown[]);

    const deletesBefore = store.deletes.length;
    const undo = await app.inject({
      method: "DELETE",
      url: `/imports/${importId}`,
      headers: auth(t),
    });
    expect(undo.statusCode).toBe(200);

    const newDeletes = store.deletes.slice(deletesBefore);
    expect(newDeletes).toContain(newKey);
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
    const { transactions: txns } = await confirmImport(userC.t, userC.portfolioId, importId, drafts as unknown[]);
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
    const putsBefore = store.puts.length;
    const { importId, drafts } = await uploadCsv(t);

    const newKey = store.puts.slice(putsBefore).find((k) => k.startsWith("receipts/"));
    expect(newKey).toBeTruthy();

    await confirmImport(t, portfolioId, importId, drafts as unknown[]);

    const deletesBefore = store.deletes.length;
    const del = await app.inject({
      method: "DELETE",
      url: `/portfolios/${portfolioId}`,
      headers: auth(t),
    });
    expect(del.statusCode).toBe(204);

    const newDeletes = store.deletes.slice(deletesBefore);
    expect(newDeletes).toContain(newKey);
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
