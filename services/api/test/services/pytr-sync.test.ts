import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import {
  users,
  portfolios,
  trConnections,
  screenshotImports,
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
