import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  instruments,
  portfolios,
  portfolioSnapshots,
  transactions,
  users,
} from "@portfolio/db";
import { MarketDataService, FixtureProvider } from "@portfolio/market-data";
import { ensureDb, getDb, closeDb } from "../../src/db/client.js";
import {
  recordDailySnapshots,
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
      .values({ userId: u.id, name: "Snap", baseCurrency: "IDR" })
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
    const svc = new MarketDataService([new FixtureProvider()]);
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
    const fx = (from: string, to: string) =>
      from === "USD" && to === "IDR" ? "16000" : "1";
    const out = aggregateByDate(
      [
        { date: "2026-02-01", netWorth: "1000000", currency: "IDR" },
        { date: "2026-02-01", netWorth: "100", currency: "USD" },
        { date: "2026-02-02", netWorth: "1200000", currency: "IDR" },
      ],
      fx,
      "IDR",
    );
    expect(out).toEqual([
      { date: "2026-02-01", netWorth: "2600000" }, // 1,000,000 + 100×16,000
      { date: "2026-02-02", netWorth: "1200000" },
    ]);
  });
});
