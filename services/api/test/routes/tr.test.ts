import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { generateKeyPair, SignJWT } from "jose";
import {
  documents,
  portfolios,
  screenshotImports,
  transactions,
  trConnections,
  trResolvedEvents,
} from "@portfolio/db";
import { buildApp } from "../../src/app.js";
import { getDb, closeDb } from "../../src/db/client.js";
import {
  PytrApprovalError,
  PytrError,
  PytrUnavailableError,
} from "../../src/services/pytr/runner.js";
import type { PytrRunner } from "../../src/services/pytr/runner.js";

// A fake runner so route tests never spawn Python. The route only uses these four
// methods; behaviour is tweakable per test.
class FakePytr {
  pending = new Set<string>();
  startResult: { processId: string } | Error = { processId: "pid-1" };
  approvalResult: string | Error = "MOZILLA_COOKIE_JAR";
  async startPairing(userId: string) {
    if (this.startResult instanceof Error) throw this.startResult;
    this.pending.add(userId);
    return this.startResult;
  }
  hasPendingPairing(userId: string) {
    return this.pending.has(userId);
  }
  async awaitApproval(userId: string) {
    if (this.approvalResult instanceof Error) throw this.approvalResult;
    this.pending.delete(userId);
    return this.approvalResult;
  }
  cancelPairing(userId: string) {
    this.pending.delete(userId);
  }
  // Document download (diagnose + backfill). Configurable so route tests never spawn
  // Python. Default: one in-memory PDF per requested (eventId, docId) pair.
  downloadResult:
    | {
        docs: Map<string, { buf: Buffer; mimeType: string }>;
        failures: { docId: string | null; error: string }[];
      }
    | Error
    | null = null;
  async downloadDocuments(
    _session: { phone: string; pin: string; sessionData: string },
    pairs: { eventId: string; docId: string }[],
  ) {
    if (this.downloadResult instanceof Error) throw this.downloadResult;
    if (this.downloadResult) return this.downloadResult;
    const docs = new Map<string, { buf: Buffer; mimeType: string }>();
    for (const p of pairs) {
      docs.set(p.docId, { buf: Buffer.from(`pdf-${p.docId}`), mimeType: "application/pdf" });
    }
    return { docs, failures: [] as { docId: string | null; error: string }[] };
  }
}

// Minimal in-memory StorageProvider for the document-retention routes.
function makeMemStorage() {
  const data = new Map<string, Buffer>();
  return {
    data,
    put: async (key: string, body: Buffer) => {
      data.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body));
    },
    get: async (key: string) => data.get(key) ?? null,
    getSignedUrl: async (key: string) => `https://fake/${key}`,
    delete: async (key: string) => {
      data.delete(key);
    },
    exists: async (key: string) => data.has(key),
    move: async (from: string, to: string) => {
      const b = data.get(from);
      if (b) {
        data.set(to, b);
        data.delete(from);
      }
    },
  };
}

const asRunner = (f: FakePytr) => f as unknown as PytrRunner;

const ISSUER = "https://auth.test/o/p/";
const AUDIENCE = "portfolio-tracker";

type App = Awaited<ReturnType<typeof buildApp>>;
let privateKey: CryptoKey;
let publicKey: CryptoKey;

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

async function portfolioFor(app: App, t: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/portfolios",
    headers: auth(t),
    payload: { name: "TR", baseCurrency: "EUR" },
  });
  return res.json().id;
}

describe("Trade Republic connection (encryption enabled)", () => {
  let app: App;
  let fake: FakePytr;

  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    publicKey = kp.publicKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64url");
    fake = new FakePytr();
    app = await buildApp({ authKey: kp.publicKey, pytr: asRunner(fake) });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    delete process.env.DB_ENCRYPTION_KEY;
  });

  it("pairs end to end: connect → awaiting_2fa → approve → connected", async () => {
    const t = await token("tr-user");
    const portfolioId = await portfolioFor(app, t);

    const start = await app.inject({
      method: "POST",
      url: "/tr/connection",
      headers: auth(t),
      payload: { phone: "+4915112345678", pin: "1234", portfolioId },
    });
    expect(start.statusCode).toBe(202);
    expect(start.json()).toEqual({ status: "awaiting_2fa" });

    const pending = await app.inject({
      method: "GET",
      url: "/tr/connection",
      headers: auth(t),
    });
    expect(pending.json()).toMatchObject({ status: "awaiting_2fa", portfolioId });

    // No body — the v2 flow long-polls until the user approves the push in-app.
    const verify = await app.inject({
      method: "POST",
      url: "/tr/connection/verify",
      headers: auth(t),
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toEqual({ status: "connected" });

    const connected = await app.inject({
      method: "GET",
      url: "/tr/connection",
      headers: auth(t),
    });
    expect(connected.json()).toMatchObject({ status: "connected", lastError: null });

    // The session is stored encrypted at rest, never as the raw cookie jar.
    const [row] = await getDb()
      .select()
      .from(trConnections)
      .where(eq(trConnections.status, "connected"));
    expect(row.sessionEnc).toMatch(/^enc:/);
    expect(row.sessionEnc).not.toContain("MOZILLA_COOKIE_JAR");
    expect(row.pinEnc).not.toBe("1234");
  });

  it("404s when pairing into a portfolio the user does not own", async () => {
    const owner = await token("tr-owner");
    const other = await token("tr-intruder");
    const portfolioId = await portfolioFor(app, owner);
    const res = await app.inject({
      method: "POST",
      url: "/tr/connection",
      headers: auth(other),
      payload: { phone: "+49150", pin: "1234", portfolioId },
    });
    expect(res.statusCode).toBe(404);
  });

  it("422s when pairing into a Trade Republic child account (Kinderdepot)", async () => {
    const t = await token("tr-child");
    const holder = await app.inject({
      method: "POST",
      url: "/account-holders",
      headers: auth(t),
      payload: { name: "Kid", type: "child", birthYear: 2020 },
    });
    const created = await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(t),
      payload: { name: "Kid", baseCurrency: "EUR", accountHolderId: holder.json().id },
    });
    const portfolioId = created.json().id;
    const res = await app.inject({
      method: "POST",
      url: "/tr/connection",
      headers: auth(t),
      payload: { phone: "+4915112345678", pin: "1234", portfolioId },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: "tr_child_account_unsupported" });
    // No connection row should have been created.
    const conn = await app.inject({ method: "GET", url: "/tr/connection", headers: auth(t) });
    expect(conn.json()).toMatchObject({ status: "disconnected" });
  });

  it("409s on verify when no pairing is in progress", async () => {
    const t = await token("tr-nopair");
    const res = await app.inject({
      method: "POST",
      url: "/tr/connection/verify",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(409);
  });

  it("400s when the login is not approved and records the error", async () => {
    const t = await token("tr-badcode");
    const portfolioId = await portfolioFor(app, t);
    await app.inject({
      method: "POST",
      url: "/tr/connection",
      headers: auth(t),
      payload: { phone: "+49150", pin: "1234", portfolioId },
    });
    fake.approvalResult = new PytrApprovalError("login expired");

    const res = await app.inject({
      method: "POST",
      url: "/tr/connection/verify",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "not_approved" });

    const state = await app.inject({
      method: "GET",
      url: "/tr/connection",
      headers: auth(t),
    });
    expect(state.json().status).toBe("error");
    fake.approvalResult = "MOZILLA_COOKIE_JAR"; // restore for other tests
  });

  it("502s when pairing fails to start for a non-availability reason", async () => {
    const t = await token("tr-pairfail");
    const portfolioId = await portfolioFor(app, t);
    fake.startResult = new PytrError("websocket closed before init");
    const res = await app.inject({
      method: "POST",
      url: "/tr/connection",
      headers: auth(t),
      payload: { phone: "+49150", pin: "1234", portfolioId },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "tr_pairing_failed" });
    fake.startResult = { processId: "pid-1" };
  });

  it("502s when approval fails for a non-decline reason", async () => {
    const t = await token("tr-approvalfail");
    const portfolioId = await portfolioFor(app, t);
    await app.inject({
      method: "POST",
      url: "/tr/connection",
      headers: auth(t),
      payload: { phone: "+49150", pin: "1234", portfolioId },
    });
    fake.approvalResult = new PytrError("export process crashed");
    const res = await app.inject({
      method: "POST",
      url: "/tr/connection/verify",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "tr_approval_failed" });
    fake.approvalResult = "MOZILLA_COOKIE_JAR";
  });

  it("503s when pytr is unavailable", async () => {
    const t = await token("tr-unavail");
    const portfolioId = await portfolioFor(app, t);
    fake.startResult = new PytrUnavailableError();
    const res = await app.inject({
      method: "POST",
      url: "/tr/connection",
      headers: auth(t),
      payload: { phone: "+49150", pin: "1234", portfolioId },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "pytr_not_available" });
    fake.startResult = { processId: "pid-1" };
  });

  it("re-import wipes pytr transactions, the resolved ledger, and open drafts", async () => {
    const t = await token("tr-reimport");
    const portfolioId = await portfolioFor(app, t);
    await app.inject({
      method: "POST",
      url: "/tr/connection",
      headers: auth(t),
      payload: { phone: "+49150", pin: "1234", portfolioId },
    });
    await app.inject({ method: "POST", url: "/tr/connection/verify", headers: auth(t) });
    const [conn] = await getDb()
      .select()
      .from(trConnections)
      .where(eq(trConnections.portfolioId, portfolioId));

    // Seed a confirmed pytr transaction, a ledger entry, and an open pytr draft.
    await getDb()
      .insert(transactions)
      .values({
        portfolioId,
        type: "deposit",
        price: "100",
        currency: "EUR",
        executedAt: new Date("2026-03-01T10:00:00.000Z"),
        source: "pytr",
        externalId: "ev-1",
      });
    await getDb()
      .insert(trResolvedEvents)
      .values({ portfolioId, eventId: "ev-1", resolution: "confirmed" });
    await getDb()
      .insert(screenshotImports)
      .values({
        userId: conn.userId,
        portfolioId,
        parser: "pytr",
        parsedJson: { drafts: [], errors: [] },
        status: "draft",
      });

    const res = await app.inject({
      method: "POST",
      url: "/tr/connection/reimport",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: 1 });

    expect(
      await getDb()
        .select()
        .from(transactions)
        .where(and(eq(transactions.portfolioId, portfolioId), eq(transactions.source, "pytr"))),
    ).toHaveLength(0);
    expect(
      await getDb()
        .select()
        .from(trResolvedEvents)
        .where(eq(trResolvedEvents.portfolioId, portfolioId)),
    ).toHaveLength(0);
    expect(
      await getDb()
        .select()
        .from(screenshotImports)
        .where(
          and(
            eq(screenshotImports.portfolioId, portfolioId),
            eq(screenshotImports.status, "draft"),
          ),
        ),
    ).toHaveLength(0);
  });

  it("reprocess-documents returns processed count and 409s when not connected", async () => {
    const t = await token("tr-reprocess");
    const portfolioId = await portfolioFor(app, t);

    // 409 before connecting.
    const before = await app.inject({
      method: "POST",
      url: "/tr/connection/reprocess-documents",
      headers: auth(t),
    });
    expect(before.statusCode).toBe(409);
    expect(before.json()).toEqual({ error: "not_connected" });

    // Connect.
    await app.inject({
      method: "POST",
      url: "/tr/connection",
      headers: auth(t),
      payload: { phone: "+49150", pin: "1234", portfolioId },
    });
    await app.inject({ method: "POST", url: "/tr/connection/verify", headers: auth(t) });

    // Seed two pytr transactions (no documentRefs — enrichment no-ops but still counts them).
    await getDb()
      .insert(transactions)
      .values([
        {
          portfolioId,
          type: "deposit",
          price: "100",
          currency: "EUR",
          executedAt: new Date("2026-03-01T10:00:00.000Z"),
          source: "pytr",
          externalId: "rp-ev-1",
        },
        {
          portfolioId,
          type: "buy",
          price: "50",
          currency: "EUR",
          quantity: "2",
          executedAt: new Date("2026-03-02T10:00:00.000Z"),
          source: "pytr",
          externalId: "rp-ev-2",
        },
      ] as const);

    const res = await app.inject({
      method: "POST",
      url: "/tr/connection/reprocess-documents",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ processed: 2 });
  });

  it("GET /tr/connection includes syncing=false in the serialized response", async () => {
    const t = await token("tr-syncing-check");
    await portfolioFor(app, t);
    const res = await app.inject({
      method: "GET",
      url: "/tr/connection",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    // New field is always present; false by default (no active background job).
    expect(res.json()).toMatchObject({ syncing: false });
  });

  it("POST /tr/connection/sync 409s when not connected", async () => {
    const t = await token("tr-sync-not-connected");
    const res = await app.inject({
      method: "POST",
      url: "/tr/connection/sync",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "not_connected" });
  });

  it("POST /tr/connection/sync 409s sync_in_progress when a sync is already running", async () => {
    const t = await token("tr-sync-inflight");
    const portfolioId = await portfolioFor(app, t);
    await app.inject({
      method: "POST",
      url: "/tr/connection",
      headers: auth(t),
      payload: { phone: "+4915199990000", pin: "1234", portfolioId },
    });
    await app.inject({ method: "POST", url: "/tr/connection/verify", headers: auth(t) });

    // Simulate a sync already in flight (the flag the route guards on).
    await getDb()
      .update(trConnections)
      .set({ syncing: true })
      .where(eq(trConnections.portfolioId, portfolioId));

    const res = await app.inject({
      method: "POST",
      url: "/tr/connection/sync",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "sync_in_progress" });
  });

  it("POST /tr/connection/sync re-claims a stale syncing flag past the lease (killed worker)", async () => {
    const t = await token("tr-sync-stale-lease");
    const portfolioId = await portfolioFor(app, t);
    await app.inject({
      method: "POST",
      url: "/tr/connection",
      headers: auth(t),
      payload: { phone: "+4915199990000", pin: "1234", portfolioId },
    });
    await app.inject({ method: "POST", url: "/tr/connection/verify", headers: auth(t) });

    // Simulate a claim left behind by a worker that was killed mid-sync (process
    // restart/crash) — `syncing` never got cleared, and the claim is old enough to
    // be past SYNC_CLAIM_LEASE_MS.
    await getDb()
      .update(trConnections)
      .set({ syncing: true, updatedAt: new Date(Date.now() - 3 * 60 * 60_000) })
      .where(eq(trConnections.portfolioId, portfolioId));

    const res = await app.inject({
      method: "POST",
      url: "/tr/connection/sync",
      headers: auth(t),
    });
    // Not blocked by the stale claim (would be 409 if the lease weren't honored). pg-boss is
    // unavailable in tests, so this falls through to the inline sync path; FakePytr has no
    // `export`, so the sync itself fails gracefully (syncTrConnection catches it) — the point
    // here is only that the claim succeeded rather than 409ing.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "error" });
  });

  it("disconnects: DELETE wipes the connection", async () => {
    const t = await token("tr-disc");
    const portfolioId = await portfolioFor(app, t);
    await app.inject({
      method: "POST",
      url: "/tr/connection",
      headers: auth(t),
      payload: { phone: "+49150", pin: "1234", portfolioId },
    });
    const del = await app.inject({
      method: "DELETE",
      url: "/tr/connection",
      headers: auth(t),
    });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({
      method: "GET",
      url: "/tr/connection",
      headers: auth(t),
    });
    expect(after.json().status).toBe("disconnected");
  });
});

describe("Trade Republic connection (encryption disabled)", () => {
  it("503s when DB_ENCRYPTION_KEY is unset — refuses to store plaintext secrets", async () => {
    delete process.env.DB_ENCRYPTION_KEY;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    const app = await buildApp({ authKey: publicKey, pytr: asRunner(new FakePytr()) });
    const t = await token("tr-noenc");
    const portfolioId = await portfolioFor(app, t);
    const res = await app.inject({
      method: "POST",
      url: "/tr/connection",
      headers: auth(t),
      payload: { phone: "+49150", pin: "1234", portfolioId },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "encryption_required" });
    await app.close();
    await closeDb();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
  });
});

describe("TR document diagnose + backfill", () => {
  let app: App;
  let fake: FakePytr;
  let storage: ReturnType<typeof makeMemStorage>;

  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    publicKey = kp.publicKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64url");
    fake = new FakePytr();
    storage = makeMemStorage();
    app = await buildApp({ authKey: kp.publicKey, pytr: asRunner(fake), storage });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    delete process.env.DB_ENCRYPTION_KEY;
  });

  // Connect a user (pair → verify) and return their token + portfolioId.
  async function connect(
    sub: string,
    retention = true,
  ): Promise<{ t: string; portfolioId: string }> {
    const t = await token(sub);
    const portfolioId = await portfolioFor(app, t);
    await app.inject({
      method: "POST",
      url: "/tr/connection",
      headers: auth(t),
      payload: { phone: "+4915112345678", pin: "1234", portfolioId },
    });
    await app.inject({ method: "POST", url: "/tr/connection/verify", headers: auth(t) });
    if (retention) {
      await getDb()
        .update(portfolios)
        .set({ documentRetention: true })
        .where(eq(portfolios.id, portfolioId));
    }
    return { t, portfolioId };
  }

  async function seedPytrTx(portfolioId: string, eventId: string, docId: string): Promise<string> {
    const [tx] = await getDb()
      .insert(transactions)
      .values({
        portfolioId,
        type: "buy",
        source: "pytr",
        externalId: eventId,
        documentRefs: [{ id: docId, type: "SECURITIES_SETTLEMENT", date: "2024-05-30" }],
        quantity: "1",
        price: "100.00",
        currency: "EUR",
        executedAt: new Date("2024-05-30"),
      })
      .returning();
    return tx.id;
  }

  it("409s diagnose when the user has no connection", async () => {
    const t = await token("doc-noconn");
    await portfolioFor(app, t);
    const res = await app.inject({
      method: "POST",
      url: "/tr/connection/diagnose-documents",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "not_connected" });
  });

  it("diagnoses a healthy path: storage round-trip + python download both OK", async () => {
    const { t, portfolioId } = await connect("doc-diag");
    await seedPytrTx(portfolioId, "evt-1", "doc-1");

    const res = await app.inject({
      method: "POST",
      url: "/tr/connection/diagnose-documents",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.storage).toMatchObject({ ok: true, signedUrlOk: true, roundTripOk: true });
    expect(body.python.status).toBe("ok");
    expect(body.python.downloaded).toBe(1);
    expect(body.counts.withDocumentRefs).toBeGreaterThanOrEqual(1);
    // The healthcheck object is cleaned up after the probe.
    expect([...storage.data.keys()].some((k) => k.startsWith("__healthcheck/"))).toBe(false);
  });

  it("reports python.status=no_candidate when no tx has a documentRef", async () => {
    const { t } = await connect("doc-nocand");
    const res = await app.inject({
      method: "POST",
      url: "/tr/connection/diagnose-documents",
      headers: auth(t),
    });
    expect(res.json().python.status).toBe("no_candidate");
  });

  it("surfaces a python process failure in the diagnose report", async () => {
    const { t, portfolioId } = await connect("doc-pyfail");
    await seedPytrTx(portfolioId, "evt-x", "doc-x");
    fake.downloadResult = new PytrError("boom");
    const res = await app.inject({
      method: "POST",
      url: "/tr/connection/diagnose-documents",
      headers: auth(t),
    });
    expect(res.json().python.status).toBe("process_failed");
    fake.downloadResult = null;
  });

  it("backfills documents: downloads, stores, links, and is idempotent", async () => {
    const { t, portfolioId } = await connect("doc-backfill");
    const txId = await seedPytrTx(portfolioId, "evt-b", "doc-b");

    const res = await app.inject({
      method: "POST",
      url: "/tr/connection/backfill-documents",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.eligible).toBe(1);
    expect(body.downloaded).toBe(1);
    expect(body.stored).toBe(1);
    expect(body.linked).toBe(1);

    // A retained document now exists, linked to the transaction.
    const docRows = await getDb().select().from(documents).where(eq(documents.transactionId, txId));
    expect(docRows).toHaveLength(1);
    expect(docRows[0].status).toBe("retained");

    // Re-running is a no-op (the tx is already covered).
    const again = await app.inject({
      method: "POST",
      url: "/tr/connection/backfill-documents",
      headers: auth(t),
    });
    expect(again.json()).toMatchObject({ downloaded: 0, stored: 0, linked: 0 });
  });

  it("409s backfill when documentRetention is disabled", async () => {
    const { t, portfolioId } = await connect("doc-noretain", false);
    await seedPytrTx(portfolioId, "evt-r", "doc-r");
    const res = await app.inject({
      method: "POST",
      url: "/tr/connection/backfill-documents",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "document_retention_disabled" });
  });

  it("reimport deletes the storage object for a retained, transaction-scoped document (not just the DB row)", async () => {
    // Reproduces the orphaned-S3-object bug: documents.transactionId cascades on delete, so
    // the DB row disappears silently the moment reimport wipes the transaction — without an
    // explicit storage.delete, the underlying PDF is never removed and leaks in S3 forever.
    const { t, portfolioId } = await connect("doc-reimport-cleanup");
    const txId = await seedPytrTx(portfolioId, "evt-cleanup", "doc-cleanup");

    const backfill = await app.inject({
      method: "POST",
      url: "/tr/connection/backfill-documents",
      headers: auth(t),
    });
    expect(backfill.json()).toMatchObject({ downloaded: 1, stored: 1, linked: 1 });

    const [docRow] = await getDb()
      .select()
      .from(documents)
      .where(eq(documents.transactionId, txId));
    expect(docRow.status).toBe("retained");
    expect(storage.data.has(docRow.storageKey)).toBe(true);

    const res = await app.inject({
      method: "POST",
      url: "/tr/connection/reimport",
      headers: auth(t),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: 1 });

    // The DB row is gone (FK cascade) — and so is the storage object (explicit cleanup).
    expect(await getDb().select().from(documents).where(eq(documents.id, docRow.id))).toHaveLength(
      0,
    );
    expect(storage.data.has(docRow.storageKey)).toBe(false);
  });
});
