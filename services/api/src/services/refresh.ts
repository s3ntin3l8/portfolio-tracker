import { inArray, isNotNull } from "drizzle-orm";
import { instruments, transactions } from "@portfolio/db";
import type { InstrumentRef, MarketDataService } from "@portfolio/market-data";
import type { DB } from "../db/client.js";
import { upsertLastPrices } from "./price-cache.js";
import { isMarketOpen } from "./market-hours.js";

/**
 * Proactively refresh cached prices for every held instrument whose market is
 * currently open, writing fresh quotes to last_prices. Held = referenced by at
 * least one transaction. Returns how many instruments were refreshed.
 */
export async function refreshHeldPrices(
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
  const open = rows.filter((i) => isMarketOpen(i.market, now));
  if (open.length === 0) return 0;

  const quotes = await service.getQuotes(
    open.map((i) => ({
      id: i.id,
      ref: {
        symbol: i.symbol,
        market: i.market,
        assetClass: i.assetClass,
        currency: i.currency,
        // Pass the ISIN so providers can use it for cross-listing disambiguation when the
        // stored symbol resolves to a wrong listing (Yahoo's resolveIsinSymbol fallback).
        isin: i.isin ?? undefined,
      } satisfies InstrumentRef,
    })),
  );
  await upsertLastPrices(db, quotes, now);
  return Object.keys(quotes).length;
}
