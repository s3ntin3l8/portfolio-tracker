import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  users,
  portfolios,
  instruments,
  transactions,
  lastPrices,
} from "@portfolio/db";
import type { MarketDataService } from "@portfolio/market-data";
import { ensureDb, getDb, closeDb } from "../../src/db/client.js";
import { refreshHeldPrices } from "../../src/services/refresh.js";

function service(counter: { n: number }): MarketDataService {
  return {
    getQuotes: async (refs: Array<{ id: string }>) => {
      counter.n++;
      const out: Record<string, { price: string; currency: string; asOf: string }> =
        {};
      for (const r of refs) {
        out[r.id] = { price: "100", currency: "IDR", asOf: "2026-02-09T00:00:00.000Z" };
      }
      return out;
    },
  } as unknown as MarketDataService;
}

describe("refreshHeldPrices", () => {
  beforeAll(async () => {
    const db = await ensureDb();
    const [user] = await db
      .insert(users)
      .values({ authSub: "refresh|u", email: "r@example.com" })
      .returning();
    const [pf] = await db
      .insert(portfolios)
      .values({ userId: user.id, name: "P", baseCurrency: "IDR" })
      .returning();
    const inserted = await db
      .insert(instruments)
      .values([
        { symbol: "BBCA", market: "IDX", assetClass: "equity", currency: "IDR", name: "BCA" },
        { symbol: "GOLD", market: "XAU", assetClass: "gold", unit: "grams", currency: "IDR", name: "Gold" },
      ])
      .returning();
    await db.insert(transactions).values(
      inserted.map((i) => ({
        portfolioId: pf.id,
        instrumentId: i.id,
        type: "buy" as const,
        quantity: "1",
        price: "1",
        currency: "IDR",
        executedAt: new Date("2026-02-01T00:00:00.000Z"),
      })),
    );
  });

  afterAll(async () => {
    await closeDb();
  });

  it("refreshes held instruments whose market is open", async () => {
    const db = getDb();
    const counter = { n: 0 };
    // Monday 03:00 UTC → IDX and gold both open.
    const n = await refreshHeldPrices(db, service(counter), new Date(Date.UTC(2026, 1, 9, 3)));
    expect(n).toBe(2);
    const cached = await db.select().from(lastPrices);
    expect(cached).toHaveLength(2);
    expect(cached.every((r) => r.price === "100")).toBe(true);
  });

  it("refreshes nothing when all markets are closed", async () => {
    const counter = { n: 0 };
    // Saturday → IDX and gold both closed.
    const n = await refreshHeldPrices(
      getDb(),
      service(counter),
      new Date(Date.UTC(2026, 1, 14, 12)),
    );
    expect(n).toBe(0);
    expect(counter.n).toBe(0); // provider never consulted
  });
});
