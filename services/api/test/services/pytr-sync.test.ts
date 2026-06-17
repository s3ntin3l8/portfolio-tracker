import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  users,
  portfolios,
  trConnections,
  screenshotImports,
  transactions,
  trResolvedEvents,
} from "@portfolio/db";
import { ensureDb, getDb, closeDb } from "../../src/db/client.js";
import { EncryptionService } from "../../src/services/encryption.js";
import { syncTrConnection } from "../../src/services/pytr/sync.js";
import { PytrAuthError, type PytrRunner } from "../../src/services/pytr/runner.js";

const enc = new EncryptionService({ key: crypto.randomBytes(32).toString("base64url") });

// A mock runner whose export() is set per test — no Python, no network.
function runnerWith(
  exportImpl: PytrRunner["export"],
): PytrRunner {
  return { export: exportImpl } as unknown as PytrRunner;
}

const EVENTS = [
  { id: "tr-1", timestamp: "2026-03-01T10:00:00.000Z", eventType: "ORDER_EXECUTED", amount: -1000, shares: 10, isin: "DE0007236101", currency: "EUR" },
  { id: "tr-2", timestamp: "2026-03-02T10:00:00.000Z", eventType: "PAYMENT_INBOUND", amount: 500, currency: "EUR" },
  { id: "tr-3", timestamp: "2026-03-03T10:00:00.000Z", eventType: "MYSTERY", amount: 1, currency: "EUR" },
];

async function makeConnection(suffix: string) {
  const db = getDb();
  const [user] = await db
    .insert(users)
    .values({ authSub: `tr-sync|${suffix}`, email: `${suffix}@example.com` })
    .returning();
  const [pf] = await db
    .insert(portfolios)
    .values({ userId: user.id, name: "TR", baseCurrency: "EUR" })
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

  it("excludes card spending by default, stages it once the category is enabled", async () => {
    const conn = await makeConnection("categories");
    const db = getDb();
    const evs = [
      { id: "card-1", timestamp: "2026-03-01T10:00:00.000Z", eventType: "CARD_TRANSACTION", amount: -12.5, currency: "EUR" },
      { id: "dep-1", timestamp: "2026-03-02T10:00:00.000Z", eventType: "PAYMENT_INBOUND", amount: 100, currency: "EUR" },
    ];
    const runner = runnerWith(async () => ({ events: evs, sessionData: "J" }));

    // Default categories exclude card spending → only the deposit is staged.
    const r1 = await syncTrConnection(db, enc, runner, conn);
    expect(r1.drafts).toBe(1);

    // Enable the card category; the card event (not previously marked seen) now stages.
    await db
      .update(trConnections)
      .set({ importCategories: ["trade", "income", "cashflow", "card"] })
      .where(eq(trConnections.id, conn.id));
    const [conn2] = await db.select().from(trConnections).where(eq(trConnections.id, conn.id));
    const r2 = await syncTrConnection(db, enc, runner, conn2);
    expect(r2.drafts).toBe(1); // the card txn; the deposit was already staged

    const [draft] = await db
      .select()
      .from(screenshotImports)
      .where(and(eq(screenshotImports.portfolioId, conn.portfolioId!), eq(screenshotImports.status, "draft")));
    const parsed = draft.parsedJson as { drafts: { externalId: string }[] };
    expect(parsed.drafts.map((d) => d.externalId).sort()).toEqual(["card-1", "dep-1"]);
  });

  it("reconciles derived cash against TR's reported balance", async () => {
    const conn = await makeConnection("reconcile");
    const db = getDb();
    // A €500 deposit + a €100 sell-less example; derived cash = 500. TR reports 480 → diff 20.
    const evs = [{ id: "d-1", timestamp: "2026-03-02T10:00:00.000Z", eventType: "PAYMENT_INBOUND", amount: 500, currency: "EUR" }];
    const runner = runnerWith(async () => ({
      events: evs,
      sessionData: "J",
      summary: { cash: [{ currency: "EUR", amount: 480 }] },
    }));
    // Confirm the deposit so it counts toward derived cash.
    await db.insert(transactions).values({
      portfolioId: conn.portfolioId!,
      type: "deposit",
      price: "500",
      currency: "EUR",
      executedAt: new Date("2026-03-02T10:00:00.000Z"),
      source: "pytr",
      externalId: "d-1",
    });

    const result = await syncTrConnection(db, enc, runner, conn);
    expect(result.reconciliation?.cash).toEqual([
      { currency: "EUR", reported: "480", derived: "500", diff: "-20.00" },
    ]);

    const [updated] = await db.select().from(trConnections).where(eq(trConnections.id, conn.id));
    expect((updated.lastReconciliation as { cash: unknown[] }).cash).toHaveLength(1);
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
});
