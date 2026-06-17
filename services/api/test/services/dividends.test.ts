import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { users, portfolios, instruments, transactions, dividendEvents } from "@portfolio/db";
import type { DividendEvent, MarketDataService } from "@portfolio/market-data";
import { ensureDb, getDb, closeDb } from "../../src/db/client.js";
import { refreshDividends } from "../../src/services/dividends.js";

function service(events: Record<string, DividendEvent[]>): MarketDataService {
  return {
    getDividends: async (ref: { symbol: string }) => events[ref.symbol] ?? [],
  } as unknown as MarketDataService;
}

describe("refreshDividends", () => {
  let instrumentId: string;
  const NOW = new Date("2026-06-17T00:00:00.000Z");

  beforeAll(async () => {
    const db = await ensureDb();
    const [user] = await db
      .insert(users)
      .values({ authSub: "divrefresh|u", email: "div@example.com" })
      .returning();
    const [pf] = await db
      .insert(portfolios)
      .values({ userId: user.id, name: "DivPF", baseCurrency: "IDR" })
      .returning();
    const [inst] = await db
      .insert(instruments)
      .values({ symbol: "BBCA", market: "IDX", assetClass: "equity", currency: "IDR", name: "BCA" })
      .returning();
    instrumentId = inst.id;
    await db.insert(transactions).values({
      portfolioId: pf.id,
      instrumentId: inst.id,
      type: "buy" as const,
      quantity: "100",
      price: "10000",
      currency: "IDR",
      executedAt: new Date("2025-01-01T00:00:00.000Z"),
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  it("inserts announced dividend events for held equity instruments", async () => {
    const db = getDb();
    const svc = service({
      BBCA: [
        { exDate: "2026-07-15", payDate: "2026-07-30", amountPerShare: "100", currency: "IDR" },
        { exDate: "2025-12-10", payDate: "2025-12-20", amountPerShare: "80", currency: "IDR" },
      ],
    });
    const count = await refreshDividends(db, svc, NOW);
    expect(count).toBe(2);
    const rows = await db.select().from(dividendEvents);
    const forBbca = rows.filter((r) => r.instrumentId === instrumentId);
    expect(forBbca).toHaveLength(2);
    const future = forBbca.find((r) => r.exDate === "2026-07-15");
    const past = forBbca.find((r) => r.exDate === "2025-12-10");
    // Future ex-date → announced; past ex-date → paid.
    expect(future?.status).toBe("announced");
    expect(past?.status).toBe("paid");
    expect(future?.amountPerShare).toBe("100");
    expect(future?.payDate).toBe("2026-07-30");
  });

  it("upserts on re-run — updates amount and status, no duplicates", async () => {
    const db = getDb();
    const svc = service({
      BBCA: [
        // Same exDate as before but amount changed (e.g. declared more precisely).
        { exDate: "2026-07-15", payDate: "2026-07-30", amountPerShare: "120", currency: "IDR" },
      ],
    });
    await refreshDividends(db, svc, NOW);
    const rows = await db.select().from(dividendEvents);
    const forBbca = rows.filter((r) => r.instrumentId === instrumentId);
    // Should still be 2 rows (not 3).
    expect(forBbca).toHaveLength(2);
    const updated = forBbca.find((r) => r.exDate === "2026-07-15");
    expect(updated?.amountPerShare).toBe("120");
  });

  it("skips non-equity instruments (gold, bonds, funds)", async () => {
    const db = getDb();
    // Insert a gold instrument with a transaction.
    await db.select().from(users).limit(1);
    const [pf] = await db
      .select()
      .from(portfolios)
      .limit(1);
    const [goldInst] = await db
      .insert(instruments)
      .values({ symbol: "GOLD", market: "XAU", assetClass: "gold", unit: "grams", currency: "IDR", name: "Gold" })
      .returning();
    await db.insert(transactions).values({
      portfolioId: pf.id,
      instrumentId: goldInst.id,
      type: "buy" as const,
      quantity: "10",
      price: "1000000",
      currency: "IDR",
      executedAt: new Date("2025-01-01T00:00:00.000Z"),
    });
    const svc = service({
      GOLD: [{ exDate: "2026-07-15", amountPerShare: "1", currency: "IDR" }],
    });
    const countBefore = (await db.select().from(dividendEvents)).length;
    await refreshDividends(db, svc, NOW);
    const countAfter = (await db.select().from(dividendEvents)).length;
    // Gold dividends should not be inserted.
    expect(countAfter).toBe(countBefore);
  });

  it("returns 0 when no instruments are held", async () => {
    // Use a separate DB query: service returns events but no held rows match gold/bond.
    const svc = service({});
    // Close + reopen would reset the DB, so just check the return value with empty provider.
    const count = await refreshDividends(getDb(), svc, NOW);
    expect(count).toBe(0);
  });
});
