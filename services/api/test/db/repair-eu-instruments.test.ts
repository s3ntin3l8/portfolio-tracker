import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { instruments, lastPrices } from "@portfolio/db";
import { MarketDataService } from "@portfolio/market-data";
import type { InstrumentSearchResult } from "@portfolio/market-data";
import { ensureDb, getDb, closeDb } from "../../src/db/client.js";
import {
  getMarketData,
  overrideMarketData,
  invalidateMarketData,
} from "../../src/services/market-data.js";
import { repairEuInstruments } from "../../src/db/repair-eu-instruments.js";

/**
 * Tests for the repair-eu-instruments CLI. Covers both passes:
 * - Pass 1: mutual_fund reclassification (foreign UCITS ETFs mislabeled as mutual_fund)
 * - Pass 2: US cross-listing collision fix (non-US ISINs mis-pinned to market=US)
 */

function buildMockService(searchResults: Record<string, InstrumentSearchResult[]>) {
  return new MarketDataService([
    {
      name: "mock",
      supports: () => false,
      getQuote: async () => null,
      search: async (q: string) => searchResults[q.toUpperCase()] ?? [],
      resolveISIN: async (isin: string) => {
        const hits = searchResults[isin.toUpperCase()] ?? [];
        if (hits.length === 0) return null;
        const h = hits[0];
        return { symbol: h.symbol, exchange: h.market, name: h.name, type: h.assetClass };
      },
    },
  ]);
}

describe("repairEuInstruments", () => {
  beforeAll(async () => {
    await ensureDb();
  });

  afterAll(async () => {
    invalidateMarketData();
    await closeDb();
  });

  beforeEach(async () => {
    invalidateMarketData();
    const db = getDb();
    await db.delete(lastPrices);
    await db.delete(instruments);
  });

  async function repair() {
    return repairEuInstruments(getDb(), await getMarketData());
  }

  // ── Pass 1: mutual_fund reclassification ──────────────────────────────────

  it("Pass 1: reclassifies a foreign mutual_fund to etf and updates market/currency", async () => {
    const db = getDb();
    const [inst] = await db
      .insert(instruments)
      .values({
        symbol: "IE00B5BMR087",
        market: "XETRA",
        assetClass: "mutual_fund",
        currency: "EUR",
        name: "iShares Core S&P 500",
        isin: "IE00B5BMR087",
      })
      .returning();

    overrideMarketData(
      buildMockService({
        IE00B5BMR087: [
          {
            symbol: "SXR8",
            name: "iShares Core S&P 500",
            market: "XETRA",
            assetClass: "etf",
            currency: "EUR",
            source: "mock",
          },
        ],
      }),
    );

    const result = await repair();

    expect(result.pass1Fixed).toBe(1);
    const updated = await db.select().from(instruments).where(eq(instruments.id, inst.id));
    expect(updated[0]).toMatchObject({
      symbol: "SXR8",
      assetClass: "etf",
      market: "XETRA",
      currency: "EUR",
    });
  });

  it("Pass 1: skips Indonesian reksa dana (ISIN starting with ID)", async () => {
    const db = getDb();
    const [inst] = await db
      .insert(instruments)
      .values({
        symbol: "SCHRODER-DANA",
        market: "IDX",
        assetClass: "mutual_fund",
        currency: "IDR",
        name: "Schroder Dana Prestasi",
        isin: "ID1000000001",
      })
      .returning();

    overrideMarketData(buildMockService({}));

    const result = await repair();

    expect(result.pass1Fixed).toBe(0);
    const unchanged = await db.select().from(instruments).where(eq(instruments.id, inst.id));
    expect(unchanged[0]).toMatchObject({
      symbol: "SCHRODER-DANA",
      assetClass: "mutual_fund",
      market: "IDX",
      currency: "IDR",
    });
  });

  it("Pass 1: skips an instrument when the provider returns no resolution", async () => {
    const db = getDb();
    const [inst] = await db
      .insert(instruments)
      .values({
        symbol: "IE00B5BMR087",
        market: "XETRA",
        assetClass: "mutual_fund",
        currency: "EUR",
        name: "iShares Core S&P 500",
        isin: "IE00B5BMR087",
      })
      .returning();

    overrideMarketData(buildMockService({}));

    const result = await repair();

    expect(result.pass1Fixed).toBe(0);
    const unchanged = await db.select().from(instruments).where(eq(instruments.id, inst.id));
    expect(unchanged[0].assetClass).toBe("mutual_fund");
  });

  it("Pass 1: skips an instrument that is already correct (idempotency)", async () => {
    const db = getDb();
    const [inst] = await db
      .insert(instruments)
      .values({
        symbol: "SXR8",
        market: "XETRA",
        assetClass: "etf",
        currency: "EUR",
        name: "iShares Core S&P 500",
        isin: "IE00B5BMR087",
      })
      .returning();

    overrideMarketData(
      buildMockService({
        IE00B5BMR087: [
          {
            symbol: "SXR8",
            name: "iShares Core S&P 500",
            market: "XETRA",
            assetClass: "etf",
            currency: "EUR",
            source: "mock",
          },
        ],
      }),
    );

    const result = await repair();

    expect(result.pass1Fixed).toBe(0);
    const unchanged = await db.select().from(instruments).where(eq(instruments.id, inst.id));
    expect(unchanged[0].symbol).toBe("SXR8");
  });

  it("Pass 1: normalises an unpriceable venue (e.g. PARIS) to XETRA/EUR", async () => {
    const db = getDb();
    const [inst] = await db
      .insert(instruments)
      .values({
        symbol: "IE00B5BMR087",
        market: "PARIS",
        assetClass: "mutual_fund",
        currency: "EUR",
        name: "iShares Core S&P 500",
        isin: "IE00B5BMR087",
      })
      .returning();

    overrideMarketData(
      buildMockService({
        IE00B5BMR087: [
          {
            symbol: "SXR8",
            name: "iShares Core S&P 500",
            market: "XETRA",
            assetClass: "etf",
            currency: "EUR",
            source: "mock",
          },
        ],
      }),
    );

    const result = await repair();

    expect(result.pass1Fixed).toBe(1);
    const updated = await db.select().from(instruments).where(eq(instruments.id, inst.id));
    expect(updated[0]).toMatchObject({
      market: "XETRA",
      currency: "EUR",
    });
  });

  it("Pass 1: clears cached last_prices for the repaired instrument", async () => {
    const db = getDb();
    const [inst] = await db
      .insert(instruments)
      .values({
        symbol: "IE00B5BMR087",
        market: "XETRA",
        assetClass: "mutual_fund",
        currency: "EUR",
        name: "iShares Core S&P 500",
        isin: "IE00B5BMR087",
      })
      .returning();
    await db.insert(lastPrices).values({
      instrumentId: inst.id,
      price: "59",
      currency: "USD",
      asOf: new Date("2026-06-23T00:00:00.000Z"),
    });

    overrideMarketData(
      buildMockService({
        IE00B5BMR087: [
          {
            symbol: "SXR8",
            name: "iShares Core S&P 500",
            market: "XETRA",
            assetClass: "etf",
            currency: "EUR",
            source: "mock",
          },
        ],
      }),
    );

    await repair();

    const cached = await db.select().from(lastPrices).where(eq(lastPrices.instrumentId, inst.id));
    expect(cached).toHaveLength(0);
  });

  // ── Pass 2: US cross-listing collision fix ────────────────────────────────

  it("Pass 2: re-pins a non-US ISIN from market=US to XETRA/EUR", async () => {
    const db = getDb();
    const [inst] = await db
      .insert(instruments)
      .values({
        symbol: "CSSPX",
        market: "US",
        assetClass: "etf",
        currency: "USD",
        name: "iShares Core S&P 500",
        isin: "IE00B5BMR087",
      })
      .returning();

    overrideMarketData(
      buildMockService({
        IE00B5BMR087: [
          {
            symbol: "SXR8",
            name: "iShares Core S&P 500",
            market: "XETRA",
            assetClass: "etf",
            currency: "EUR",
            source: "mock",
          },
        ],
      }),
    );

    const result = await repair();

    expect(result.pass2Fixed).toBe(1);
    const updated = await db.select().from(instruments).where(eq(instruments.id, inst.id));
    expect(updated[0]).toMatchObject({
      symbol: "SXR8",
      market: "XETRA",
      currency: "EUR",
      assetClass: "etf",
    });
  });

  it("Pass 2: falls back to XETRA/EUR when the resolver still returns US", async () => {
    const db = getDb();
    const [inst] = await db
      .insert(instruments)
      .values({
        symbol: "CSSPX",
        market: "US",
        assetClass: "etf",
        currency: "USD",
        name: "iShares Core S&P 500",
        isin: "IE00B5BMR087",
      })
      .returning();

    overrideMarketData(
      buildMockService({
        IE00B5BMR087: [
          {
            symbol: "CSSPX",
            name: "WRONG US fund",
            market: "US",
            assetClass: "etf",
            currency: "USD",
            source: "mock",
          },
        ],
      }),
    );

    const result = await repair();

    expect(result.pass2Fixed).toBe(1);
    const updated = await db.select().from(instruments).where(eq(instruments.id, inst.id));
    expect(updated[0]).toMatchObject({
      market: "XETRA",
      currency: "EUR",
    });
  });

  it("Pass 2: falls back to XETRA/EUR when resolution returns null", async () => {
    const db = getDb();
    const [inst] = await db
      .insert(instruments)
      .values({
        symbol: "CSSPX",
        market: "US",
        assetClass: "etf",
        currency: "USD",
        name: "iShares Core S&P 500",
        isin: "IE00B5BMR087",
      })
      .returning();

    overrideMarketData(buildMockService({}));

    const result = await repair();

    expect(result.pass2Fixed).toBe(1);
    const updated = await db.select().from(instruments).where(eq(instruments.id, inst.id));
    expect(updated[0]).toMatchObject({
      market: "XETRA",
      currency: "EUR",
    });
  });

  it("Pass 2: keeps the original symbol when the resolved symbol is another ISIN", async () => {
    const db = getDb();
    const [inst] = await db
      .insert(instruments)
      .values({
        symbol: "CSSPX",
        market: "US",
        assetClass: "etf",
        currency: "USD",
        name: "iShares Core S&P 500",
        isin: "IE00B5BMR087",
      })
      .returning();

    overrideMarketData(
      buildMockService({
        IE00B5BMR087: [
          {
            symbol: "IE00BK5BQT80",
            name: "Vanguard FTSE All-World",
            market: "XETRA",
            assetClass: "etf",
            currency: "EUR",
            source: "mock",
          },
        ],
      }),
    );

    const result = await repair();

    expect(result.pass2Fixed).toBe(1);
    const updated = await db.select().from(instruments).where(eq(instruments.id, inst.id));
    expect(updated[0]).toMatchObject({
      symbol: "CSSPX",
      market: "XETRA",
      currency: "EUR",
    });
  });

  it("Pass 2: skips an instrument that is already correct (idempotency)", async () => {
    const db = getDb();
    const [inst] = await db
      .insert(instruments)
      .values({
        symbol: "SXR8",
        market: "XETRA",
        assetClass: "etf",
        currency: "EUR",
        name: "iShares Core S&P 500",
        isin: "IE00B5BMR087",
      })
      .returning();

    overrideMarketData(
      buildMockService({
        IE00B5BMR087: [
          {
            symbol: "SXR8",
            name: "iShares Core S&P 500",
            market: "XETRA",
            assetClass: "etf",
            currency: "EUR",
            source: "mock",
          },
        ],
      }),
    );

    const result = await repair();

    expect(result.pass2Fixed).toBe(0);
    const unchanged = await db.select().from(instruments).where(eq(instruments.id, inst.id));
    expect(unchanged[0].market).toBe("XETRA");
  });

  it("Pass 2: ignores instruments without an ISIN", async () => {
    const db = getDb();
    await db.insert(instruments).values({
      symbol: "AAPL",
      market: "US",
      assetClass: "equity",
      currency: "USD",
      name: "Apple Inc",
    });

    overrideMarketData(buildMockService({}));

    const result = await repair();

    expect(result.pass2Fixed).toBe(0);
  });

  it("Pass 2: ignores US-domiciled ISINs (e.g. US0378331005 = AAPL)", async () => {
    const db = getDb();
    const [inst] = await db
      .insert(instruments)
      .values({
        symbol: "AAPL",
        market: "US",
        assetClass: "equity",
        currency: "USD",
        name: "Apple Inc",
        isin: "US0378331005",
      })
      .returning();

    overrideMarketData(buildMockService({}));

    const result = await repair();

    expect(result.pass2Fixed).toBe(0);
    const unchanged = await db.select().from(instruments).where(eq(instruments.id, inst.id));
    expect(unchanged[0].market).toBe("US");
  });
});
