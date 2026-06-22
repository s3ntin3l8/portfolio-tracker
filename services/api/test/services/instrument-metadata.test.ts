import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { instruments, transactions, users, portfolios } from "@portfolio/db";
import { ensureDb, getDb, closeDb } from "../../src/db/client.js";
import {
  refreshInstrumentMetadata,
  needsSectorEnrichment,
  SKIP_ASSET_CLASSES,
} from "../../src/services/instrument-metadata.js";
import type { MarketDataService, InstrumentProfile } from "@portfolio/market-data";

// ---------------------------------------------------------------------------
// needsSectorEnrichment (pure predicate — no DB needed)
// ---------------------------------------------------------------------------

describe("needsSectorEnrichment", () => {
  const stale = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); // 40 days ago
  const fresh = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago

  it("returns true when any instrument has never been attempted (sectorCheckedAt = null)", () => {
    expect(needsSectorEnrichment([{ assetClass: "equity", sectorCheckedAt: null }])).toBe(true);
  });

  it("returns true when any instrument has a stale attempt (> 30 days)", () => {
    expect(needsSectorEnrichment([{ assetClass: "equity", sectorCheckedAt: stale }])).toBe(true);
  });

  it("returns false when all instruments have a recent attempt", () => {
    expect(needsSectorEnrichment([{ assetClass: "equity", sectorCheckedAt: fresh }])).toBe(false);
  });

  it("skips SKIP_ASSET_CLASSES even when sectorCheckedAt is null", () => {
    for (const cls of SKIP_ASSET_CLASSES) {
      expect(needsSectorEnrichment([{ assetClass: cls, sectorCheckedAt: null }])).toBe(false);
    }
  });

  it("returns false for empty array", () => {
    expect(needsSectorEnrichment([])).toBe(false);
  });

  it("returns true when mix of fresh + null", () => {
    expect(
      needsSectorEnrichment([
        { assetClass: "equity", sectorCheckedAt: fresh },
        { assetClass: "etf", sectorCheckedAt: null },
      ]),
    ).toBe(true);
  });

  it("accepts ISO string dates (from JSON serialized meta)", () => {
    expect(
      needsSectorEnrichment([{ assetClass: "equity", sectorCheckedAt: stale.toISOString() }]),
    ).toBe(true);
    expect(
      needsSectorEnrichment([{ assetClass: "equity", sectorCheckedAt: fresh.toISOString() }]),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// refreshInstrumentMetadata — integration tests (PGlite)
// ---------------------------------------------------------------------------

describe("refreshInstrumentMetadata", () => {
  let portfolioId: string;

  beforeAll(async () => {
    await ensureDb();
    const db = getDb();
    // Create a user + portfolio so FK constraints are satisfied.
    const [user] = await db
      .insert(users)
      .values({ authSub: "test|instrument-metadata", email: "meta-test@example.com" })
      .returning();
    const [pf] = await db
      .insert(portfolios)
      .values({ userId: user.id, name: "Meta Test Portfolio", baseCurrency: "USD" })
      .returning();
    portfolioId = pf.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  /** Minimal stub service: returns the given profile (or null). */
  function makeService(profile: InstrumentProfile | null): MarketDataService {
    return { getProfile: async () => profile } as unknown as MarketDataService;
  }

  /** Insert an instrument + a transaction so it appears as "held". */
  async function createHeld(opts: {
    symbol: string;
    assetClass: "equity" | "etf" | "gold";
    market?: string;
    sectorCheckedAt?: Date | null;
  }): Promise<string> {
    const db = getDb();
    const market = opts.market ?? (opts.assetClass === "gold" ? "XAU" : "US");
    const unit = opts.assetClass === "gold" ? "grams" : "shares";
    const currency = opts.assetClass === "gold" ? "IDR" : "USD";

    const [inst] = await db
      .insert(instruments)
      .values({
        symbol: opts.symbol,
        market,
        assetClass: opts.assetClass,
        unit,
        currency,
        name: opts.symbol,
        sectorCheckedAt: opts.sectorCheckedAt ?? null,
      })
      .returning();

    await db.insert(transactions).values({
      portfolioId,
      instrumentId: inst.id,
      type: "buy",
      quantity: "1",
      price: "100",
      fees: "0",
      currency,
      executedAt: new Date("2026-01-01"),
    });

    return inst.id;
  }

  it("writes sector + stamps sectorCheckedAt for an equity with a profile", async () => {
    const db = getDb();
    const id = await createHeld({ symbol: "MSFT_META_TEST", assetClass: "equity" });

    const enriched = await refreshInstrumentMetadata(
      db,
      makeService({ sector: "Technology", industry: "Software" }),
    );

    expect(enriched).toBeGreaterThanOrEqual(1);

    const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
    expect(row.sector).toBe("Technology");
    expect(row.sectorCheckedAt).not.toBeNull();
  });

  it("stamps sectorCheckedAt even when provider returns null (no churn)", async () => {
    const db = getDb();
    const id = await createHeld({ symbol: "NULL_PROFILE_TEST", assetClass: "equity" });

    await refreshInstrumentMetadata(db, makeService(null));

    const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
    // Timestamp must be stamped so we don't re-query indefinitely.
    expect(row.sectorCheckedAt).not.toBeNull();
    // Sector remains null — provider had nothing.
    expect(row.sector).toBeNull();
  });

  it("writes sectorWeights for an ETF with weight profile", async () => {
    const db = getDb();
    const id = await createHeld({ symbol: "SP500_ETF_TEST", assetClass: "etf" });

    const weights = { Technology: 0.29, Financials: 0.13, "Health Care": 0.12 };
    const enriched = await refreshInstrumentMetadata(
      db,
      makeService({ sectorWeights: weights }),
    );

    expect(enriched).toBeGreaterThanOrEqual(1);

    const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
    expect(row.sectorWeights).toEqual(weights);
    expect(row.sectorCheckedAt).not.toBeNull();
    // ETF single-sector field should remain null (ETFs use sectorWeights instead).
    expect(row.sector).toBeNull();
  });

  it("skips instruments with a fresh sectorCheckedAt (no churn)", async () => {
    const db = getDb();
    const id = await createHeld({
      symbol: "FRESH_TEST",
      assetClass: "equity",
      sectorCheckedAt: new Date(), // just checked
    });

    let callCount = 0;
    const svc = {
      getProfile: async () => {
        callCount++;
        return { sector: "Energy" };
      },
    } as unknown as MarketDataService;

    await refreshInstrumentMetadata(db, svc);

    // A freshly-checked instrument must not trigger a getProfile call.
    expect(callCount).toBe(0);

    const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
    expect(row.sector).toBeNull();
  });

  it("skips SKIP_ASSET_CLASSES (gold)", async () => {
    const db = getDb();
    await createHeld({ symbol: "GOLD_SKIP_TEST", assetClass: "gold" });

    let callCount = 0;
    const svc = {
      getProfile: async () => {
        callCount++;
        return { sector: "Gold" };
      },
    } as unknown as MarketDataService;

    await refreshInstrumentMetadata(db, svc);

    // Gold must never be passed to getProfile.
    expect(callCount).toBe(0);
  });

  // ── force option ──────────────────────────────────────────────────────────

  it("force=true re-enriches an instrument with a fresh sectorCheckedAt", async () => {
    const db = getDb();
    const id = await createHeld({
      symbol: "FORCE_FRESH_TEST",
      assetClass: "equity",
      sectorCheckedAt: new Date(), // just checked — would normally be skipped
    });

    let callCount = 0;
    const svc = {
      getProfile: async () => {
        callCount++;
        return { sector: "Industrials" };
      },
    } as unknown as MarketDataService;

    const enriched = await refreshInstrumentMetadata(db, svc, { force: true });

    // force=true must bypass the sectorCheckedAt gate.
    expect(callCount).toBeGreaterThanOrEqual(1);
    expect(enriched).toBeGreaterThanOrEqual(1);

    const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
    expect(row.sector).toBe("Industrials");
  });

  it("force=true still skips SKIP_ASSET_CLASSES (gold)", async () => {
    const db = getDb();
    await createHeld({
      symbol: "FORCE_GOLD_TEST",
      assetClass: "gold",
      sectorCheckedAt: new Date(),
    });

    // Track which symbols were passed to getProfile.
    // With force=true, all non-gold/non-skipped held instruments from previous
    // tests in this shared PGlite DB will also be enriched — so we can't assert
    // callCount === 0. Instead assert that the gold instrument was never passed.
    const calledSymbols: string[] = [];
    const svc = {
      getProfile: async (ref: { symbol: string }) => {
        calledSymbols.push(ref.symbol);
        return null;
      },
    } as unknown as MarketDataService;

    await refreshInstrumentMetadata(db, svc, { force: true });

    // Gold must never be passed to getProfile regardless of force.
    expect(calledSymbols).not.toContain("FORCE_GOLD_TEST");
  });
});
