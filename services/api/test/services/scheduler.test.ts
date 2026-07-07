import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { users, portfolios, trConnections, ibkrConnections } from "@portfolio/db";
import { ensureDb, closeDb } from "../../src/db/client.js";
import { resetStaleSyncFlags } from "../../src/services/scheduler.js";

// resetStaleSyncFlags is the scheduler's startup reaper (see startScheduler in
// scheduler.ts), split out into its own function specifically so it's testable here
// without needing real Postgres/pg-boss — startScheduler itself no-ops on PGlite.
describe("resetStaleSyncFlags", () => {
  let userId: string;
  let portfolioId: string;

  beforeAll(async () => {
    const db = await ensureDb();
    const [user] = await db
      .insert(users)
      .values({ authSub: "scheduler-reaper|u", email: "reaper@example.com" })
      .returning();
    userId = user.id;
    const [pf] = await db
      .insert(portfolios)
      .values({ userId, name: "Reaper Test", baseCurrency: "EUR" })
      .returning();
    portfolioId = pf.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("clears a stale syncing=true flag left behind by a killed worker, and reports the count", async () => {
    const db = await ensureDb();
    const [conn] = await db
      .insert(trConnections)
      .values({
        userId,
        portfolioId,
        phoneEnc: "enc-phone",
        pinEnc: "enc-pin",
        status: "connected",
        syncing: true, // simulates a process that died mid-sync, never clearing the flag
      })
      .returning();

    const result = await resetStaleSyncFlags(db);
    expect(result.trConnections).toBe(1);

    const [after] = await db.select().from(trConnections).where(eq(trConnections.id, conn.id));
    expect(after.syncing).toBe(false);
  });

  it("leaves a genuinely idle connection (syncing=false) untouched", async () => {
    const db = await ensureDb();
    const [user2] = await db
      .insert(users)
      .values({ authSub: "scheduler-reaper|idle", email: "reaper-idle@example.com" })
      .returning();
    const [pf2] = await db
      .insert(portfolios)
      .values({ userId: user2.id, name: "Idle", baseCurrency: "EUR" })
      .returning();
    const [conn] = await db
      .insert(trConnections)
      .values({
        userId: user2.id,
        portfolioId: pf2.id,
        phoneEnc: "enc-phone",
        pinEnc: "enc-pin",
        status: "connected",
        syncing: false,
      })
      .returning();
    const updatedAtBefore = conn.updatedAt;

    const result = await resetStaleSyncFlags(db);
    expect(result.trConnections).toBe(0);

    const [after] = await db.select().from(trConnections).where(eq(trConnections.id, conn.id));
    expect(after.syncing).toBe(false);
    expect(after.updatedAt).toEqual(updatedAtBefore);
  });

  it("clears a stale ibkr_connections.syncing flag too, counted separately", async () => {
    const db = await ensureDb();
    const [user3] = await db
      .insert(users)
      .values({ authSub: "scheduler-reaper|ibkr", email: "reaper-ibkr@example.com" })
      .returning();
    const [pf3] = await db
      .insert(portfolios)
      .values({ userId: user3.id, name: "IBKR Reaper", baseCurrency: "USD" })
      .returning();
    const [conn] = await db
      .insert(ibkrConnections)
      .values({
        userId: user3.id,
        portfolioId: pf3.id,
        tokenEnc: "enc-token",
        queryId: "42",
        status: "connected",
        syncing: true,
      })
      .returning();

    const result = await resetStaleSyncFlags(db);
    expect(result.ibkrConnections).toBe(1);
    expect(result.trConnections).toBe(0);

    const [after] = await db.select().from(ibkrConnections).where(eq(ibkrConnections.id, conn.id));
    expect(after.syncing).toBe(false);
  });
});
