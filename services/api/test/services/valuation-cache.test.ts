import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { instruments, portfolios, transactions, users } from "@portfolio/db";
import type { MarketDataService } from "@portfolio/market-data";
import { ensureDb, getDb, closeDb } from "../../src/db/client.js";
import { valuePortfolioCached, clearValuationCache } from "../../src/services/valuation.js";

// A market-data service stub that counts how many times it's actually invoked — since
// `getCachedQuotes` only calls the provider when pricing at least one instrument, this
// doubles as a "did valuePortfolio actually recompute" probe: a cache hit never reaches
// the provider at all.
function countingService(counter: { n: number }, opts: { throwOnCall?: number } = {}): MarketDataService {
  return {
    getQuotes: async (refs: Array<{ id: string }>) => {
      counter.n++;
      if (opts.throwOnCall === counter.n) throw new Error("provider down");
      const out: Record<string, { price: string; currency: string; asOf: string }> = {};
      for (const r of refs) {
        out[r.id] = { price: "9500", currency: "IDR", asOf: "2026-02-08T00:00:00.000Z" };
      }
      return out;
    },
  } as unknown as MarketDataService;
}

describe("valuePortfolioCached", () => {
  afterAll(async () => {
    await closeDb();
  });

  // A fresh portfolio + instrument + transaction per test, not a shared fixture. This
  // isolates each test from `getCachedQuotes`' own DB-level last-price cache (keyed by
  // instrumentId, TTL'd against the real wall clock — see price-cache.ts): reusing one
  // instrument across tests would mean only the very first test's call is a genuine
  // price-cache miss, and every later test would silently short-circuit through THAT
  // cache instead of exercising valuePortfolioCached's own hit/miss behavior.
  async function setupPortfolio(): Promise<string> {
    const db = await ensureDb();
    const [u] = await db
      .insert(users)
      .values({ authSub: `valcache-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com` })
      .returning();
    const [p] = await db
      .insert(portfolios)
      .values({ userId: u.id, name: "ValCache", baseCurrency: "IDR", cashCounted: true })
      .returning();
    const [bbca] = await db
      .insert(instruments)
      .values({
        // Unique per call — instruments has a (market, symbol) unique index, and each
        // test needs its own instrument so it isn't served by another test's
        // already-warm `lastPrices` row (see this function's doc comment).
        symbol: `BBCA-${crypto.randomUUID().slice(0, 8)}`,
        market: "IDX",
        assetClass: "equity",
        currency: "IDR",
        name: "BCA",
      })
      .returning();
    await db.insert(transactions).values({
      portfolioId: p.id,
      instrumentId: bbca.id,
      type: "buy",
      quantity: "100",
      price: "9000",
      currency: "IDR",
      executedAt: new Date("2026-01-02"),
    });
    return p.id;
  }

  beforeEach(() => {
    clearValuationCache();
  });

  it("computes once, then serves repeat calls from cache within the TTL", async () => {
    const portfolioId = await setupPortfolio();
    const db = getDb();
    const counter = { n: 0 };
    const t0 = Date.parse("2026-02-08T10:00:00.000Z");

    // ttlMs=0 here is the MARKET DATA price-cache TTL (a separate, real-wall-clock-based
    // cache inside getCachedQuotes — see price-cache.ts), not this test's derivation-cache
    // TTL. Passing 0 forces every genuine valuePortfolio run to reach the provider, so
    // `counter.n` cleanly reflects "did valuePortfolioCached recompute" rather than being
    // confounded by that separate cache layer serving an already-warm price.
    const a = await valuePortfolioCached(db, countingService(counter), 0, portfolioId, "IDR", undefined, true, t0);
    expect(a.summary.holdings).toHaveLength(1);
    expect(counter.n).toBe(1);

    // Same key, well within the 60s TTL — served from cache, provider not called again.
    const b = await valuePortfolioCached(
      db,
      countingService(counter),
      0,
      portfolioId,
      "IDR",
      undefined,
      true,
      t0 + 1_000,
    );
    expect(b).toBe(a); // same cached object, not just equal
    expect(counter.n).toBe(1);
  });

  it("recomputes once the TTL has elapsed", async () => {
    const portfolioId = await setupPortfolio();
    const db = getDb();
    const counter = { n: 0 };
    const t0 = Date.parse("2026-02-08T10:00:00.000Z");

    await valuePortfolioCached(db, countingService(counter), 0, portfolioId, "IDR", undefined, true, t0);
    expect(counter.n).toBe(1);

    // Past the 60s derivation-cache TTL — cache entry expired, provider called again.
    await valuePortfolioCached(
      db,
      countingService(counter),
      0,
      portfolioId,
      "IDR",
      undefined,
      true,
      t0 + 60_001,
    );
    expect(counter.n).toBe(2);
  });

  it("keys the cache by costBasisMode/cashCounted — no cross-scope collisions", async () => {
    // displayCurrency intentionally held constant at IDR (the portfolio's own currency)
    // across all calls here — a differing displayCurrency would exercise a real FX-rate
    // lookup, which is a separate concern from this cache's key uniqueness.
    const portfolioId = await setupPortfolio();
    const db = getDb();
    const counter = { n: 0 };
    const t0 = Date.parse("2026-02-08T10:00:00.000Z");

    await valuePortfolioCached(db, countingService(counter), 0, portfolioId, "IDR", undefined, true, t0);
    expect(counter.n).toBe(1);

    // Different costBasisMode — distinct key, must recompute.
    await valuePortfolioCached(
      db,
      countingService(counter),
      0,
      portfolioId,
      "IDR",
      "total_paid",
      true,
      t0,
    );
    expect(counter.n).toBe(2);

    // Different cashCounted boundary — distinct key, must recompute.
    await valuePortfolioCached(db, countingService(counter), 0, portfolioId, "IDR", undefined, false, t0);
    expect(counter.n).toBe(3);
  });

  it("collapses concurrent calls for the same scope onto one in-flight computation", async () => {
    const portfolioId = await setupPortfolio();
    const db = getDb();
    const counter = { n: 0 };
    const t0 = Date.parse("2026-02-08T10:00:00.000Z");

    const [a, b] = await Promise.all([
      valuePortfolioCached(db, countingService(counter), 0, portfolioId, "IDR", undefined, true, t0),
      valuePortfolioCached(db, countingService(counter), 0, portfolioId, "IDR", undefined, true, t0),
    ]);
    expect(a).toBe(b);
    expect(counter.n).toBe(1);
  });

  it("doesn't poison the cache on failure — the next call retries instead of rejecting from cache", async () => {
    const portfolioId = await setupPortfolio();
    const db = getDb();
    const counter = { n: 0 };
    const t0 = Date.parse("2026-02-08T10:00:00.000Z");

    await expect(
      valuePortfolioCached(
        db,
        countingService(counter, { throwOnCall: 1 }),
        0,
        portfolioId,
        "IDR",
        undefined,
        true,
        t0,
      ),
    ).rejects.toThrow("provider down");
    expect(counter.n).toBe(1);

    // Immediately after the failure, same scope, still "within TTL" by time — must not
    // be stuck serving the rejected promise; it should retry and succeed.
    const retry = await valuePortfolioCached(
      db,
      countingService(counter),
      0,
      portfolioId,
      "IDR",
      undefined,
      true,
      t0 + 10,
    );
    expect(retry.summary.holdings).toHaveLength(1);
    expect(counter.n).toBe(2);
  });
});
