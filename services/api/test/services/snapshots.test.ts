import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  instruments,
  portfolioIntradaySnapshots,
  portfolios,
  portfolioSnapshots,
  prices,
  transactions,
  users,
} from "@portfolio/db";
import { MarketDataService, FixtureProvider } from "@portfolio/market-data";
import { ensureDb, getDb, closeDb } from "../../src/db/client.js";
import {
  recordDailySnapshots,
  recordIntradaySnapshots,
  rangeStart,
  aggregateByDate,
} from "../../src/services/snapshots.js";

describe("recordDailySnapshots", () => {
  let portfolioId: string;

  beforeAll(async () => {
    const db = await ensureDb();
    const [u] = await db
      .insert(users)
      .values({ authSub: "snap-user", email: "snap@example.com" })
      .returning();
    const [p] = await db
      .insert(portfolios)
      .values({ userId: u.id, name: "Snap", baseCurrency: "IDR", cashCounted: true })
      .returning();
    portfolioId = p.id;
    const [bbca] = await db
      .insert(instruments)
      .values({
        symbol: "BBCA",
        market: "IDX",
        assetClass: "equity",
        currency: "IDR",
        name: "BCA",
      })
      .returning();
    // Deposit 2,000,000, buy 100 @ 9,000 → cash 1,100,000 + 100×9,500 (fixture price).
    await db.insert(transactions).values([
      {
        portfolioId,
        type: "deposit",
        price: "2000000",
        currency: "IDR",
        executedAt: new Date("2026-01-01"),
      },
      {
        portfolioId,
        instrumentId: bbca.id,
        type: "buy",
        quantity: "100",
        price: "9000",
        currency: "IDR",
        executedAt: new Date("2026-01-02"),
      },
    ]);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("writes one net-worth snapshot per portfolio, idempotent per day", async () => {
    const db = getDb();
    const svc = new MarketDataService([new FixtureProvider({ BBCA: "9500" })]);
    const now = new Date("2026-02-08T16:00:00.000Z");

    const count = await recordDailySnapshots(db, svc, 10_000, now);
    expect(count).toBe(1);

    const rows = await db
      .select()
      .from(portfolioSnapshots)
      .where(eq(portfolioSnapshots.portfolioId, portfolioId));
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe("2026-02-08");
    expect(rows[0].netWorth).toBe("2050000"); // 1,100,000 cash + 100×9,500

    // Re-running the same day overwrites rather than appends.
    await recordDailySnapshots(db, svc, 10_000, now);
    const again = await db
      .select()
      .from(portfolioSnapshots)
      .where(eq(portfolioSnapshots.portfolioId, portfolioId));
    expect(again).toHaveLength(1);
  });

  it("carries forward last-known close for an unpriced held instrument (≤7d stale)", async () => {
    const db = getDb();
    const [u] = await db
      .insert(users)
      .values({ authSub: "carry-user", email: "carry@example.com" })
      .returning();
    const [p] = await db
      .insert(portfolios)
      .values({ userId: u.id, name: "Carry", baseCurrency: "IDR", cashCounted: true })
      .returning();
    const [instA] = await db
      .insert(instruments)
      .values({
        symbol: "INSTA",
        market: "IDX",
        assetClass: "equity",
        currency: "IDR",
        name: "Inst A (priced)",
      })
      .returning();
    const [instB] = await db
      .insert(instruments)
      .values({
        symbol: "INSTB",
        market: "IDX",
        assetClass: "equity",
        currency: "IDR",
        name: "Inst B (historical only)",
      })
      .returning();

    // Both held, same quantity × price.
    await db.insert(transactions).values([
      {
        portfolioId: p.id,
        instrumentId: instA.id,
        type: "buy",
        quantity: "10",
        price: "1000",
        currency: "IDR",
        executedAt: new Date("2026-01-10"),
      },
      {
        portfolioId: p.id,
        instrumentId: instB.id,
        type: "buy",
        quantity: "10",
        price: "2000",
        currency: "IDR",
        executedAt: new Date("2026-01-10"),
      },
    ]);

    // Seed historical price for B (2 days ago = ≤7d cap).
    const twoDaysAgo = new Date();
    twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2);
    await db.insert(prices).values({
      instrumentId: instB.id,
      date: twoDaysAgo.toISOString().slice(0, 10),
      close: "2500",
      currency: "IDR",
    });

    // FixtureProvider only returns a quote for A, not B.
    const svc = new MarketDataService([new FixtureProvider({ INSTA: "1100" })]);
    const now = new Date();

    const count = await recordDailySnapshots(db, svc, 10_000, now);
    expect(count).toBeGreaterThanOrEqual(1);

    const rows = await db
      .select()
      .from(portfolioSnapshots)
      .where(eq(portfolioSnapshots.portfolioId, p.id));
    expect(rows).toHaveLength(1);
    // MV: 10×1100 (A) + 10×2500 (B carried) = 36,000. No cash tracked (no deposit).
    expect(rows[0].marketValue).toBe("36000");
    // Net worth same as MV (no cash).
    expect(rows[0].netWorth).toBe("36000");
  });

  it("leaves a held instrument unpriced when last close is older than 7 days", async () => {
    const db = getDb();
    const [u] = await db
      .insert(users)
      .values({ authSub: "stale-user", email: "stale@example.com" })
      .returning();
    const [p] = await db
      .insert(portfolios)
      .values({ userId: u.id, name: "Stale", baseCurrency: "IDR", cashCounted: true })
      .returning();
    const [instA] = await db
      .insert(instruments)
      .values({
        symbol: "FRESHA",
        market: "IDX",
        assetClass: "equity",
        currency: "IDR",
        name: "Fresh A (priced)",
      })
      .returning();
    const [instB] = await db
      .insert(instruments)
      .values({
        symbol: "STALEB",
        market: "IDX",
        assetClass: "equity",
        currency: "IDR",
        name: "Stale B (old price)",
      })
      .returning();

    await db.insert(transactions).values([
      {
        portfolioId: p.id,
        instrumentId: instA.id,
        type: "buy",
        quantity: "10",
        price: "1000",
        currency: "IDR",
        executedAt: new Date("2026-01-10"),
      },
      {
        portfolioId: p.id,
        instrumentId: instB.id,
        type: "buy",
        quantity: "10",
        price: "2000",
        currency: "IDR",
        executedAt: new Date("2026-01-10"),
      },
    ]);

    // Seed historical price for B — 30 days ago (beyond 7-day cap).
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
    await db.insert(prices).values({
      instrumentId: instB.id,
      date: thirtyDaysAgo.toISOString().slice(0, 10),
      close: "2500",
      currency: "IDR",
    });

    const svc = new MarketDataService([new FixtureProvider({ FRESHA: "1100" })]);
    const now = new Date();

    const count = await recordDailySnapshots(db, svc, 10_000, now);
    expect(count).toBeGreaterThanOrEqual(1);

    const rows = await db
      .select()
      .from(portfolioSnapshots)
      .where(eq(portfolioSnapshots.portfolioId, p.id));
    expect(rows).toHaveLength(1);
    // Only A contributes: 10×1100 = 11,000. B is too stale → unpriced.
    expect(rows[0].marketValue).toBe("11000");
  });
});

describe("recordIntradaySnapshots", () => {
  let portfolioId: string;

  beforeAll(async () => {
    const db = await ensureDb();
    const [u] = await db
      .insert(users)
      .values({ authSub: "intraday-user", email: "intraday@example.com" })
      .returning();
    const [p] = await db
      .insert(portfolios)
      .values({ userId: u.id, name: "Intraday", baseCurrency: "IDR", cashCounted: true })
      .returning();
    portfolioId = p.id;
    const [bbca] = await db
      .insert(instruments)
      .values({
        symbol: "INTRA",
        market: "IDX", // IDX regular session: Mon–Fri 02:00–09:00 UTC
        assetClass: "equity",
        currency: "IDR",
        name: "Intraday Test Co",
      })
      .returning();
    await db.insert(transactions).values([
      {
        portfolioId,
        instrumentId: bbca.id,
        type: "buy",
        quantity: "100",
        price: "9000",
        currency: "IDR",
        executedAt: new Date("2026-01-02"),
      },
    ]);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("captures a point when a held instrument's market is open", async () => {
    const db = getDb();
    const svc = new MarketDataService([new FixtureProvider({ INTRA: "9500" })]);
    // Monday 05:00 UTC — inside the IDX session.
    const now = new Date("2026-02-09T05:00:00.000Z");

    const count = await recordIntradaySnapshots(db, svc, 10_000, now);
    // Other portfolios seeded by earlier describes in this file (also holding IDX
    // instruments) may be captured in the same run, so only assert a lower bound —
    // the specific per-portfolio row assertion below is what actually matters here.
    expect(count).toBeGreaterThanOrEqual(1);

    const rows = await db
      .select()
      .from(portfolioIntradaySnapshots)
      .where(eq(portfolioIntradaySnapshots.portfolioId, portfolioId));
    expect(rows).toHaveLength(1);
    expect(rows[0].netWorth).toBe("950000"); // 100 × 9,500
    expect(rows[0].capturedAt.toISOString()).toBe(now.toISOString());
  });

  it("does not touch the DB when no held market is open", async () => {
    const db = getDb();
    const svc = new MarketDataService([new FixtureProvider({ INTRA: "9500" })]);
    // Same Monday, 12:00 UTC — outside the IDX session.
    const now = new Date("2026-02-09T12:00:00.000Z");

    const before = await db
      .select()
      .from(portfolioIntradaySnapshots)
      .where(eq(portfolioIntradaySnapshots.portfolioId, portfolioId));

    const count = await recordIntradaySnapshots(db, svc, 10_000, now);
    expect(count).toBe(0);

    const after = await db
      .select()
      .from(portfolioIntradaySnapshots)
      .where(eq(portfolioIntradaySnapshots.portfolioId, portfolioId));
    expect(after).toHaveLength(before.length);
  });

  it("appends a new row rather than upserting (many rows/day allowed)", async () => {
    const db = getDb();
    const svc = new MarketDataService([new FixtureProvider({ INTRA: "9600" })]);
    const now = new Date("2026-02-09T05:15:00.000Z");

    await recordIntradaySnapshots(db, svc, 10_000, now);
    const rows = await db
      .select()
      .from(portfolioIntradaySnapshots)
      .where(eq(portfolioIntradaySnapshots.portfolioId, portfolioId));
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("prunes rows older than the retention window", async () => {
    const db = getDb();
    const svc = new MarketDataService([new FixtureProvider({ INTRA: "9500" })]);
    await db.insert(portfolioIntradaySnapshots).values({
      portfolioId,
      capturedAt: new Date("2026-01-01T05:00:00.000Z"), // well past 8 days before Feb 9
      netWorth: "1",
      marketValue: "1",
      currency: "IDR",
    });

    await recordIntradaySnapshots(db, svc, 10_000, new Date("2026-02-09T05:30:00.000Z"));

    const rows = await db
      .select()
      .from(portfolioIntradaySnapshots)
      .where(eq(portfolioIntradaySnapshots.portfolioId, portfolioId));
    expect(rows.every((r) => r.capturedAt.getTime() > new Date("2026-01-10").getTime())).toBe(true);
  });
});

describe("rangeStart", () => {
  it("computes a lower bound for known ranges, null for all/unknown", () => {
    const now = new Date("2026-06-15T00:00:00.000Z");
    expect(rangeStart("1m", now)).toBe("2026-05-16");
    expect(rangeStart("1y", now)).toBe("2025-06-15");
    expect(rangeStart("all", now)).toBeNull();
    expect(rangeStart("nope", now)).toBeNull();
  });
});

describe("aggregateByDate", () => {
  it("sums same-date snapshots, FX-converting to the display currency", () => {
    const fxFor = () => (from: string, to: string) =>
      from === "USD" && to === "IDR" ? "16000" : "1";
    const out = aggregateByDate(
      [
        { date: "2026-02-01", netWorth: "1000000", currency: "IDR" },
        { date: "2026-02-01", netWorth: "100", currency: "USD" },
        { date: "2026-02-02", netWorth: "1200000", currency: "IDR" },
      ],
      fxFor,
      "IDR",
    );
    expect(out).toEqual([
      { date: "2026-02-01", netWorth: "2600000" }, // 1,000,000 + 100×16,000
      { date: "2026-02-02", netWorth: "1200000" },
    ]);
  });

  it("converts each date at its own day's rate", () => {
    // USD→IDR weakens 16,000 → 16,500 between the two days.
    const rates: Record<string, string> = {
      "2026-02-01": "16000",
      "2026-02-02": "16500",
    };
    const fxFor = (date: string) => (from: string, to: string) =>
      from === "USD" && to === "IDR" ? rates[date] : "1";
    const out = aggregateByDate(
      [
        { date: "2026-02-01", netWorth: "100", currency: "USD" },
        { date: "2026-02-02", netWorth: "100", currency: "USD" },
      ],
      fxFor,
      "IDR",
    );
    expect(out).toEqual([
      { date: "2026-02-01", netWorth: "1600000" }, // 100 × 16,000
      { date: "2026-02-02", netWorth: "1650000" }, // 100 × 16,500
    ]);
  });
});
