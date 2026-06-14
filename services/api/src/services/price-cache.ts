import { inArray } from "drizzle-orm";
import { lastPrices } from "@portfolio/db";
import type { InstrumentRef, MarketDataService } from "@portfolio/market-data";
import type { DB } from "../db/client.js";

export interface PricedRef {
  id: string;
  ref: InstrumentRef;
}

/** Latest price + currency, keyed by instrument id (the shape core valuation wants). */
export type PriceMap = Record<string, { price: string; currency: string }>;

/**
 * Read-through last-price cache. Serves quotes fresher than `ttlMs` from the
 * `last_prices` table; for anything missing or stale, fetches live via the
 * provider chain and writes the result back. Keeps portfolio valuation cheap and
 * resilient to provider rate limits / outages instead of hitting providers on
 * every request.
 */
export async function getCachedQuotes(
  db: DB,
  service: MarketDataService,
  refs: PricedRef[],
  ttlMs: number,
  now: Date = new Date(),
): Promise<PriceMap> {
  const prices: PriceMap = {};
  if (refs.length === 0) return prices;

  const cutoff = now.getTime() - ttlMs;
  const cached = await db
    .select()
    .from(lastPrices)
    .where(
      inArray(
        lastPrices.instrumentId,
        refs.map((r) => r.id),
      ),
    );
  const fresh = new Set<string>();
  for (const row of cached) {
    if (new Date(row.asOf).getTime() >= cutoff) {
      prices[row.instrumentId] = { price: row.price, currency: row.currency };
      fresh.add(row.instrumentId);
    }
  }

  const stale = refs.filter((r) => !fresh.has(r.id));
  if (stale.length === 0) return prices;

  const quotes = await service.getQuotes(
    stale.map((r) => ({ id: r.id, ref: r.ref })),
  );
  for (const [instrumentId, q] of Object.entries(quotes)) {
    prices[instrumentId] = { price: q.price, currency: q.currency };
    await db
      .insert(lastPrices)
      .values({ instrumentId, price: q.price, currency: q.currency, asOf: now })
      .onConflictDoUpdate({
        target: lastPrices.instrumentId,
        set: { price: q.price, currency: q.currency, asOf: now },
      });
  }
  return prices;
}
