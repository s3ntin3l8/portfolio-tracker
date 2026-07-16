import { isNotNull, inArray, sql } from "drizzle-orm";
import { instruments, dividendEvents, transactions } from "@portfolio/db";
import type { MarketDataService } from "@portfolio/market-data";
import type { DB } from "../db/client.js";

/**
 * Fetch fresh dividend events from the market-data stack for every held instrument
 * and upsert them into `dividend_events`. Runs once per day (scheduler calls this).
 * Returns the total number of rows written/updated.
 *
 * Status heuristic: if the ex-date is in the past, the dividend is considered paid;
 * otherwise it is announced (future ex-date, amount may still change).
 */
export async function refreshDividends(
  db: DB,
  service: MarketDataService,
  now: Date = new Date(),
): Promise<number> {
  const held = await db
    .selectDistinct({ instrumentId: transactions.instrumentId })
    .from(transactions)
    .where(isNotNull(transactions.instrumentId));

  const heldIds = held.map((r) => r.instrumentId).filter((x): x is string => x !== null);
  if (heldIds.length === 0) return 0;

  const rows = await db.select().from(instruments).where(inArray(instruments.id, heldIds));

  const twoYearsAgo = new Date(now);
  twoYearsAgo.setUTCFullYear(twoYearsAgo.getUTCFullYear() - 2);
  const fromDate = twoYearsAgo.toISOString().slice(0, 10);
  const todayStr = now.toISOString().slice(0, 10);

  let count = 0;
  for (const inst of rows) {
    if (inst.assetClass !== "equity" && inst.assetClass !== "etf") continue;

    const events = await service.getDividends(
      {
        symbol: inst.symbol,
        market: inst.market,
        assetClass: inst.assetClass,
        currency: inst.currency,
        isin: inst.isin ?? undefined,
      },
      fromDate,
    );
    if (events.length === 0) continue;

    await db
      .insert(dividendEvents)
      .values(
        events.map((e) => ({
          instrumentId: inst.id,
          exDate: e.exDate,
          payDate: e.payDate ?? null,
          amountPerShare: e.amountPerShare,
          currency: e.currency,
          status: (e.exDate <= todayStr ? "paid" : "announced") as "paid" | "announced",
          source: "market-data",
          fetchedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [dividendEvents.instrumentId, dividendEvents.exDate],
        set: {
          payDate: sql`excluded.pay_date`,
          amountPerShare: sql`excluded.amount_per_share`,
          currency: sql`excluded.currency`,
          status: sql`excluded.status`,
          source: sql`excluded.source`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      });
    count += events.length;
  }
  return count;
}
