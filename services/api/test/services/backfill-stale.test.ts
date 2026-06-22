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
import { backfillStalePortfolios } from "../../src/services/backfill.js";

/**
 * Tests for backfillStalePortfolios (#269).
 *
 * Uses PGlite + FixtureProvider so no external DB or market-data API is needed.
 * The FixtureProvider returns a fixed price for known symbols; the backfill engine
 * gracefully skips instruments with no history (logs a warning, continues).
 *
 * Coverage:
 * 1. A portfolio with no snapshots is detected as stale and healed (snapshots written
 *    from inception to today).
 * 2. A portfolio that is already fully backfilled (earliest snapshot == inception) is
 *    skipped — idempotency.
 * 3. Re-running the sweep after all portfolios are healed returns healed: 0.
 */
describe("backfillStalePortfolios", () => {
  let stalePortfolioId: string;
  let healedPortfolioId: string;
  let bondInstrId: string;

  const INCEPTION_DATE = "2026-01-15";
  const svc = new MarketDataService([new FixtureProvider({ BBCA: "9500" })]);

  beforeAll(async () => {
    const db = await ensureDb();

    const [u] = await db
      .insert(users)
      .values({ authSub: "stale-sweep-user", email: "stale-sweep@example.com" })
      .returning();

    // ── Stale portfolio: has transactions, but NO snapshots ──────────────────
    const [stale] = await db
      .insert(portfolios)
      .values({
        userId: u.id,
        name: "Stale Portfolio",
        baseCurrency: "IDR",
        cashCounted: true,
      })
      .returning();
    stalePortfolioId = stale.id;

    // Use a bond so the flat-faceValue path is exercised (no provider history needed).
    const [bond] = await db
      .insert(instruments)
      .values({
        symbol: "SBN001",
        market: "IDX",
        assetClass: "bond",
        currency: "IDR",
        name: "Test Bond",
        faceValue: "1000000",
      })
      .returning();
    bondInstrId = bond.id;

    await db.insert(transactions).values([
      {
        portfolioId: stalePortfolioId,
        instrumentId: bondInstrId,
        type: "buy",
        quantity: "1",
        price: "1000000",
        currency: "IDR",
        executedAt: new Date(`${INCEPTION_DATE}T10:00:00.000Z`),
      },
    ]);

    // ── Already-healed portfolio: has a snapshot exactly at inception ────────
    const [healed] = await db
      .insert(portfolios)
      .values({
        userId: u.id,
        name: "Healed Portfolio",
        baseCurrency: "IDR",
        cashCounted: false,
      })
      .returning();
    healedPortfolioId = healed.id;

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

    const healedInception = "2026-01-10";
    await db.insert(transactions).values([
      {
        portfolioId: healedPortfolioId,
        instrumentId: bbca.id,
        type: "buy",
        quantity: "10",
        price: "9000",
        currency: "IDR",
        executedAt: new Date(`${healedInception}T10:00:00.000Z`),
      },
    ]);

    // Pre-seed a snapshot at inception so this portfolio looks fully healed.
    await db.insert(portfolioSnapshots).values({
      portfolioId: healedPortfolioId,
      date: healedInception,
      netWorth: "90000",
      marketValue: "90000",
      effectiveFlow: "0",
      currency: "IDR",
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  it("detects the stale portfolio and writes snapshots from inception", async () => {
    const db = getDb();
    const result = await backfillStalePortfolios(db, svc, 10_000);

    // At least the stale portfolio must have been healed.
    expect(result.healed).toBeGreaterThanOrEqual(1);

    // The stale portfolio should appear in the healed list.
    const healedEntry = result.portfolios.find((p) => p.portfolioId === stalePortfolioId);
    expect(healedEntry).toBeDefined();
    expect(healedEntry!.result.days).toBeGreaterThan(0);

    // Snapshots must now exist for the stale portfolio, starting no later than inception.
    const snaps = await db
      .select()
      .from(portfolioSnapshots)
      .where(eq(portfolioSnapshots.portfolioId, stalePortfolioId));
    expect(snaps.length).toBeGreaterThan(0);

    const dates = snaps.map((s) => s.date).sort();
    // Earliest snapshot must be on or before the inception date (ISO string comparison is valid).
    expect(dates[0]! <= INCEPTION_DATE).toBe(true);
  });

  it("skips the already-healed portfolio (idempotency check before second run)", async () => {
    const db = getDb();
    const result = await backfillStalePortfolios(db, svc, 10_000);

    const healedEntry = result.portfolios.find((p) => p.portfolioId === healedPortfolioId);
    // The pre-seeded portfolio should NOT appear in the healed list.
    expect(healedEntry).toBeUndefined();
  });

  it("returns healed: 0 when all portfolios are already healed (sweep is idempotent)", async () => {
    const db = getDb();
    // Run a third time — both portfolios now have full history, nothing to do.
    const result = await backfillStalePortfolios(db, svc, 10_000);

    expect(result.scanned).toBeGreaterThanOrEqual(2);
    expect(result.healed).toBe(0);
    expect(result.portfolios).toHaveLength(0);
  });
});
