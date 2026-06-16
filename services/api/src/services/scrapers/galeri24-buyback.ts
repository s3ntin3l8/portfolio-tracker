import * as cheerio from "cheerio";
import { BROWSER_HEADERS } from "./http.js";

/**
 * Scraper for the Galeri24 (Pegadaian certified gold) **buyback** price — IDR per gram,
 * used to price Galeri24 physical-gold holdings (market `GALERI24`). Feeds the registered
 * `BuybackProvider` via the internal `/internal/gold/galeri24-buyback` route (#121).
 *
 * Source: the official Galeri24 page serves the prices in static (server-rendered Nuxt) HTML
 * — HTTP 200 to a plain server fetch with browser headers, no JS/API needed. Each brand is a
 * `<div id="…">` section (GALERI 24, DINAR G24, BABY GALERI 24, …) holding a CSS-grid price
 * grid (`Berat | Harga Jual | Harga Buyback`), so extraction scopes to the **`GALERI 24`**
 * section and reads the **1 g** `Harga Buyback` (the per-gram reference rate quoted
 * everywhere; buyback drifts slightly by bar weight). Source URL + extraction are isolated
 * here so swapping to a fallback aggregator (harga-emas.org / logamspot.id) later is a
 * one-liner.
 *
 * Returns `null` on any failure (unreachable, layout change, no number) — the provider
 * already treats that as "no quote" and the chain falls through to spot / fixture.
 */
export const GALERI24_BUYBACK_SOURCE_URL = "https://galeri24.co.id/harga-emas";
export const GALERI24_BUYBACK_SOURCE = "galeri24";

export async function scrapeGaleri24Buyback(
  doFetch: typeof fetch = globalThis.fetch,
): Promise<number | null> {
  try {
    const res = await doFetch(GALERI24_BUYBACK_SOURCE_URL, { headers: BROWSER_HEADERS });
    if (!res.ok) return null;
    return extractBuybackFromHtml(await res.text());
  } catch {
    return null;
  }
}

/** "Rp2.549.000" → 2549000 (strip everything but digits — dots are thousands separators). */
function parseIdr(text: string): number {
  return Number(text.replace(/[^\d]/g, ""));
}

/** Parse a weight cell that may carry a fraction ("0.5", "1") → 0.5, 1. */
function parseWeight(text: string): number {
  return Number(text.replace(/[^\d.]/g, ""));
}

/**
 * Pull the 1 g Galeri24 buyback out of the galeri24.co.id markup. The `GALERI 24` brand is a
 * `<div id="GALERI 24">` section whose price grid renders one `div.grid-cols-5` row per bar
 * weight, each a `Berat | Harga Jual | Harga Buyback` triple. We read the row whose weight
 * (first cell) is exactly 1 and take its last cell (buyback is the final column). Returns
 * `null` if the section or the 1 g row can't be found, so a layout change degrades to "no
 * quote" rather than throwing.
 */
export function extractBuybackFromHtml(html: string): number | null {
  const $ = cheerio.load(html);
  // Exact id match — avoids the sibling "BABY GALERI 24" / "DINAR G24" brand sections.
  const section = $('[id="GALERI 24"]');
  if (section.length === 0) return null;

  for (const row of section.find(".grid-cols-5").toArray()) {
    const cells = $(row)
      .children("div")
      .toArray()
      .map((c) => $(c).text().trim());
    if (cells.length < 2) continue; // not a data row
    if (parseWeight(cells[0]) !== 1) continue; // skip the header + other weights
    const buyback = parseIdr(cells[cells.length - 1]);
    if (Number.isFinite(buyback) && buyback > 0) return buyback;
  }
  return null;
}
