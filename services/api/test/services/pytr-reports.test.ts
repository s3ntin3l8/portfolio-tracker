/**
 * Unit tests for services/api/src/services/pytr/reports.ts — fetchReportDocuments, the
 * best-effort step that pulls account-level report documents (e.g. the annual tax report)
 * into the tax-reports inbox during a TR sync.
 *
 * Uses a real buildApp() (embedded PGlite) for app.db + an in-memory tracking
 * StorageProvider, and a minimal PytrRunner mock (only downloadDocuments is exercised) —
 * mirrors the runnerWith() pattern in pytr-sync.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { portfolios } from "@portfolio/db";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import type { StorageProvider } from "../../src/storage/types.js";
import type { PytrRunner } from "../../src/services/pytr/runner.js";
import { fetchReportDocuments } from "../../src/services/pytr/reports.js";
import { listInboxDocuments } from "../../src/storage/inbox.js";
import type { ReportDocumentRef } from "../../src/services/pytr/mapper.js";

type App = Awaited<ReturnType<typeof buildApp>>;

function runnerWith(downloadImpl: PytrRunner["downloadDocuments"]): PytrRunner {
  return { downloadDocuments: downloadImpl } as unknown as PytrRunner;
}

function makeTrackingStorage(): StorageProvider & { puts: string[]; data: Map<string, Buffer> } {
  const puts: string[] = [];
  const data = new Map<string, Buffer>();
  return {
    puts,
    data,
    put: async (key, body) => {
      puts.push(key);
      data.set(key, body instanceof Buffer ? body : Buffer.from("bytes"));
    },
    getSignedUrl: async (key) => `https://fake.storage/${key}?sig=test`,
    delete: async (key) => {
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

const ISSUER = "https://auth.test/application/o/portfolio/";
const AUDIENCE = "portfolio-tracker";

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

/** Register a user (upserts via /me, satisfying documents.userId's FK) and return their id. */
async function ensureUser(sub: string): Promise<string> {
  const token = await new SignJWT({ email: `${sub}@test.example` })
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
  const res = await app.inject({
    method: "GET",
    url: "/me",
    headers: { authorization: `Bearer ${token}` },
  });
  return (res.json() as { id: string }).id;
}

/** Insert a bare portfolio for a user — portfolioId is required on fetchReportDocuments. */
async function ensurePortfolio(userId: string): Promise<string> {
  const [row] = await app.db
    .insert(portfolios)
    .values({ userId, name: "Test" })
    .returning({ id: portfolios.id });
  return row.id;
}

const session = { phone: "+491234", pin: "1234", sessionData: "jar" };

const REFS: ReportDocumentRef[] = [
  { eventId: "evt-report-1", docId: "doc-1", taxYear: 2025, title: "Jährlicher Steuerreport 2025" },
];

describe("fetchReportDocuments", () => {
  it("returns {} (no-op) when no storage is configured", async () => {
    const userId = await ensureUser("fetch-no-storage");
    const portfolioId = await ensurePortfolio(userId);
    const runner = runnerWith(async () => ({ docs: new Map(), failures: [] }));
    const result = await fetchReportDocuments({
      db: app.db,
      runner,
      storage: undefined,
      connection: { id: "conn-1", userId },
      portfolioId,
      reportRefs: REFS,
      session,
    });
    expect(result).toEqual({});
  });

  it("returns {} (no-op) when there are no report refs", async () => {
    const userId = await ensureUser("fetch-no-refs");
    const portfolioId = await ensurePortfolio(userId);
    const runner = runnerWith(async () => ({ docs: new Map(), failures: [] }));
    const result = await fetchReportDocuments({
      db: app.db,
      runner,
      storage: store,
      connection: { id: "conn-1", userId },
      portfolioId,
      reportRefs: [],
      session,
    });
    expect(result).toEqual({});
  });

  it("downloads and stores a report document, tagging category/taxYear/sourceEventId/portfolioId", async () => {
    const userId = await ensureUser("fetch-1");
    const portfolioId = await ensurePortfolio(userId);
    let calledWith: unknown;
    const runner = runnerWith(async (_session, pairs) => {
      calledWith = pairs;
      return {
        docs: new Map([
          ["doc-1", { buf: Buffer.from("steuerreport bytes"), mimeType: "application/pdf" }],
        ]),
        failures: [],
      };
    });

    const result = await fetchReportDocuments({
      db: app.db,
      runner,
      storage: store,
      connection: { id: "conn-fetch-1", userId },
      portfolioId,
      reportRefs: REFS,
      session,
    });

    expect(result).toEqual({ requested: 1, stored: 1 });
    expect(calledWith).toEqual([{ eventId: "evt-report-1", docId: "doc-1" }]);

    const docs = await listInboxDocuments(app, { userId, category: "tax_report" });
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      category: "tax_report",
      taxYear: 2025,
      source: "pytr",
      portfolioId,
    });
  });

  it("is idempotent: a second fetch with the same sourceEventId stores nothing new", async () => {
    const userId = await ensureUser("fetch-2");
    const portfolioId = await ensurePortfolio(userId);
    const runner = runnerWith(async () => ({
      docs: new Map([["doc-2", { buf: Buffer.from("bytes"), mimeType: "application/pdf" }]]),
      failures: [],
    }));
    const refs: ReportDocumentRef[] = [
      { eventId: "evt-report-2", docId: "doc-2", taxYear: 2024, title: null },
    ];
    const opts = {
      db: app.db,
      runner,
      storage: store,
      connection: { id: "conn-fetch-2", userId },
      portfolioId,
      reportRefs: refs,
      session,
    };

    const first = await fetchReportDocuments(opts);
    const second = await fetchReportDocuments(opts);
    expect(first).toEqual({ requested: 1, stored: 1 });
    expect(second).toEqual({ requested: 1, stored: 1 }); // storeInboxDocument reports the (existing) id as "stored"

    const docs = await listInboxDocuments(app, { userId, category: "tax_report" });
    expect(docs).toHaveLength(1);
  });

  it("counts per-doc download failures without throwing", async () => {
    const userId = await ensureUser("fetch-3");
    const portfolioId = await ensurePortfolio(userId);
    const runner = runnerWith(async () => ({
      docs: new Map(),
      failures: [{ docId: "doc-3", error: "404 from TR" }],
    }));
    const refs: ReportDocumentRef[] = [
      { eventId: "evt-report-3", docId: "doc-3", taxYear: 2025, title: null },
    ];

    const result = await fetchReportDocuments({
      db: app.db,
      runner,
      storage: store,
      connection: { id: "conn-fetch-3", userId },
      portfolioId,
      reportRefs: refs,
      session,
    });
    expect(result).toEqual({ requested: 1, stored: 0 });
    expect(await listInboxDocuments(app, { userId, category: "tax_report" })).toEqual([]);
  });

  it("is best-effort: a process-level downloadDocuments failure never throws, is surfaced in .error", async () => {
    const userId = await ensureUser("fetch-4");
    const portfolioId = await ensurePortfolio(userId);
    const runner = runnerWith(async () => {
      throw new Error("session expired");
    });

    const result = await fetchReportDocuments({
      db: app.db,
      runner,
      storage: store,
      connection: { id: "conn-fetch-4", userId },
      portfolioId,
      reportRefs: REFS,
      session,
    });
    expect(result.requested).toBe(1);
    expect(result.stored).toBe(0);
    expect(result.error).toContain("session expired");
  });
});
