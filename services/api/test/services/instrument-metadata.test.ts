import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { instruments, transactions, users, portfolios } from "@portfolio/db";
import { ensureDb, getDb, closeDb } from "../../src/db/client.js";
import {
  refreshInstrumentMetadata,
  needsSectorEnrichment,
  needsNameEnrichment,
  SKIP_ASSET_CLASSES,
} from "../../src/services/instrument-metadata.js";
import type {
  MarketDataService,
  InstrumentProfile,
  InstrumentSearchResult,
} from "@portfolio/market-data";

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
    const enriched = await refreshInstrumentMetadata(db, makeService({ sectorWeights: weights }));

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

  // ── Country enrichment ─────────────────────────────────────────────────────

  it("writes countryWeights for an ETF with ISIN and profile", async () => {
    const db = getDb();
    const id = await createHeld({ symbol: "VWCE_COUNTRY_TEST", assetClass: "etf" });

    // Set ISIN on the instrument so country enrichment runs
    await db.update(instruments).set({ isin: "IE00BKM4GZ66" }).where(eq(instruments.id, id));

    const countryWeights = { "United States": 0.57, Germany: 0.05, Japan: 0.06 };
    const enriched = await refreshInstrumentMetadata(db, makeService({ countryWeights }));

    expect(enriched).toBeGreaterThanOrEqual(1);

    const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
    expect(row.countryWeights).toEqual(countryWeights);
    expect(row.countryCheckedAt).not.toBeNull();
  });

  it("stamps countryCheckedAt when provider returns null for country", async () => {
    const db = getDb();
    const id = await createHeld({ symbol: "NULL_COUNTRY_TEST", assetClass: "etf" });
    await db.update(instruments).set({ isin: "IE0000000001" }).where(eq(instruments.id, id));

    await refreshInstrumentMetadata(db, makeService(null));

    const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
    expect(row.countryCheckedAt).not.toBeNull();
    expect(row.countryWeights).toBeNull();
  });

  it("skips country enrichment for ETF without ISIN", async () => {
    const db = getDb();
    // createHeld does NOT set isin
    const id = await createHeld({ symbol: "NO_ISIN_COUNTRY_TEST", assetClass: "etf" });

    const calledSymbols: string[] = [];
    const svc = {
      getProfile: async (ref: { symbol: string }) => {
        calledSymbols.push(ref.symbol);
        return { countryWeights: { "United States": 1 } };
      },
    } as unknown as MarketDataService;

    await refreshInstrumentMetadata(db, svc);

    // getProfile may be called for sector enrichment, but countryCheckedAt should not be stamped
    const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
    expect(row.countryCheckedAt).toBeNull();
  });

  it("force=true triggers country enrichment for ETF with ISIN", async () => {
    const db = getDb();
    const id = await createHeld({
      symbol: "FORCE_COUNTRY_TEST",
      assetClass: "etf",
      sectorCheckedAt: new Date(),
    });
    await db
      .update(instruments)
      .set({
        isin: "IE0000000002",
        countryCheckedAt: new Date(),
      })
      .where(eq(instruments.id, id));

    let calledWithIsin = false;
    const svc = {
      getProfile: async (ref: { isin?: string }) => {
        if (ref.isin) calledWithIsin = true;
        return { countryWeights: { Canada: 1 } };
      },
    } as unknown as MarketDataService;

    await refreshInstrumentMetadata(db, svc, { force: true });

    expect(calledWithIsin).toBe(true);
    const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
    expect(row.countryWeights).toEqual({ Canada: 1 });
  });

  it("does not stamp countryCheckedAt on provider error (allows retry)", async () => {
    const db = getDb();
    const id = await createHeld({ symbol: "ERR_COUNTRY_TEST", assetClass: "etf" });
    await db.update(instruments).set({ isin: "IE0000000003" }).where(eq(instruments.id, id));

    const svc = {
      getProfile: async () => {
        throw new Error("network timeout");
      },
    } as unknown as MarketDataService;

    await refreshInstrumentMetadata(db, svc);

    const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
    // Error path must NOT stamp countryCheckedAt so next run retries
    expect(row.countryCheckedAt).toBeNull();
  });

  it("skips country enrichment for already-fresh countryCheckedAt", async () => {
    const db = getDb();
    const id = await createHeld({ symbol: "FRESH_COUNTRY_TEST", assetClass: "equity" });
    await db
      .update(instruments)
      .set({
        isin: "IE0000000004",
        countryCheckedAt: new Date(),
        sectorCheckedAt: new Date(),
      })
      .where(eq(instruments.id, id));

    const calledSymbols: string[] = [];
    const svc = {
      getProfile: async (ref: { symbol: string }) => {
        calledSymbols.push(ref.symbol);
        return { countryWeights: { "United States": 1 } };
      },
    } as unknown as MarketDataService;

    await refreshInstrumentMetadata(db, svc);

    // FRESH_COUNTRY_TEST should NOT be passed to getProfile (both sector and country fresh)
    expect(calledSymbols).not.toContain("FRESH_COUNTRY_TEST");

    const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
    expect(row.countryWeights).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// needsNameEnrichment (pure predicate)
// ---------------------------------------------------------------------------

describe("needsNameEnrichment", () => {
  const stale = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  const fresh = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

  it("is true for an unnamed instrument never attempted", () => {
    expect(needsNameEnrichment([{ assetClass: "equity", displayName: null }])).toBe(true);
  });

  it("is true for an unnamed instrument with a stale attempt", () => {
    expect(
      needsNameEnrichment([
        { assetClass: "equity", displayName: null, displayNameCheckedAt: stale },
      ]),
    ).toBe(true);
  });

  it("is false when the instrument already has a displayName", () => {
    expect(needsNameEnrichment([{ assetClass: "equity", displayName: "Apple Inc." }])).toBe(false);
  });

  it("is false for a recent unmatched attempt", () => {
    expect(
      needsNameEnrichment([
        { assetClass: "equity", displayName: null, displayNameCheckedAt: fresh },
      ]),
    ).toBe(false);
  });

  it("includes crypto (unlike sector enrichment) but skips gold/cash", () => {
    expect(needsNameEnrichment([{ assetClass: "crypto", displayName: null }])).toBe(true);
    expect(needsNameEnrichment([{ assetClass: "gold", displayName: null }])).toBe(false);
    expect(needsNameEnrichment([{ assetClass: "cash", displayName: null }])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// refreshInstrumentMetadata — clean displayName enrichment (PGlite)
// ---------------------------------------------------------------------------

describe("refreshInstrumentMetadata — displayName", () => {
  let portfolioId: string;

  beforeAll(async () => {
    await ensureDb();
    const db = getDb();
    const [user] = await db
      .insert(users)
      .values({ authSub: "test|name-enrich", email: "name-enrich@example.com" })
      .returning();
    const [pf] = await db
      .insert(portfolios)
      .values({ userId: user.id, name: "Name Enrich", baseCurrency: "USD" })
      .returning();
    portfolioId = pf.id;
  });

  /** A service whose search() returns the given results (getProfile returns nothing). */
  function searchService(results: Partial<InstrumentSearchResult>[]): MarketDataService {
    return {
      getProfile: async () => null,
      search: async () => results as InstrumentSearchResult[],
      resolveName: async () => null, // fall back to search
    } as unknown as MarketDataService;
  }

  /** A service whose resolveName() returns the given name (preferred over search). */
  function namingService(
    name: string | null,
    searchResults?: Partial<InstrumentSearchResult>[],
  ): MarketDataService {
    return {
      getProfile: async () => null,
      search: async () => (searchResults ?? []) as InstrumentSearchResult[],
      resolveName: async () => name,
    } as unknown as MarketDataService;
  }

  async function createHeld(opts: {
    symbol: string;
    assetClass: "equity" | "crypto";
    market?: string;
    isin?: string;
    displayName?: string | null;
    displayNameCheckedAt?: Date | null;
  }): Promise<string> {
    const db = getDb();
    const [inst] = await db
      .insert(instruments)
      .values({
        symbol: opts.symbol,
        market: opts.market ?? "US",
        assetClass: opts.assetClass,
        unit: "shares",
        currency: "USD",
        isin: opts.isin ?? null,
        name: opts.symbol, // raw broker string == the ticker
        displayName: opts.displayName ?? null,
        displayNameCheckedAt: opts.displayNameCheckedAt ?? null,
        sectorCheckedAt: new Date(), // keep the sector pass out of the way
      })
      .returning();
    await db.insert(transactions).values({
      portfolioId,
      instrumentId: inst.id,
      type: "buy",
      quantity: "1",
      price: "100",
      fees: "0",
      currency: "USD",
      executedAt: new Date("2026-01-01"),
    });
    return inst.id;
  }

  it("resolves a clean displayName from a symbol+market match, leaving name untouched", async () => {
    const db = getDb();
    const id = await createHeld({ symbol: "AAPL_NM", assetClass: "equity" });
    await refreshInstrumentMetadata(
      db,
      searchService([{ symbol: "AAPL_NM", market: "US", name: "AAPL_NM", longName: "Apple Inc." }]),
    );
    const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
    expect(row.displayName).toBe("Apple Inc.");
    expect(row.displayNameCheckedAt).not.toBeNull();
    expect(row.name).toBe("AAPL_NM"); // never overwritten
  });

  it("stamps the attempt but leaves displayName null when no match (wrong market, no ISIN)", async () => {
    const db = getDb();
    const id = await createHeld({ symbol: "TCKR_NM", assetClass: "equity", market: "US" });
    await refreshInstrumentMetadata(
      db,
      // Same ticker, different market, and no ISIN to disambiguate → not a confident match.
      searchService([
        { symbol: "TCKR_NM", market: "XETRA", name: "TCKR_NM", longName: "Wrong Co" },
      ]),
    );
    const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
    expect(row.displayName).toBeNull();
    expect(row.displayNameCheckedAt).not.toBeNull();
  });

  it("accepts an ISIN-resolved name even when the resolved listing differs (ISIN is authoritative)", async () => {
    const db = getDb();
    // We hold the Xetra line; the resolver returns the LSE listing (different symbol/market).
    // The ISIN pins both to the same fund, so its name is authoritative for our row.
    const id = await createHeld({
      symbol: "EUNL_NM",
      assetClass: "equity",
      market: "XETRA",
      isin: "IE00B4L5Y983",
    });
    await refreshInstrumentMetadata(
      db,
      searchService([
        {
          symbol: "IWDA",
          market: "LSE",
          name: "iShares Core MSCI World",
          longName: "iShares Core MSCI World UCITS ETF",
        },
      ]),
    );
    const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
    expect(row.displayName).toBe("iShares Core MSCI World UCITS ETF");
    expect(row.name).toBe("EUNL_NM"); // raw name never overwritten
  });

  it("does not re-enrich or overwrite an instrument that already has a displayName", async () => {
    const db = getDb();
    const id = await createHeld({
      symbol: "SET_NM",
      assetClass: "equity",
      displayName: "Already Named",
    });
    await refreshInstrumentMetadata(
      db,
      searchService([{ symbol: "SET_NM", market: "US", name: "SET_NM", longName: "New Name" }]),
    );
    const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
    expect(row.displayName).toBe("Already Named");
  });

  it("enriches crypto (not skipped for names)", async () => {
    const db = getDb();
    const id = await createHeld({ symbol: "BTC_NM", assetClass: "crypto" });
    await refreshInstrumentMetadata(
      db,
      searchService([{ symbol: "BTC_NM", market: "US", name: "BTC_NM", longName: "Bitcoin" }]),
    );
    const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
    expect(row.displayName).toBe("Bitcoin");
  });

  it("prefers resolveName (Yahoo) over search (OpenFIGI) for ISIN instruments", async () => {
    const db = getDb();
    const id = await createHeld({
      symbol: "PREF_NM",
      assetClass: "equity",
      market: "XETRA",
      isin: "IE00PREF0011",
    });
    // resolveName returns nicely-cased name; search returns ALL-CAPS
    await refreshInstrumentMetadata(
      db,
      namingService("iShares Core MSCI World UCITS ETF USD (Acc)", [
        {
          symbol: "IWDA",
          market: "LSE",
          name: "ISHARES CORE MSCI WORLD",
          longName: "ISHARES CORE MSCI WORLD",
        },
      ]),
    );
    const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
    expect(row.displayName).toBe("iShares Core MSCI World UCITS ETF USD (Acc)");
  });

  it("falls back to search when resolveName returns null", async () => {
    const db = getDb();
    const id = await createHeld({
      symbol: "VWCE_NM",
      assetClass: "equity",
      market: "XETRA",
      isin: "IE00BK5BQT80",
    });
    await refreshInstrumentMetadata(
      db,
      namingService(null, [
        {
          symbol: "VWCE",
          market: "XETRA",
          name: "VANGUARD FTSE ALL-WORLD UCITS ETF",
          longName: "VANGUARD FTSE ALL-WORLD UCITS ETF",
        },
      ]),
    );
    const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
    expect(row.displayName).toBe("VANGUARD FTSE ALL-WORLD UCITS ETF");
  });

  it("overwrites existing displayName when force is true (upgrades ALL-CAPS to clean name)", async () => {
    const db = getDb();
    const id = await createHeld({
      symbol: "FORCE_NM",
      assetClass: "equity",
      market: "XETRA",
      isin: "IE00FRCE0013",
      displayName: "ISHARES CORE MSCI WORLD",
    });
    await refreshInstrumentMetadata(
      db,
      namingService("iShares Core MSCI World UCITS ETF USD (Acc)"),
      { force: true },
    );
    const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
    expect(row.displayName).toBe("iShares Core MSCI World UCITS ETF USD (Acc)");
  });

  it("does not overwrite existing displayName when force is false", async () => {
    const db = getDb();
    const id = await createHeld({
      symbol: "NOFRC_NM",
      assetClass: "equity",
      market: "XETRA",
      isin: "IE00NFRC0014",
      displayName: "ISHARES CORE MSCI WORLD",
    });
    await refreshInstrumentMetadata(
      db,
      namingService("iShares Core MSCI World UCITS ETF USD (Acc)"),
    );
    const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
    expect(row.displayName).toBe("ISHARES CORE MSCI WORLD"); // unchanged
  });
});
