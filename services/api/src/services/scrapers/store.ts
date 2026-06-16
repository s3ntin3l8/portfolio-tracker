import { eq } from "drizzle-orm";
import { scrapedQuotes } from "@portfolio/db";
import type { DB } from "../../db/client.js";
import { scrapeAntamBuyback, ANTAM_BUYBACK_SOURCE } from "./antam-buyback.js";
import { scrapeGaleri24Buyback, GALERI24_BUYBACK_SOURCE } from "./galeri24-buyback.js";
import { refreshBibitNav, BIBIT_SOURCE } from "./bibit-nav.js";

// Cache keys in `scraped_quotes`. Shared by the writers (scheduler) and the readers
// (internal market-data routes) so they can never drift.
export const ANTAM_BUYBACK_KEY = "gold:antam-buyback";
export const GALERI24_BUYBACK_KEY = "gold:galeri24-buyback";
export const navKey = (symbol: string): string => `nav:${symbol}`;

/** Upsert one scraped value (stored as a numeric string to preserve precision). */
export async function upsertScrapedQuote(
  db: DB,
  key: string,
  value: number,
  source: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(scrapedQuotes)
    .values({ key, value: String(value), source, updatedAt: now })
    .onConflictDoUpdate({
      target: scrapedQuotes.key,
      set: { value: String(value), source, updatedAt: now },
    });
}

/** Read one cached value as a finite number, or `null` if absent / unparseable. */
export async function getScrapedQuote(db: DB, key: string): Promise<number | null> {
  const [row] = await db
    .select({ value: scrapedQuotes.value })
    .from(scrapedQuotes)
    .where(eq(scrapedQuotes.key, key));
  if (!row) return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : null;
}

/** Scrape the Antam buyback and cache it. Returns the value, or `null` if unavailable. */
export async function refreshAntamBuyback(
  db: DB,
  doFetch?: typeof fetch,
  now: Date = new Date(),
): Promise<number | null> {
  const value = await scrapeAntamBuyback(doFetch);
  if (value !== null) {
    await upsertScrapedQuote(db, ANTAM_BUYBACK_KEY, value, ANTAM_BUYBACK_SOURCE, now);
  }
  return value;
}

/** Scrape the Galeri24 buyback and cache it. Returns the value, or `null` if unavailable. */
export async function refreshGaleri24Buyback(
  db: DB,
  doFetch?: typeof fetch,
  now: Date = new Date(),
): Promise<number | null> {
  const value = await scrapeGaleri24Buyback(doFetch);
  if (value !== null) {
    await upsertScrapedQuote(db, GALERI24_BUYBACK_KEY, value, GALERI24_BUYBACK_SOURCE, now);
  }
  return value;
}

/** Scrape the Bibit fund catalogue and cache each fund's NAV. Returns how many were cached. */
export async function refreshNav(
  db: DB,
  doFetch?: typeof fetch,
  now: Date = new Date(),
): Promise<number> {
  const map = await refreshBibitNav(doFetch);
  for (const [symbol, nav] of map) {
    await upsertScrapedQuote(db, navKey(symbol), nav, BIBIT_SOURCE, now);
  }
  return map.size;
}
