/**
 * Unit tests for services/api/src/storage/inbox.ts — the tax-reports inbox document
 * lifecycle (deliberately separate from receipts.ts's staging/GC lifecycle).
 *
 * Uses a real buildApp() (embedded PGlite) with an in-memory tracking StorageProvider so
 * storeInboxDocument's onConflictDoNothing dedup and gcStagedReceipts' status filter are
 * exercised against real SQL, not a mock.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { portfolios } from "@portfolio/db";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import type { StorageProvider } from "../../src/storage/types.js";
import {
  buildInboxKey,
  storeInboxDocument,
  deleteInboxDocument,
  listInboxDocuments,
  getInboxDocument,
} from "../../src/storage/inbox.js";
import { gcStagedReceipts } from "../../src/storage/receipts.js";

const ISSUER = "https://auth.test/application/o/portfolio/";
const AUDIENCE = "portfolio-tracker";

type App = Awaited<ReturnType<typeof buildApp>>;

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

/** Register a user (upserts via /me) and return their id. */
async function ensureUser(sub: string): Promise<string> {
  const t = await makeToken(privateKey, sub);
  const res = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${t}` } });
  return (res.json() as { id: string }).id;
}

/** Insert a bare portfolio for a user — portfolioId is now required on every inbox doc. */
async function ensurePortfolio(userId: string): Promise<string> {
  const [row] = await app.db.insert(portfolios).values({ userId, name: "Test" }).returning({ id: portfolios.id });
  return row.id;
}

const appLike = () => app as unknown as Parameters<typeof storeInboxDocument>[0];

describe("buildInboxKey", () => {
  it("produces inbox/{userId}/{category}/{year}/{filename}", () => {
    expect(buildInboxKey("u1", "tax_report", 2025, "report.pdf")).toBe(
      "inbox/u1/tax_report/2025/report.pdf",
    );
  });

  it("falls back to 'misc' when taxYear is absent", () => {
    expect(buildInboxKey("u1", "tax_report", null, "report.pdf")).toBe(
      "inbox/u1/tax_report/misc/report.pdf",
    );
  });

  it("sanitises the filename", () => {
    expect(buildInboxKey("u1", "tax_report", 2025, "../../etc/passwd")).toBe(
      "inbox/u1/tax_report/2025/passwd",
    );
  });
});

describe("storeInboxDocument", () => {
  it("stores a document directly as status=retained (not staged)", async () => {
    const userId = await ensureUser("inbox-store-1");
    const portfolioId = await ensurePortfolio(userId);
    const result = await storeInboxDocument(appLike(), {
      userId,
      portfolioId,
      category: "tax_report",
      taxYear: 2025,
      buf: Buffer.from("pdf bytes"),
      mimeType: "application/pdf",
      originalFilename: "steuerreport-2025.pdf",
      source: "pytr",
      sourceEventId: "evt-store-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = await getInboxDocument(app, result.documentId);
    expect(doc).toMatchObject({
      userId,
      portfolioId,
      category: "tax_report",
      taxYear: 2025,
      source: "pytr",
    });
  });

  it("is idempotent on (userId, sourceEventId): a re-fetch is a no-op, no duplicate row", async () => {
    const userId = await ensureUser("inbox-store-2");
    const portfolioId = await ensurePortfolio(userId);
    const opts = {
      userId,
      portfolioId,
      category: "tax_report" as const,
      taxYear: 2025,
      buf: Buffer.from("pdf bytes"),
      mimeType: "application/pdf",
      originalFilename: "steuerreport-2025.pdf",
      source: "pytr",
      sourceEventId: "evt-store-2",
    };
    const first = await storeInboxDocument(appLike(), opts);
    const second = await storeInboxDocument(appLike(), opts);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.documentId).toBe(first.documentId);
    expect(second.duplicate).toBe(true);

    const docs = await listInboxDocuments(app, { userId, category: "tax_report" });
    const matching = docs.filter((d) => d.id === first.documentId);
    expect(matching).toHaveLength(1);
  });

  it("uploads (no sourceEventId) are independent rows, not deduped against each other", async () => {
    const userId = await ensureUser("inbox-store-3");
    const portfolioId = await ensurePortfolio(userId);
    const a = await storeInboxDocument(appLike(), {
      userId,
      portfolioId,
      category: "tax_report",
      buf: Buffer.from("a"),
      mimeType: "application/pdf",
      source: "upload",
    });
    const b = await storeInboxDocument(appLike(), {
      userId,
      portfolioId,
      category: "tax_report",
      buf: Buffer.from("b"),
      mimeType: "application/pdf",
      source: "upload",
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.documentId).not.toBe(b.documentId);
  });
});

describe("deleteInboxDocument", () => {
  it("removes both the storage object and the row", async () => {
    const userId = await ensureUser("inbox-delete-1");
    const portfolioId = await ensurePortfolio(userId);
    const result = await storeInboxDocument(appLike(), {
      userId,
      portfolioId,
      category: "tax_report",
      buf: Buffer.from("to be deleted"),
      mimeType: "application/pdf",
      source: "upload",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = await getInboxDocument(app, result.documentId);
    expect(doc).not.toBeNull();
    if (!doc) return;

    expect(store.data.has(doc.storageKey)).toBe(true);
    await deleteInboxDocument(appLike(), { documentId: doc.id, storageKey: doc.storageKey });

    expect(store.data.has(doc.storageKey)).toBe(false);
    expect(await getInboxDocument(app, result.documentId)).toBeNull();
  });
});

describe("gcStagedReceipts does not sweep inbox documents", () => {
  it("a retained tax_report document survives a GC run (only status=staged is swept)", async () => {
    const userId = await ensureUser("inbox-gc-1");
    const portfolioId = await ensurePortfolio(userId);
    const result = await storeInboxDocument(appLike(), {
      userId,
      portfolioId,
      category: "tax_report",
      buf: Buffer.from("survives gc"),
      mimeType: "application/pdf",
      source: "upload",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // maxAgeDays=0 would sweep every staged doc regardless of age — the strictest possible
    // GC run. An inbox doc must survive it purely because it's never status="staged".
    await gcStagedReceipts(appLike(), 0);

    // Surviving the GC run at all (row + storage object both still present) is the
    // assertion — InboxDocumentMeta doesn't expose `status`, but a swept row would be gone.
    const doc = await getInboxDocument(app, result.documentId);
    expect(doc).not.toBeNull();
    expect(store.data.has(doc!.storageKey)).toBe(true);
  });
});
