import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Decimal } from "decimal.js";
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  users,
  portfolios,
  trConnections,
  screenshotImports,
  transactions,
  trResolvedEvents,
  documents,
} from "@portfolio/db";
import { ensureDb, getDb, closeDb } from "../../src/db/client.js";
import { EncryptionService } from "../../src/services/encryption.js";
import { syncTrConnection } from "../../src/services/pytr/sync.js";
import { PytrAuthError, type PytrRunner, type DocDownloadResult, type DownloadDocumentsResult } from "../../src/services/pytr/runner.js";
import type { StorageProvider } from "../../src/storage/types.js";

const enc = new EncryptionService({ key: crypto.randomBytes(32).toString("base64url") });

// A mock runner whose export() is set per test — no Python, no network.
function runnerWith(
  exportImpl: PytrRunner["export"],
  downloadImpl?: PytrRunner["downloadDocuments"],
): PytrRunner {
  return {
    export: exportImpl,
    downloadDocuments: downloadImpl ?? (async () => ({ docs: new Map(), failures: [] })),
  } as unknown as PytrRunner;
}

/** In-memory storage tracking put/delete calls. */
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
    move: async (src: string, dest: string) => {
      const buf = data.get(src);
      if (buf) { data.set(dest, buf); data.delete(src); }
    },
  };
}

const EVENTS = [
  { id: "tr-1", timestamp: "2026-03-01T10:00:00.000Z", eventType: "ORDER_EXECUTED", amount: -1000, shares: 10, isin: "DE0007236101", currency: "EUR" },
  { id: "tr-2", timestamp: "2026-03-02T10:00:00.000Z", eventType: "PAYMENT_INBOUND", amount: 500, currency: "EUR" },
  { id: "tr-3", timestamp: "2026-03-03T10:00:00.000Z", eventType: "MYSTERY", amount: 1, currency: "EUR" },
];

async function makeConnection(suffix: string, cashCounted = true) {
  const db = getDb();
  const [user] = await db
    .insert(users)
    .values({ authSub: `tr-sync|${suffix}`, email: `${suffix}@example.com` })
    .returning();
  // Default to a cash-INSIDE (savings) portfolio so the generic plumbing tests import every
  // cash movement (deposits/withdrawals) as before issue #326. Boundary-specific behavior is
  // exercised by the dedicated cash-inside/cash-outside tests, which pass cashCounted=false.
  const [pf] = await db
    .insert(portfolios)
    .values({ userId: user.id, name: "TR", baseCurrency: "EUR", cashCounted })
    .returning();
  const [conn] = await db
    .insert(trConnections)
    .values({
      userId: user.id,
      portfolioId: pf.id,
      phoneEnc: enc.encryptString("+4915112345678"),
      pinEnc: enc.encryptString("1234"),
      sessionEnc: enc.encryptString("OLD_JAR"),
      status: "connected",
    })
    .returning();
  return conn;
}

describe("syncTrConnection", () => {
  beforeAll(async () => {
    await ensureDb();
  });
  afterAll(async () => {
    await closeDb();
  });

  it("stages a pytr draft import and rolls the session forward", async () => {
    const conn = await makeConnection("ok");
    let exportInput: unknown;
    const runner = runnerWith(async (input) => {
      exportInput = input;
      return { events: EVENTS, sessionData: "NEW_JAR" };
    });

    const result = await syncTrConnection(getDb(), enc, runner, conn);

    // The runner is handed decrypted creds + the prior session.
    expect(exportInput).toEqual({
      phone: "+4915112345678",
      pin: "1234",
      sessionData: "OLD_JAR",
    });

    expect(result.status).toBe("connected");
    expect(result.drafts).toBe(2); // two mapped, the MYSTERY event is an error
    expect(result.errors).toBe(1);

    // A draft import was staged (parser='pytr'), NOT auto-committed to transactions.
    const [imp] = await getDb()
      .select()
      .from(screenshotImports)
      .where(eq(screenshotImports.id, result.importId!));
    expect(imp.parser).toBe("pytr");
    expect(imp.status).toBe("draft");
    const parsed = imp.parsedJson as { drafts: { externalId: string }[] };
    expect(parsed.drafts.map((d) => d.externalId)).toEqual(["tr-1", "tr-2"]);

    // The rolling cookie jar is re-encrypted (extends session life) and timestamped.
    const [updated] = await getDb()
      .select()
      .from(trConnections)
      .where(eq(trConnections.id, conn.id));
    expect(updated.status).toBe("connected");
    expect(updated.lastSyncAt).not.toBeNull();
    expect(enc.decryptString(updated.sessionEnc!)).toBe("NEW_JAR");
  });

  it("accumulates only new events across syncs (one collector draft)", async () => {
    const conn = await makeConnection("collector");
    const db = getDb();

    // First sync stages the two mappable events.
    const first = await syncTrConnection(db, enc, runnerWith(async () => ({ events: EVENTS, sessionData: "J1" })), conn);
    expect(first.drafts).toBe(2);

    // Re-sync with the identical timeline → nothing new, the same single draft persists.
    const again = await syncTrConnection(db, enc, runnerWith(async () => ({ events: EVENTS, sessionData: "J2" })), conn);
    expect(again.drafts).toBe(0);
    expect(again.importId).toBe(first.importId);

    // A genuinely new event is appended to the existing collector.
    const withNew = [
      ...EVENTS,
      { id: "tr-4", timestamp: "2026-03-04T10:00:00.000Z", eventType: "PAYMENT_INBOUND", amount: 250, currency: "EUR" },
    ];
    const third = await syncTrConnection(db, enc, runnerWith(async () => ({ events: withNew, sessionData: "J3" })), conn);
    expect(third.drafts).toBe(1);
    expect(third.importId).toBe(first.importId);

    // Exactly one open pytr draft for the portfolio, holding the accumulated set.
    const drafts = await db
      .select()
      .from(screenshotImports)
      .where(and(eq(screenshotImports.portfolioId, conn.portfolioId!), eq(screenshotImports.status, "draft")));
    expect(drafts).toHaveLength(1);
    const parsed = drafts[0].parsedJson as { drafts: { externalId: string }[] };
    expect(parsed.drafts.map((d) => d.externalId).sort()).toEqual(["tr-1", "tr-2", "tr-4"]);
  });

  it("self-heals a staged error once a transiently-failed detail recovers", async () => {
    const conn = await makeConnection("self-heal");
    const db = getDb();

    // Sync 1: a trade whose detail fetch failed → no share count → an attention error.
    const thin = [
      { id: "heal-1", timestamp: "2026-03-01T10:00:00.000Z", eventType: "ORDER_EXECUTED", amount: -1000, isin: "DE0007236101", currency: "EUR" },
    ];
    const first = await syncTrConnection(db, enc, runnerWith(async () => ({ events: thin, sessionData: "J1" })), conn);
    expect(first.drafts).toBe(0);
    expect(first.errors).toBe(1);

    // Sync 2: TR's detail now resolves, so the same event arrives with its share count.
    const full = [{ ...thin[0], shares: 10 }];
    const second = await syncTrConnection(db, enc, runnerWith(async () => ({ events: full, sessionData: "J2" })), conn);

    // The staged error was re-derived into a proper draft — not kept as a stale error.
    expect(second.drafts).toBe(1);
    const [imp] = await db
      .select()
      .from(screenshotImports)
      .where(and(eq(screenshotImports.portfolioId, conn.portfolioId!), eq(screenshotImports.status, "draft")));
    const parsed = imp.parsedJson as { drafts: { externalId: string }[]; errors: { eventId?: string }[] };
    expect(parsed.drafts.map((d) => d.externalId)).toEqual(["heal-1"]);
    expect(parsed.errors.some((e) => e.eventId === "heal-1")).toBe(false);
  });

  it("un-imports a confirmed transaction whose source event was cancelled", async () => {
    const conn = await makeConnection("cancel");
    const db = getDb();

    // Simulate a prior confirm: tr-1 already written as a transaction.
    await db.insert(transactions).values({
      portfolioId: conn.portfolioId!,
      type: "deposit",
      currency: "EUR",
      executedAt: new Date("2026-03-01T10:00:00.000Z"),
      source: "pytr",
      externalId: "tr-1",
    });

    // Next sync sees tr-1 flipped to CANCELED.
    const cancelledEvents = EVENTS.map((e) => (e.id === "tr-1" ? { ...e, status: "CANCELED" } : e));
    const result = await syncTrConnection(db, enc, runnerWith(async () => ({ events: cancelledEvents, sessionData: "JX" })), conn);

    expect(result.cancelled).toBe(1);
    const rows = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.portfolioId, conn.portfolioId!), eq(transactions.externalId, "tr-1")));
    expect(rows).toHaveLength(0);
  });

  it("cancellation completes even when linked-document cleanup throws (best-effort)", async () => {
    const conn = await makeConnection("cancel-cleanup-throws");
    const db = getDb();

    // Prior confirm: tr-1 written, with a postbox PDF linked to the transaction.
    const [tx] = await db
      .insert(transactions)
      .values({
        portfolioId: conn.portfolioId!,
        type: "deposit",
        currency: "EUR",
        executedAt: new Date("2026-03-01T10:00:00.000Z"),
        source: "pytr",
        externalId: "tr-1",
      })
      .returning({ id: transactions.id });
    await db.insert(documents).values({
      userId: conn.userId,
      transactionId: tx.id,
      storageKey: "receipts/cancel-cleanup-throws.pdf",
      mimeType: "application/pdf",
      source: "pytr",
    });

    // Storage whose delete always throws — cleanup must be isolated so the sync still finishes.
    const storage = makeTrackingStorage();
    (storage as unknown as { delete: unknown }).delete = async () => {
      throw new Error("storage delete failed");
    };

    const cancelledEvents = EVENTS.map((e) => (e.id === "tr-1" ? { ...e, status: "CANCELED" } : e));
    const result = await syncTrConnection(
      db,
      enc,
      runnerWith(async () => ({ events: cancelledEvents, sessionData: "JX" })),
      conn,
      undefined,
      storage,
    );

    // The cancelled transaction is still removed and the sync reaches a terminal state.
    expect(result.status).toBe("connected");
    expect(result.cancelled).toBe(1);
    const rows = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.portfolioId, conn.portfolioId!), eq(transactions.externalId, "tr-1")));
    expect(rows).toHaveLength(0);
  });

  // Boundary events shared by the two cash-boundary tests (#326): a trade, a deposit, card
  // spending, and an unknown event type.
  const BOUNDARY_EVENTS = [
    { id: "b-trade", timestamp: "2026-03-01T10:00:00.000Z", eventType: "ORDER_EXECUTED", amount: -1000, shares: 10, isin: "DE0007236101", currency: "EUR" },
    { id: "b-dep", timestamp: "2026-03-02T10:00:00.000Z", eventType: "PAYMENT_INBOUND", amount: 100, currency: "EUR" },
    { id: "b-card", timestamp: "2026-03-03T10:00:00.000Z", eventType: "CARD_TRANSACTION", amount: -12.5, currency: "EUR" },
    { id: "b-unknown", timestamp: "2026-03-04T10:00:00.000Z", eventType: "MYSTERY", amount: 1, currency: "EUR" },
  ];

  it("cash-inside portfolio imports everything incl. deposits and card spending (#326)", async () => {
    const conn = await makeConnection("cash-inside", true);
    const db = getDb();
    const runner = runnerWith(async () => ({ events: BOUNDARY_EVENTS, sessionData: "J" }));

    const r = await syncTrConnection(db, enc, runner, conn);
    // trade + deposit + card all staged; the unknown MYSTERY surfaces as an error.
    expect(r.drafts).toBe(3);
    expect(r.errors).toBe(1);

    const [draft] = await db
      .select()
      .from(screenshotImports)
      .where(and(eq(screenshotImports.portfolioId, conn.portfolioId!), eq(screenshotImports.status, "draft")));
    const parsed = draft.parsedJson as { drafts: { externalId: string }[] };
    expect(parsed.drafts.map((d) => d.externalId).sort()).toEqual(["b-card", "b-dep", "b-trade"]);
  });

  it("cash-outside portfolio excludes deposits & card, keeps trades, surfaces unknowns (#326)", async () => {
    const conn = await makeConnection("cash-outside", false);
    const db = getDb();
    const runner = runnerWith(async () => ({ events: BOUNDARY_EVENTS, sessionData: "J" }));

    const r = await syncTrConnection(db, enc, runner, conn);
    // Only the trade is staged; deposit + card are excluded (not even errors). The unknown
    // MYSTERY event is NOT a known cash movement, so it still flows through and surfaces.
    expect(r.drafts).toBe(1);
    expect(r.errors).toBe(1);

    const [draft] = await db
      .select()
      .from(screenshotImports)
      .where(and(eq(screenshotImports.portfolioId, conn.portfolioId!), eq(screenshotImports.status, "draft")));
    const parsed = draft.parsedJson as {
      drafts: { externalId: string }[];
      errors: { eventId?: string }[];
    };
    expect(parsed.drafts.map((d) => d.externalId)).toEqual(["b-trade"]);
    // The unknown event surfaced as an error; the cash movements did not (silently excluded
    // from staging, but never surfaced as gaps either).
    expect(parsed.errors.some((e) => e.eventId === "b-unknown")).toBe(true);
    expect(parsed.errors.some((e) => e.eventId === "b-dep" || e.eventId === "b-card")).toBe(false);
  });

  it("re-stages excluded cash movements after the portfolio flips to cash-inside (#326)", async () => {
    const conn = await makeConnection("cash-flip", false);
    const db = getDb();
    const runner = runnerWith(async () => ({ events: BOUNDARY_EVENTS, sessionData: "J" }));

    // Cash-outside: deposit + card excluded and NOT marked seen.
    const r1 = await syncTrConnection(db, enc, runner, conn);
    expect(r1.drafts).toBe(1);

    // Flip the boundary to cash-inside; the previously-excluded movements now stage.
    await db.update(portfolios).set({ cashCounted: true }).where(eq(portfolios.id, conn.portfolioId!));
    const r2 = await syncTrConnection(db, enc, runner, conn);
    expect(r2.drafts).toBe(2); // the deposit + card; the trade was already staged

    const [draft] = await db
      .select()
      .from(screenshotImports)
      .where(and(eq(screenshotImports.portfolioId, conn.portfolioId!), eq(screenshotImports.status, "draft")));
    const parsed = draft.parsedJson as { drafts: { externalId: string }[] };
    expect(parsed.drafts.map((d) => d.externalId).sort()).toEqual(["b-card", "b-dep", "b-trade"]);
  });

  it("heals a previously-discarded event when the mapper now maps it to a draft", async () => {
    const conn = await makeConnection("heal-discarded");
    const db = getDb();

    // Simulate the state after a mapper bug was fixed: an event was written to the resolved
    // ledger as "discarded" (e.g. a PAYMENT_INBOUND that was somehow skipped), but with the
    // current mapper it would produce a valid draft.
    const eventId = "heal-disc-1";
    await db.insert(trResolvedEvents).values({
      portfolioId: conn.portfolioId!,
      source: "pytr",
      eventId,
      resolution: "discarded",
    });

    const evs = [
      { id: eventId, timestamp: "2026-03-01T10:00:00.000Z", eventType: "PAYMENT_INBOUND", amount: 100, currency: "EUR" },
    ];
    const runner = runnerWith(async () => ({ events: evs, sessionData: "J" }));
    const result = await syncTrConnection(db, enc, runner, conn);

    // The discarded entry is evicted and the event is re-staged as a deposit draft.
    expect(result.drafts).toBe(1);
    const ledger = await db
      .select()
      .from(trResolvedEvents)
      .where(and(eq(trResolvedEvents.portfolioId, conn.portfolioId!), eq(trResolvedEvents.eventId, eventId)));
    expect(ledger).toHaveLength(0); // removed from ledger
  });

  it("does not heal a discarded event that the mapper still skips", async () => {
    const conn = await makeConnection("no-heal-skip");
    const db = getDb();

    // CARD_VERIFICATION is always a skip (info) — should stay discarded.
    const eventId = "card-ver-1";
    await db.insert(trResolvedEvents).values({
      portfolioId: conn.portfolioId!,
      source: "pytr",
      eventId,
      resolution: "discarded",
    });

    const evs = [
      { id: eventId, timestamp: "2026-03-01T10:00:00.000Z", eventType: "CARD_VERIFICATION", amount: 0, currency: "EUR" },
    ];
    const result = await syncTrConnection(db, enc, runnerWith(async () => ({ events: evs, sessionData: "J" })), conn);

    // Not healed — still skipped, still discarded.
    expect(result.drafts).toBe(0);
    const ledger = await db
      .select()
      .from(trResolvedEvents)
      .where(and(eq(trResolvedEvents.portfolioId, conn.portfolioId!), eq(trResolvedEvents.eventId, eventId)));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].resolution).toBe("discarded");
  });

  it("reconciles derived cash against TR's reported balance using the full event timeline", async () => {
    const conn = await makeConnection("reconcile");
    const db = getDb();
    // A €500 deposit; derived cash from mapping = 500. TR reports 480 → diff -20.
    // Crucially: nothing is pre-confirmed in transactions — reconciliation no longer reads
    // from the DB, so even a brand-new import (zero confirmed rows) gives a correct diff.
    const evs = [{ id: "d-1", timestamp: "2026-03-02T10:00:00.000Z", eventType: "PAYMENT_INBOUND", amount: 500, currency: "EUR" }];
    const runner = runnerWith(async () => ({
      events: evs,
      sessionData: "J",
      summary: { cash: [{ currency: "EUR", amount: 480 }] },
    }));

    const result = await syncTrConnection(db, enc, runner, conn);
    expect(result.reconciliation?.cash).toEqual([
      { currency: "EUR", reported: "480", derived: "500", diff: "-20.00" },
    ]);

    const [updated] = await db.select().from(trConnections).where(eq(trConnections.id, conn.id));
    expect((updated.lastReconciliation as { cash: unknown[] }).cash).toHaveLength(1);
    // First sync has no prior baseline, so no incremental drift is reported yet.
    expect(result.reconciliation?.cash[0]).not.toHaveProperty("driftSincePrev");
  });

  it("reconciliation is boundary-agnostic: cash-outside still derives from the full timeline (#326)", async () => {
    // A cash-outside portfolio does NOT stage the deposit or card spend — but reconciliation
    // must still count them, or TR's reported balance would diverge from ours. The deposit
    // (+500) minus card spend (-12.5) = 487.5 derived, regardless of the staging filter.
    const conn = await makeConnection("reconcile-cash-outside", false);
    const db = getDb();
    const evs = [
      { id: "ro-dep", timestamp: "2026-03-01T10:00:00.000Z", eventType: "PAYMENT_INBOUND", amount: 500, currency: "EUR" },
      { id: "ro-card", timestamp: "2026-03-02T10:00:00.000Z", eventType: "CARD_TRANSACTION", amount: -12.5, currency: "EUR" },
    ];
    const runner = runnerWith(async () => ({
      events: evs,
      sessionData: "J",
      summary: { cash: [{ currency: "EUR", amount: 487.5 }] },
    }));

    const result = await syncTrConnection(db, enc, runner, conn);
    // Neither cash movement was staged (cash-outside)...
    expect(result.drafts).toBe(0);
    // ...yet reconciliation derived the full balance and matches TR exactly (zero drift).
    expect(result.reconciliation?.cash).toEqual([
      { currency: "EUR", reported: "487.5", derived: "487.5", diff: "0.00" },
    ]);
  });

  it("reports incremental drift vs the previous sync's reconciliation", async () => {
    const conn = await makeConnection("reconcile-drift");
    const db = getDb();
    const evs = [{ id: "d-1", timestamp: "2026-03-02T10:00:00.000Z", eventType: "PAYMENT_INBOUND", amount: 500, currency: "EUR" }];

    // Sync 1: TR reports 480 → diff -20.00 (no baseline yet → no drift).
    const r1 = await syncTrConnection(
      db, enc,
      runnerWith(async () => ({ events: evs, sessionData: "J", summary: { cash: [{ currency: "EUR", amount: 480 }] } })),
      conn,
    );
    expect(r1.reconciliation?.cash[0]).toMatchObject({ diff: "-20.00" });

    // Reload the connection so it carries the stored lastReconciliation, then sync again with
    // a slightly different reported balance (478 → diff -22.00). The diff moved by -2.00.
    const [reloaded] = await db.select().from(trConnections).where(eq(trConnections.id, conn.id));
    const r2 = await syncTrConnection(
      db, enc,
      runnerWith(async () => ({ events: evs, sessionData: "J", summary: { cash: [{ currency: "EUR", amount: 478 }] } })),
      reloaded,
    );
    expect(r2.reconciliation?.cash[0]).toMatchObject({
      reported: "478",
      derived: "500",
      diff: "-22.00",
      driftSincePrev: "-2.00",
    });
  });

  it("reconciles positions against TR's compactPortfolio snapshot", async () => {
    const conn = await makeConnection("reconcile-positions");
    const db = getDb();
    // One buy of 10 shares of DE0007236101. TR reports 12 → diff = 2.
    const evs = [
      { id: "pos-1", timestamp: "2026-03-01T10:00:00.000Z", eventType: "ORDER_EXECUTED", amount: -1000, shares: 10, isin: "DE0007236101", currency: "EUR" },
    ];
    const runner = runnerWith(async () => ({
      events: evs,
      sessionData: "J",
      summary: {
        cash: [{ currency: "EUR", amount: 0 }],
        positions: [{ isin: "DE0007236101", qty: "12.000000" }],
      },
    }));

    const result = await syncTrConnection(db, enc, runner, conn);
    expect(result.reconciliation?.positions).toBeDefined();
    const pos = result.reconciliation!.positions!;
    const siemens = pos.find((p) => p.isin === "DE0007236101");
    expect(siemens).toBeDefined();
    // Derived = 10 (from the buy event), reported = 12, diff = 2
    expect(new Decimal(siemens!.reported).toFixed(0)).toBe("12");
    expect(new Decimal(siemens!.derived).toFixed(0)).toBe("10");
    expect(new Decimal(siemens!.diff).toFixed(0)).toBe("2");

    const [updated] = await db.select().from(trConnections).where(eq(trConnections.id, conn.id));
    const rec = updated.lastReconciliation as { positions?: unknown[] };
    expect(Array.isArray(rec.positions)).toBe(true);
    expect((rec.positions as unknown[]).length).toBeGreaterThan(0);
  });

  it("stores no positions field when summary has no positions", async () => {
    const conn = await makeConnection("reconcile-no-positions");
    const db = getDb();
    const evs = [{ id: "d-1", timestamp: "2026-03-01T10:00:00.000Z", eventType: "PAYMENT_INBOUND", amount: 100, currency: "EUR" }];
    const runner = runnerWith(async () => ({
      events: evs,
      sessionData: "J",
      summary: { cash: [{ currency: "EUR", amount: 100 }] },
      // No positions field in summary → reconcilePositions returns undefined
    }));

    const result = await syncTrConnection(db, enc, runner, conn);
    expect(result.reconciliation?.positions).toBeUndefined();
  });

  it("reconciles correctly even before any events are confirmed (fresh full import)", async () => {
    const conn = await makeConnection("reconcile-fresh");
    const db = getDb();
    // Full import: all events are staged drafts, none confirmed. Derived cash must still
    // be non-zero (was always 0 before the fix because it read from transactions table).
    const evs = [
      { id: "e-1", timestamp: "2026-01-01T10:00:00.000Z", eventType: "PAYMENT_INBOUND", amount: 1000, currency: "EUR" },
      { id: "e-2", timestamp: "2026-01-02T10:00:00.000Z", eventType: "CARD_TRANSACTION", amount: -50, currency: "EUR" },
    ];
    const runner = runnerWith(async () => ({
      events: evs,
      sessionData: "J",
      summary: { cash: [{ currency: "EUR", amount: 950 }] },
    }));

    // Nothing pre-confirmed (simulates a brand-new full import with 0 rows in transactions).
    const result = await syncTrConnection(db, enc, runner, conn);
    expect(result.reconciliation?.cash).toEqual([
      // deposit 1000 - card withdrawal 50 = 950; TR reports 950 → diff 0.
      { currency: "EUR", reported: "950", derived: "950", diff: "0.00" },
    ]);
  });

  it("reconcile cash correctly subtracts sell tax (regression: omitted tax overstated derived)", async () => {
    const conn = await makeConnection("reconcile-sell-tax");
    const db = getDb();
    // A sell of 5 shares at 100 gross each = 500 notional; 1 fee; 2 tax withheld.
    // Net cash TR reports: 500 − 1 − 2 = 497 EUR.
    // Before the fix, `tax` was not passed to CoreTransaction → cashFlow() treated it as 0
    // → derived was 499 (wrong, over by 2).  After the fix derived must be 497 (= 500 − 1 − 2).
    const evs = [
      {
        id: "sell-1",
        timestamp: "2026-04-01T10:00:00.000Z",
        eventType: "ORDER_EXECUTED",
        amount: 497,   // net cash (sign: positive = cash in)
        shares: -5,    // pytr: negative shares for a sell
        fees: -1,      // pytr: negative for costs
        tax: -2,       // pytr: negative for costs
        isin: "DE0007236101",
        currency: "EUR",
      },
    ];
    const runner = runnerWith(async () => ({
      events: evs,
      sessionData: "J",
      // TR reports the actual net cash received after fees and tax.
      summary: { cash: [{ currency: "EUR", amount: 497 }] },
    }));

    const result = await syncTrConnection(db, enc, runner, conn);
    // Derived must match TR's reported 497 → diff 0.00 (not +2 from a missing tax subtraction).
    expect(result.reconciliation?.cash).toEqual([
      { currency: "EUR", reported: "497", derived: "497", diff: "0.00" },
    ]);
  });

  it("a purposely-deleted confirmed transaction stays gone (durable ledger)", async () => {
    const conn = await makeConnection("durable");
    const db = getDb();
    const evs = [
      { id: "tr-1", timestamp: "2026-03-01T10:00:00.000Z", eventType: "PAYMENT_INBOUND", amount: 500, currency: "EUR" },
      { id: "tr-2", timestamp: "2026-03-02T10:00:00.000Z", eventType: "PAYMENT_INBOUND", amount: 100, currency: "EUR" },
    ];
    const runner = runnerWith(async () => ({ events: evs, sessionData: "J" }));

    // tr-1 was already confirmed in a past life.
    await db.insert(transactions).values({
      portfolioId: conn.portfolioId!,
      type: "deposit",
      price: "500",
      currency: "EUR",
      executedAt: new Date("2026-03-01T10:00:00.000Z"),
      source: "pytr",
      externalId: "tr-1",
    });

    // First sync: seeds tr-1 into the ledger, stages only tr-2.
    const r1 = await syncTrConnection(db, enc, runner, conn);
    expect(r1.drafts).toBe(1);
    const ledger = await db
      .select()
      .from(trResolvedEvents)
      .where(eq(trResolvedEvents.portfolioId, conn.portfolioId!));
    expect(ledger.map((l) => l.eventId)).toContain("tr-1");

    // User deletes the tr-1 transaction on purpose.
    await db.delete(transactions).where(eq(transactions.externalId, "tr-1"));

    // Re-sync: tr-1 must NOT reappear (the ledger remembers it); tr-2 already staged.
    const r2 = await syncTrConnection(db, enc, runner, conn);
    expect(r2.drafts).toBe(0);
    const [draft] = await db
      .select()
      .from(screenshotImports)
      .where(and(eq(screenshotImports.portfolioId, conn.portfolioId!), eq(screenshotImports.status, "draft")));
    const ids = (draft.parsedJson as { drafts: { externalId: string }[] }).drafts.map((d) => d.externalId);
    expect(ids).toContain("tr-2");
    expect(ids).not.toContain("tr-1");
  });

  it("marks the connection expired when the session can't be resumed", async () => {
    const conn = await makeConnection("expired");
    const runner = runnerWith(async () => {
      throw new PytrAuthError();
    });

    const result = await syncTrConnection(getDb(), enc, runner, conn);
    expect(result.status).toBe("expired");

    const [updated] = await getDb()
      .select()
      .from(trConnections)
      .where(eq(trConnections.id, conn.id));
    expect(updated.status).toBe("expired");
    expect(updated.lastError).toBeTruthy();
  });

  // --- document download tests (#243) ---------------------------------------

  it("stages postbox documents for new drafts when documentRetention=true", async () => {
    const conn = await makeConnection("docs-retention");
    const db = getDb();
    // Enable documentRetention on the portfolio.
    await db
      .update(portfolios)
      .set({ documentRetention: true })
      .where(eq(portfolios.id, conn.portfolioId!));

    const PDF = Buffer.from("%PDF-1.4 fake");
    let downloadCalled = false;
    let downloadPairs: { eventId: string; docId: string }[] = [];

    const runner = runnerWith(
      async () => ({
        events: [
          {
            id: "tr-doc-1",
            timestamp: "2026-03-01T10:00:00.000Z",
            eventType: "ORDER_EXECUTED",
            amount: -1000,
            shares: 10,
            isin: "DE0007236101",
            currency: "EUR",
            documentRefs: [{ id: "doc-abc", type: "SECURITIES_SETTLEMENT", date: "2026-03-01" }],
          },
        ],
        sessionData: "JAR",
      }),
      async (_session, pairs) => {
        downloadCalled = true;
        downloadPairs = pairs;
        const docs = new Map<string, DocDownloadResult>();
        for (const { docId } of pairs) {
          docs.set(docId, { buf: PDF, mimeType: "application/pdf" });
        }
        return { docs, failures: [] };
      },
    );

    const storage = makeTrackingStorage();
    const result = await syncTrConnection(db, enc, runner, conn, undefined, storage);

    expect(result.status).toBe("connected");
    expect(result.drafts).toBe(1);
    expect(downloadCalled).toBe(true);
    expect(downloadPairs).toEqual([{ eventId: "tr-doc-1", docId: "doc-abc" }]);
    // A staged document row was inserted with the correct sourceEventId.
    const [imp] = await db
      .select()
      .from(screenshotImports)
      .where(eq(screenshotImports.id, result.importId!));
    const docs = await db
      .select()
      .from(documents)
      .where(eq(documents.importId, imp.id));
    expect(docs).toHaveLength(1);
    expect(docs[0].sourceEventId).toBe("tr-doc-1");
    expect(docs[0].status).toBe("staged");
    expect(docs[0].source).toBe("pytr");
    // Storage received a put call.
    expect(storage.puts).toHaveLength(1);
    expect(storage.puts[0]).toContain("receipts/");
    expect(storage.puts[0]).toContain("doc-abc.pdf");
  });

  it("skips document download when documentRetention=false (default)", async () => {
    const conn = await makeConnection("docs-no-retention");
    const db = getDb();
    // documentRetention defaults to false — do NOT enable it.

    let downloadCalled = false;
    const runner = runnerWith(
      async () => ({
        events: [
          {
            id: "tr-nodoc-1",
            timestamp: "2026-03-01T10:00:00.000Z",
            eventType: "ORDER_EXECUTED",
            amount: -1000,
            shares: 10,
            isin: "DE0007236101",
            currency: "EUR",
            documentRefs: [{ id: "doc-skip", type: "SECURITIES_SETTLEMENT", date: "2026-03-01" }],
          },
        ],
        sessionData: "JAR",
      }),
      async () => {
        downloadCalled = true;
        return { docs: new Map(), failures: [] } as DownloadDocumentsResult;
      },
    );

    const storage = makeTrackingStorage();
    const result = await syncTrConnection(db, enc, runner, conn, undefined, storage);

    expect(result.status).toBe("connected");
    // No download attempt when retention is off.
    expect(downloadCalled).toBe(false);
    expect(storage.puts).toHaveLength(0);
  });

  it("continues sync if document download fails (best-effort)", async () => {
    const conn = await makeConnection("docs-fail");
    const db = getDb();
    await db
      .update(portfolios)
      .set({ documentRetention: true })
      .where(eq(portfolios.id, conn.portfolioId!));

    const runner = runnerWith(
      async () => ({
        events: [
          {
            id: "tr-fail-1",
            timestamp: "2026-03-01T10:00:00.000Z",
            eventType: "PAYMENT_INBOUND",
            amount: 500,
            currency: "EUR",
            documentRefs: [{ id: "doc-fail", type: "TAX", date: "2026-03-01" }],
          },
        ],
        sessionData: "JAR",
      }),
      async () => {
        throw new Error("simulated download failure");
      },
    );

    const storage = makeTrackingStorage();
    const result = await syncTrConnection(db, enc, runner, conn, undefined, storage);

    // Sync must complete despite the download failure (AC #3).
    expect(result.status).toBe("connected");
    expect(result.drafts).toBe(1);
    // No document stored.
    expect(storage.puts).toHaveLength(0);
  });

  it("surfaces documentsRequested/documentsStored in SyncResult when retention=true", async () => {
    const conn = await makeConnection("docs-counts");
    const db = getDb();
    await db
      .update(portfolios)
      .set({ documentRetention: true })
      .where(eq(portfolios.id, conn.portfolioId!));

    const PDF = Buffer.from("%PDF-1.4 count-test");
    const runner = runnerWith(
      async () => ({
        events: [
          {
            id: "tr-count-1",
            timestamp: "2026-03-01T10:00:00.000Z",
            eventType: "ORDER_EXECUTED",
            amount: -100,
            shares: 1,
            isin: "DE0007236101",
            currency: "EUR",
            documentRefs: [{ id: "doc-count-1", type: "SECURITIES_SETTLEMENT", date: "2026-03-01" }],
          },
        ],
        sessionData: "JAR",
      }),
      async (_session, pairs) => {
        const docs = new Map<string, DocDownloadResult>();
        for (const { docId } of pairs) docs.set(docId, { buf: PDF, mimeType: "application/pdf" });
        return { docs, failures: [] };
      },
    );
    const storage = makeTrackingStorage();
    const result = await syncTrConnection(db, enc, runner, conn, undefined, storage);

    expect(result.documentsRequested).toBe(1);
    expect(result.documentsStored).toBe(1);
    // Counts are also folded into lastReconciliation for UI visibility.
    expect((result.reconciliation as unknown as Record<string, unknown>)?.documents).toMatchObject({
      requested: 1,
      stored: 1,
    });
  });

  it("sets documentsStored=0 and surfaces failure when storage put throws", async () => {
    const conn = await makeConnection("docs-put-fail");
    const db = getDb();
    await db
      .update(portfolios)
      .set({ documentRetention: true })
      .where(eq(portfolios.id, conn.portfolioId!));

    const runner = runnerWith(
      async () => ({
        events: [
          {
            id: "tr-putfail-1",
            timestamp: "2026-03-01T10:00:00.000Z",
            eventType: "ORDER_EXECUTED",
            amount: -100,
            shares: 1,
            isin: "DE0007236101",
            currency: "EUR",
            documentRefs: [{ id: "doc-putfail", type: "SECURITIES_SETTLEMENT", date: "2026-03-01" }],
          },
        ],
        sessionData: "JAR",
      }),
      async (_session, pairs) => {
        const docs = new Map<string, DocDownloadResult>();
        for (const { docId } of pairs) docs.set(docId, { buf: Buffer.from("bytes"), mimeType: "application/pdf" });
        return { docs, failures: [] };
      },
    );

    // Storage that always throws on put — simulates bad S3 credentials / 403.
    const failStorage: typeof makeTrackingStorage extends () => infer R ? R : never =
      makeTrackingStorage();
    (failStorage as unknown as { put: unknown }).put = async () => {
      throw Object.assign(new Error("SignatureDoesNotMatch"), {
        name: "SignatureDoesNotMatch",
        $metadata: { httpStatusCode: 403 },
      });
    };

    const result = await syncTrConnection(db, enc, runner, conn, undefined, failStorage);

    // Sync still completes (best-effort).
    expect(result.status).toBe("connected");
    expect(result.documentsRequested).toBe(1);
    expect(result.documentsStored).toBe(0);
    // No DB document row inserted.
    const docs = await db.select().from(documents).where(eq(documents.source, "pytr"));
    const importDoc = docs.find((d) => d.importId === result.importId);
    expect(importDoc).toBeUndefined();
  });

  it("completes (best-effort) and stores 0 docs when downloadDocuments throws a process error", async () => {
    const conn = await makeConnection("docs-download-throws");
    const db = getDb();
    await db
      .update(portfolios)
      .set({ documentRetention: true })
      .where(eq(portfolios.id, conn.portfolioId!));

    const runner = runnerWith(
      async () => ({
        events: [
          {
            id: "tr-dl-throw-1",
            timestamp: "2026-03-01T10:00:00.000Z",
            eventType: "ORDER_EXECUTED",
            amount: -100,
            shares: 1,
            isin: "DE0007236101",
            currency: "EUR",
            documentRefs: [{ id: "doc-dl-throw", type: "SECURITIES_SETTLEMENT", date: "2026-03-01" }],
          },
        ],
        sessionData: "JAR",
      }),
      // Process-level failure (e.g. session expired mid-download) — must not abort the sync.
      async () => {
        throw new PytrAuthError("session expired during document download");
      },
    );
    const storage = makeTrackingStorage();
    const result = await syncTrConnection(db, enc, runner, conn, undefined, storage);

    // Sync still finishes and the connection stays connected; the download is best-effort.
    expect(result.status).toBe("connected");
    expect(result.documentsRequested).toBe(1);
    expect(result.documentsStored).toBe(0);
    expect(storage.puts).toHaveLength(0);
    // The total-failure reason is surfaced so the UI can distinguish it from a partial save.
    expect(result.reconciliation?.documents).toMatchObject({
      requested: 1,
      stored: 0,
      error: "session expired during document download",
    });
  });

  it("ignores a malformed collector parsedJson and re-stages from the timeline (self-heal)", async () => {
    const conn = await makeConnection("collector-malformed");
    const db = getDb();

    // A corrupt open collector draft (e.g. a bad write / shape change) must not throw the sync.
    await db.insert(screenshotImports).values({
      userId: conn.userId,
      portfolioId: conn.portfolioId!,
      parser: "pytr",
      status: "draft",
      parsedJson: { drafts: "not-an-array", oops: true } as unknown as object,
    });

    const runner = runnerWith(async () => ({
      events: [
        { id: "tr-heal-1", timestamp: "2026-03-01T10:00:00.000Z", eventType: "ORDER_EXECUTED", amount: -100, shares: 1, isin: "DE0007236101", currency: "EUR" },
      ],
      sessionData: "JAR",
    }));
    const result = await syncTrConnection(db, enc, runner, conn);

    expect(result.status).toBe("connected");
    // The event is re-staged fresh rather than throwing on the malformed prior draft.
    expect(result.drafts).toBe(1);
  });

  it("ignores a malformed lastReconciliation without throwing", async () => {
    const conn = await makeConnection("recon-malformed");
    const db = getDb();
    await db
      .update(trConnections)
      .set({ lastReconciliation: { not: "a reconciliation" } as unknown as object })
      .where(eq(trConnections.id, conn.id));

    const fresh = (await db.select().from(trConnections).where(eq(trConnections.id, conn.id)))[0];
    const runner = runnerWith(async () => ({
      events: [
        { id: "tr-recon-1", timestamp: "2026-03-01T10:00:00.000Z", eventType: "ORDER_EXECUTED", amount: -100, shares: 1, isin: "DE0007236101", currency: "EUR" },
      ],
      sessionData: "JAR",
    }));
    const result = await syncTrConnection(db, enc, runner, fresh);
    expect(result.status).toBe("connected");
  });

  it("warns when cash-reconciliation drift jumps past the threshold between syncs", async () => {
    const conn = await makeConnection("drift-warn");
    const db = getDb();
    const warns: { ctx: unknown; msg: string }[] = [];
    const log = {
      warn: (ctx: unknown, msg: string) => warns.push({ ctx, msg }),
      info: () => {},
      debug: () => {},
      error: () => {},
    } as unknown as Parameters<typeof syncTrConnection>[4];

    // Sync 1: a single deposit; TR reports a balance €100 higher than derived → diff 100.
    const runner1 = runnerWith(async () => ({
      events: [
        { id: "d1", timestamp: "2026-03-01T10:00:00.000Z", eventType: "PAYMENT_INBOUND", amount: 50, currency: "EUR" },
      ],
      sessionData: "J",
      summary: { cash: [{ currency: "EUR", amount: "150" }] },
    }));
    await syncTrConnection(db, enc, runner1, conn, log);

    // Sync 2: TR now reports €150 higher than the new derived → diff jumps by 100 (> €1).
    const fresh = (await db.select().from(trConnections).where(eq(trConnections.id, conn.id)))[0];
    const runner2 = runnerWith(async () => ({
      events: [
        { id: "d1", timestamp: "2026-03-01T10:00:00.000Z", eventType: "PAYMENT_INBOUND", amount: 50, currency: "EUR" },
        { id: "d2", timestamp: "2026-03-02T10:00:00.000Z", eventType: "PAYMENT_INBOUND", amount: 50, currency: "EUR" },
      ],
      sessionData: "J",
      summary: { cash: [{ currency: "EUR", amount: "300" }] },
    }));
    await syncTrConnection(db, enc, runner2, fresh, log);

    expect(warns.some((w) => w.msg === "tr cash reconciliation drift jumped")).toBe(true);
  });
});
