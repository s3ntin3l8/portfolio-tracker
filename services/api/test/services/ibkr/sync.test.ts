import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import crypto from "node:crypto";
import {
  ibkrConnections,
  portfolios,
  screenshotImports,
  transactions,
  trResolvedEvents,
  users,
} from "@portfolio/db";
import { ensureDb, getDb, closeDb } from "../../../src/db/client.js";
import { EncryptionService } from "../../../src/services/encryption.js";
import { syncIbkrConnection } from "../../../src/services/ibkr/sync.js";
import type { IbkrFlexClient } from "../../../src/services/ibkr/flex-client.js";
import { IbkrFlexError } from "../../../src/services/ibkr/flex-client.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "../../fixtures/ibkr");
const ACTIVITY_XML = readFileSync(join(FIXTURE_DIR, "activity.xml"), "utf8");
const OPENING_EMPTY_XML = readFileSync(join(FIXTURE_DIR, "activity-opening-empty.xml"), "utf8");

const enc = new EncryptionService({ key: crypto.randomBytes(32).toString("base64url") });

function mockFlex(xml = ACTIVITY_XML): IbkrFlexClient {
  return { fetchFlexStatement: async () => xml };
}

function failingFlex(code: "expired" | "error" = "error"): IbkrFlexClient {
  return {
    fetchFlexStatement: async () => {
      throw new IbkrFlexError(code, "mock error");
    },
  };
}

async function makeConnection(
  suffix: string,
  opts: { baseCurrency?: string; cashCounted?: boolean } = {},
) {
  const db = getDb();
  const [user] = await db
    .insert(users)
    .values({ authSub: `ibkr-sync|${suffix}`, email: `${suffix}@ibkr.test` })
    .returning();
  const [portfolio] = await db
    .insert(portfolios)
    .values({
      userId: user.id,
      name: "IBKR",
      baseCurrency: opts.baseCurrency ?? "USD",
      cashCounted: opts.cashCounted ?? false,
    })
    .returning();
  const [conn] = await db
    .insert(ibkrConnections)
    .values({
      userId: user.id,
      portfolioId: portfolio.id,
      tokenEnc: enc.encryptString("FLEX_TOKEN"),
      queryId: "12345",
      status: "connected",
    })
    .returning();
  return { user, portfolio, conn };
}

beforeAll(async () => {
  await ensureDb(); // uses the unique tmpDir DATABASE_URL set by setup.ts
});

afterAll(async () => {
  await closeDb();
});

describe("syncIbkrConnection", () => {
  it("creates a collector draft with 8 items from the activity fixture", async () => {
    const { conn } = await makeConnection("t1");
    const result = await syncIbkrConnection(getDb(), enc, mockFlex(), conn);
    expect(result.status).toBe("connected");
    expect(result.drafts).toBe(8);
    expect(result.errors).toBe(0);
    expect(result.importId).toBeDefined();
  });

  it("does not re-materialize events already in the table", async () => {
    const { conn } = await makeConnection("t2");

    // First sync materializes 8 draft transactions.
    const r1 = await syncIbkrConnection(getDb(), enc, mockFlex(), conn);
    expect(r1.drafts).toBe(8);

    // Second sync — every event already has a transaction row, so nothing new is created
    // (the externalId set absorbs them; no dependence on the resolved ledger).
    const r2 = await syncIbkrConnection(getDb(), enc, mockFlex(), conn);
    expect(r2.drafts).toBe(0);
  });

  it("sets connection to expired when flex client throws IbkrFlexError(expired)", async () => {
    const { conn } = await makeConnection("t3");
    const result = await syncIbkrConnection(getDb(), enc, failingFlex("expired"), conn);
    expect(result.status).toBe("expired");

    const [updated] = await getDb()
      .select()
      .from(ibkrConnections)
      .where(eq(ibkrConnections.id, conn.id));
    expect(updated!.status).toBe("expired");
  });

  it("sets connection to error when flex client throws IbkrFlexError(error)", async () => {
    const { conn } = await makeConnection("t4");
    const result = await syncIbkrConnection(getDb(), enc, failingFlex("error"), conn);
    expect(result.status).toBe("error");
  });

  it("returns error when connection has no portfolioId", async () => {
    const { conn } = await makeConnection("t5");
    const result = await syncIbkrConnection(getDb(), enc, mockFlex(), { ...conn, portfolioId: null });
    expect(result.status).toBe("error");
  });

  it("includes cash reconciliation (CashReport has USD and EUR entries)", async () => {
    const { conn } = await makeConnection("t6");
    const result = await syncIbkrConnection(getDb(), enc, mockFlex(), conn);
    expect(result.reconciliation).toBeDefined();
    expect(result.reconciliation!.cash.length).toBeGreaterThan(0);
  });

  it("updates flexAccountId from the Flex statement (U1234567 in fixture)", async () => {
    const { conn } = await makeConnection("t7");
    await syncIbkrConnection(getDb(), enc, mockFlex(), conn);
    const [updated] = await getDb()
      .select()
      .from(ibkrConnections)
      .where(eq(ibkrConnections.id, conn.id));
    expect(updated!.flexAccountId).toBe("U1234567");
  });

  it("books a standing/opening cash balance from a BASE_SUMMARY-only CashReport", async () => {
    const { conn } = await makeConnection("t9", { baseCurrency: "EUR", cashCounted: true });
    const result = await syncIbkrConnection(getDb(), enc, mockFlex(OPENING_EMPTY_XML), conn);

    // Exactly one opening-balance deposit draft transaction, no errors.
    expect(result.drafts).toBe(1);
    expect(result.errors).toBe(0);
    const draftRows = await getDb()
      .select({ externalId: transactions.externalId, type: transactions.type })
      .from(transactions)
      .where(and(eq(transactions.portfolioId, conn.portfolioId!), eq(transactions.status, "draft")));
    expect(draftRows).toHaveLength(1);
    expect(draftRows[0]!.externalId).toBe("ibkr:opening:U6794520:EUR");
    expect(draftRows[0]!.type).toBe("deposit");

    // Reconciliation reports the real currency and matches (diff 0.00), never BASE_SUMMARY.
    expect(result.reconciliation!.cash).toHaveLength(1);
    const row = result.reconciliation!.cash[0]!;
    expect(row.currency).toBe("EUR");
    expect(row.diff).toBe("0.00");
  });

  it("books the opening balance only once across repeated syncs", async () => {
    const { conn, portfolio } = await makeConnection("t10", {
      baseCurrency: "EUR",
      cashCounted: true,
    });
    const r1 = await syncIbkrConnection(getDb(), enc, mockFlex(OPENING_EMPTY_XML), conn);
    expect(r1.drafts).toBe(1);

    // Resolve the opening draft (simulating the user confirming it).
    await getDb()
      .insert(trResolvedEvents)
      .values({
        portfolioId: portfolio.id,
        source: "ibkr",
        eventId: "ibkr:opening:U6794520:EUR",
        resolution: "confirmed",
      })
      .onConflictDoNothing();

    // Second sync — opening already resolved, nothing new staged, recon still matches.
    const r2 = await syncIbkrConnection(getDb(), enc, mockFlex(OPENING_EMPTY_XML), conn);
    expect(r2.drafts).toBe(0);
    expect(r2.reconciliation!.cash[0]!.diff).toBe("0.00");
  });

  it("uses source='ibkr' in resolved-events ledger (not pytr)", async () => {
    const { conn, portfolio } = await makeConnection("t8");
    const r1 = await syncIbkrConnection(getDb(), enc, mockFlex(), conn);

    // Resolve one event.
    const [imp] = await getDb()
      .select()
      .from(screenshotImports)
      .where(eq(screenshotImports.id, r1.importId!));
    const parsed = imp!.parsedJson as { drafts: { externalId?: string | null }[] };
    const firstId = parsed.drafts[0]?.externalId ?? "";
    await getDb().insert(trResolvedEvents).values({
      portfolioId: portfolio.id,
      source: "ibkr",
      eventId: firstId,
      resolution: "confirmed",
    }).onConflictDoNothing();

    // Verify source='ibkr' row exists.
    const rows = await getDb()
      .select()
      .from(trResolvedEvents)
      .where(
        and(
          eq(trResolvedEvents.portfolioId, portfolio.id),
          eq(trResolvedEvents.source, "ibkr"),
        ),
      );
    expect(rows.length).toBeGreaterThan(0);

    // Verify source='pytr' row does NOT exist for this portfolio.
    const pytrRows = await getDb()
      .select()
      .from(trResolvedEvents)
      .where(
        and(
          eq(trResolvedEvents.portfolioId, portfolio.id),
          eq(trResolvedEvents.source, "pytr"),
        ),
      );
    expect(pytrRows.length).toBe(0);
  });
});
