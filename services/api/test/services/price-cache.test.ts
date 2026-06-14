import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { instruments, lastPrices } from "@portfolio/db";
import type { MarketDataService } from "@portfolio/market-data";
import { ensureDb, getDb, closeDb } from "../../src/db/client.js";
import { getCachedQuotes, type PricedRef } from "../../src/services/price-cache.js";

// A market-data service stub that counts how many times it's hit.
function service(price: string, counter: { n: number }): MarketDataService {
  return {
    getQuotes: async (refs: Array<{ id: string }>) => {
      counter.n++;
      const out: Record<string, { price: string; currency: string; asOf: string }> =
        {};
      for (const r of refs) {
        out[r.id] = { price, currency: "IDR", asOf: "2026-02-08T00:00:00.000Z" };
      }
      return out;
    },
  } as unknown as MarketDataService;
}

describe("getCachedQuotes", () => {
  let instrumentId: string;
  let ref: PricedRef;

  beforeAll(async () => {
    const db = await ensureDb();
    const [inst] = await db
      .insert(instruments)
      .values({
        symbol: "BBCA",
        market: "IDX",
        assetClass: "equity",
        currency: "IDR",
        name: "BCA",
      })
      .returning();
    instrumentId = inst.id;
    ref = {
      id: inst.id,
      ref: { symbol: "BBCA", market: "IDX", assetClass: "equity", currency: "IDR" },
    };
  });

  afterAll(async () => {
    await closeDb();
  });

  it("misses then caches within the TTL and refreshes when stale", async () => {
    const db = getDb();
    const t0 = new Date("2026-02-08T10:00:00.000Z");
    const counter = { n: 0 };

    // Miss → live fetch + write-back.
    const a = await getCachedQuotes(db, service("9500", counter), [ref], 10_000, t0);
    expect(a[instrumentId]).toEqual({ price: "9500", currency: "IDR" });
    expect(counter.n).toBe(1);
    const [row] = await db
      .select()
      .from(lastPrices)
      .where(eq(lastPrices.instrumentId, instrumentId));
    expect(row.price).toBe("9500");

    // Within TTL → served from cache; the provider isn't called (newer price ignored).
    const b = await getCachedQuotes(
      db,
      service("9999", counter),
      [ref],
      10_000,
      new Date(t0.getTime() + 5_000),
    );
    expect(b[instrumentId]).toEqual({ price: "9500", currency: "IDR" });
    expect(counter.n).toBe(1);

    // Past TTL → re-fetch + update the cached row.
    const c = await getCachedQuotes(
      db,
      service("9800", counter),
      [ref],
      10_000,
      new Date(t0.getTime() + 20_000),
    );
    expect(c[instrumentId]).toEqual({ price: "9800", currency: "IDR" });
    expect(counter.n).toBe(2);
    const [updated] = await db
      .select()
      .from(lastPrices)
      .where(eq(lastPrices.instrumentId, instrumentId));
    expect(updated.price).toBe("9800");
  });

  it("returns an empty map for no refs without hitting the provider", async () => {
    const counter = { n: 0 };
    const out = await getCachedQuotes(getDb(), service("1", counter), [], 10_000);
    expect(out).toEqual({});
    expect(counter.n).toBe(0);
  });
});
