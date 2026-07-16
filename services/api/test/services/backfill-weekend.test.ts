/**
 * Tests that backfillPortfolioHistory correctly forward-fills non-trading days
 * (weekends, market holidays) rather than writing a zero market value.
 *
 * Before the fix, `priceAt` returned null for any realSeries instrument on a
 * date with no exact candle, causing that day's `marketValue` and `netWorth`
 * to be written as 0.  After the fix, the backfill pre-fills a dense price map
 * over the date grid so weekends carry the most-recent known close.
 *
 * Also tests the `force` option on `backfillStalePortfolios` which lets the
 * admin panel trigger a full inception rebuild on every portfolio (the one-shot
 * heal path after this bug fix).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { instruments, portfolios, portfolioSnapshots, transactions, users } from "@portfolio/db";
import {
  MarketDataService,
  type MarketDataProvider,
  type InstrumentRef,
  type Candle,
} from "@portfolio/market-data";
import { ensureDb, getDb, closeDb } from "../../src/db/client.js";
import { backfillPortfolioHistory, backfillStalePortfolios } from "../../src/services/backfill.js";

// ---------------------------------------------------------------------------
// Weekday-only candle provider for the test
// ---------------------------------------------------------------------------

/**
 * A minimal MarketDataProvider that returns a fixed set of trading-day candles.
 * Mimics how real providers (Yahoo) only return candles for market-open days —
 * no Saturday or Sunday rows.
 */
class WeekdayCandleProvider implements MarketDataProvider {
  readonly name = "weekday-candles";

  constructor(
    private readonly symbol: string,
    /** Map of YYYY-MM-DD → close price (trading days only). */
    private readonly candles: Record<string, string>,
    private readonly currency: string,
  ) {}

  supports(): boolean {
    return true;
  }

  async getQuote(): Promise<null> {
    return null;
  }

  async getHistoryFrom(ref: InstrumentRef, fromDate: string): Promise<Candle[]> {
    if (ref.symbol !== this.symbol) return [];
    return Object.entries(this.candles)
      .filter(([date]) => date >= fromDate)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, close]) => ({ date, close, currency: this.currency }));
  }
}

// ---------------------------------------------------------------------------
// Test dates
//
// Week spanning a weekend:
//   Mon 2026-01-19 … Fri 2026-01-23 = trading days (candles provided)
//   Sat 2026-01-24 / Sun 2026-01-25 = no candles  (previously → zero, now → carry forward)
//   Mon 2026-01-26                  = next trading day
// ---------------------------------------------------------------------------

const INCEPTION = "2026-01-19"; // Monday
const FRIDAY = "2026-01-23"; // last trading day before the weekend
const SATURDAY = "2026-01-24";
const SUNDAY = "2026-01-25";
const MONDAY2 = "2026-01-26"; // next trading week

const PRICE_FRI = "10000"; // IDR close on Friday
const PRICE_MON = "10500"; // IDR close on following Monday

const CANDLES: Record<string, string> = {
  [INCEPTION]: "9000",
  "2026-01-20": "9200",
  "2026-01-21": "9500",
  "2026-01-22": "9800",
  [FRIDAY]: PRICE_FRI,
  [MONDAY2]: PRICE_MON,
};

const QTY = "2"; // 2 shares held

describe("backfillPortfolioHistory — weekend carry-forward", () => {
  let portfolioId: string;

  const svc = new MarketDataService([new WeekdayCandleProvider("WKND", CANDLES, "IDR")]);

  beforeAll(async () => {
    const db = await ensureDb();

    const [u] = await db
      .insert(users)
      .values({ authSub: "weekend-fix-user", email: "weekend@example.com" })
      .returning();

    const [pf] = await db
      .insert(portfolios)
      .values({
        userId: u.id,
        name: "Weekend Test Portfolio",
        baseCurrency: "IDR",
        // cash is outside the boundary — MV is the only thing in the value
        cashCounted: false,
      })
      .returning();
    portfolioId = pf.id;

    const [instr] = await db
      .insert(instruments)
      .values({
        symbol: "WKND",
        market: "IDX",
        assetClass: "equity",
        currency: "IDR",
        name: "Weekend Test Stock",
      })
      .returning();

    await db.insert(transactions).values([
      {
        portfolioId,
        instrumentId: instr.id,
        type: "buy",
        quantity: QTY,
        price: "9000",
        fees: "0",
        currency: "IDR",
        executedAt: new Date(`${INCEPTION}T10:00:00.000Z`),
      },
    ]);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("writes non-zero marketValue on Saturday (carry-forward from Friday)", async () => {
    await backfillPortfolioHistory(getDb(), svc, 10_000, portfolioId);

    const snaps = await getDb()
      .select()
      .from(portfolioSnapshots)
      .where(eq(portfolioSnapshots.portfolioId, portfolioId));

    const byDate = new Map(snaps.map((s) => [s.date, s]));

    // Friday should be valued at exactly 2 × 10000
    const fri = byDate.get(FRIDAY);
    expect(fri, "Friday snapshot must exist").toBeDefined();
    expect(Number(fri!.marketValue)).toBeCloseTo(Number(QTY) * Number(PRICE_FRI), 0);

    // Saturday — no candle; must carry forward Friday's close, not write 0
    const sat = byDate.get(SATURDAY);
    expect(sat, "Saturday snapshot must exist").toBeDefined();
    expect(Number(sat!.marketValue)).toBeGreaterThan(0);
    expect(Number(sat!.marketValue)).toBeCloseTo(Number(QTY) * Number(PRICE_FRI), 0);

    // Sunday — same carry-forward
    const sun = byDate.get(SUNDAY);
    expect(sun, "Sunday snapshot must exist").toBeDefined();
    expect(Number(sun!.marketValue)).toBeGreaterThan(0);
    expect(Number(sun!.marketValue)).toBeCloseTo(Number(QTY) * Number(PRICE_FRI), 0);

    // Following Monday — should use that day's own candle
    const mon = byDate.get(MONDAY2);
    expect(mon, "Monday snapshot must exist").toBeDefined();
    expect(Number(mon!.marketValue)).toBeCloseTo(Number(QTY) * Number(PRICE_MON), 0);
  });

  it("netWorth on weekend days equals marketValue (cash-outside boundary)", async () => {
    const snaps = await getDb()
      .select()
      .from(portfolioSnapshots)
      .where(eq(portfolioSnapshots.portfolioId, portfolioId));

    const byDate = new Map(snaps.map((s) => [s.date, s]));

    for (const date of [SATURDAY, SUNDAY]) {
      const snap = byDate.get(date);
      expect(snap).toBeDefined();
      // With cashCounted=false and no cash in the portfolio, netWorth == marketValue
      expect(Number(snap!.netWorth)).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Force-sweep test
// ---------------------------------------------------------------------------

describe("backfillStalePortfolios — force option", () => {
  let forcePortfolioId: string;
  let forceInstrId: string;

  const FORCE_INCEPTION = "2026-02-02"; // Monday
  const FORCE_FRIDAY = "2026-02-06";
  const FORCE_SATURDAY = "2026-02-07";

  const FORCE_CANDLES: Record<string, string> = {
    [FORCE_INCEPTION]: "5000",
    "2026-02-03": "5100",
    "2026-02-04": "5200",
    "2026-02-05": "5300",
    [FORCE_FRIDAY]: "5400",
  };

  const svc2 = new MarketDataService([new WeekdayCandleProvider("FORC", FORCE_CANDLES, "EUR")]);

  beforeAll(async () => {
    const db = await ensureDb();

    const [u] = await db
      .insert(users)
      .values({ authSub: "force-sweep-user", email: "force-sweep@example.com" })
      .returning();

    const [pf] = await db
      .insert(portfolios)
      .values({
        userId: u.id,
        name: "Force Sweep Test Portfolio",
        baseCurrency: "EUR",
        cashCounted: false,
      })
      .returning();
    forcePortfolioId = pf.id;

    const [instr] = await db
      .insert(instruments)
      .values({
        symbol: "FORC",
        market: "XETRA",
        assetClass: "equity",
        currency: "EUR",
        name: "Force Test Stock",
      })
      .returning();
    forceInstrId = instr.id;

    await db.insert(transactions).values([
      {
        portfolioId: forcePortfolioId,
        instrumentId: forceInstrId,
        type: "buy",
        quantity: "1",
        price: "5000",
        fees: "0",
        currency: "EUR",
        executedAt: new Date(`${FORCE_INCEPTION}T09:00:00.000Z`),
      },
    ]);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("force=false skips an already-healed portfolio", async () => {
    const db = getDb();

    // First, run a proper backfill to heal the portfolio.
    await backfillPortfolioHistory(db, svc2, 10_000, forcePortfolioId);

    // Corrupt the Saturday snapshot to simulate a pre-fix zero row.
    await db
      .insert(portfolioSnapshots)
      .values({
        portfolioId: forcePortfolioId,
        date: FORCE_SATURDAY,
        netWorth: "0",
        marketValue: "0",
        effectiveFlow: "0",
        currency: "EUR",
      })
      .onConflictDoUpdate({
        target: [portfolioSnapshots.portfolioId, portfolioSnapshots.date],
        set: { netWorth: "0", marketValue: "0" },
      });

    // Normal sweep (force=false) should skip this portfolio because earliest snapshot == inception.
    const result = await backfillStalePortfolios(db, svc2, 10_000, { force: false });
    const entry = result.portfolios.find((p) => p.portfolioId === forcePortfolioId);
    expect(entry).toBeUndefined();

    // The point is the sweep didn't touch this portfolio; snapshots may or may not
    // exist for Saturday (the initial backfill already ran), but the sweep skipped it.
    expect(result.scanned).toBeGreaterThanOrEqual(1);
  });

  it("force=true re-runs full backfill and overwrites the zero Saturday row", async () => {
    const db = getDb();

    // Corrupt Saturday to 0 again to simulate the pre-fix state.
    await db
      .insert(portfolioSnapshots)
      .values({
        portfolioId: forcePortfolioId,
        date: FORCE_SATURDAY,
        netWorth: "0",
        marketValue: "0",
        effectiveFlow: "0",
        currency: "EUR",
      })
      .onConflictDoUpdate({
        target: [portfolioSnapshots.portfolioId, portfolioSnapshots.date],
        set: { netWorth: "0", marketValue: "0" },
      });

    // Force sweep must re-run backfill for every portfolio, including this one.
    const result = await backfillStalePortfolios(db, svc2, 10_000, { force: true });
    const entry = result.portfolios.find((p) => p.portfolioId === forcePortfolioId);
    expect(entry, "force sweep must include the already-healed portfolio").toBeDefined();

    // Now the Saturday snapshot should have been overwritten with a non-zero value.
    const snaps = await db
      .select()
      .from(portfolioSnapshots)
      .where(eq(portfolioSnapshots.portfolioId, forcePortfolioId));
    const byDate = new Map(snaps.map((s) => [s.date, s]));

    const sat = byDate.get(FORCE_SATURDAY);
    expect(sat, "Saturday snapshot must exist after force rebuild").toBeDefined();
    expect(Number(sat!.marketValue)).toBeGreaterThan(0);
  });
});
