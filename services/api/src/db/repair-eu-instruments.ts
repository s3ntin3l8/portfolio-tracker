import { eq } from "drizzle-orm";
import { instruments, lastPrices } from "@portfolio/db";
import { isIsin, yahooSuffixForMarket } from "@portfolio/market-data";
import { ensureDb, closeDb } from "./client.js";
import { getMarketData } from "../services/market-data.js";

/**
 * One-off CLI to repair foreign (DKB / Trade Republic) instruments that were stored with
 * the wrong asset class or venue before the import resolution was fixed — most importantly
 * UCITS ETFs mislabelled `mutual_fund` (OpenFIGI reports them as securityType "ETP" but
 * securityType2 "Mutual Fund"), which no quote provider covers for Xetra, so they showed
 * no price (#112 / #111).
 *
 * For each non-Indonesian instrument still classed `mutual_fund` it re-resolves the ISIN
 * via the live provider chain and, when warranted, upgrades the asset class, swaps an
 * ISIN-as-symbol for the real ticker, and normalises an unpriceable venue to Xetra/EUR
 * (the broker's execution venue). It then clears the cached `last_prices` row so the next
 * valuation refetches through the now-correct route. Idempotent — safe to re-run.
 *
 * Reads DATABASE_URL from the environment (`npm run repair:instruments` loads ../../.env;
 * in a container run `node dist/db/repair-eu-instruments.js` with env already set).
 */
async function main() {
  const db = await ensureDb();
  const md = await getMarketData();

  const all = await db
    .select()
    .from(instruments)
    .where(eq(instruments.assetClass, "mutual_fund"));
  // Indonesian reksa dana (ISIN starting "ID") are genuine open-end funds — leave them.
  const candidates = all.filter((i) => i.isin && !i.isin.startsWith("ID"));

  console.log(`Found ${candidates.length} foreign mutual_fund instrument(s) to inspect.`);

  let fixed = 0;
  for (const inst of candidates) {
    const [hit] = await md.search(inst.isin!);
    if (!hit) {
      console.log(`  ${inst.symbol} (${inst.isin}): no resolution — skip (re-run later)`);
      continue;
    }

    // A Xetra/Frankfurt listing (or US) is priceable via Yahoo `.DE`/bare; anything else
    // (e.g. Euronext Paris "FP") isn't, so normalise it to the broker's Xetra/EUR venue.
    const priceable = Boolean(yahooSuffixForMarket(inst.market)) || inst.market === "US";
    const symbol = isIsin(inst.symbol) && !isIsin(hit.symbol) ? hit.symbol : inst.symbol;
    const assetClass = hit.assetClass !== "equity" ? hit.assetClass : inst.assetClass;
    const market = priceable ? inst.market : "XETRA";
    const currency = priceable ? inst.currency : "EUR";

    if (
      symbol === inst.symbol &&
      assetClass === inst.assetClass &&
      market === inst.market &&
      currency === inst.currency
    ) {
      console.log(`  ${inst.symbol} (${inst.isin}): already correct — skip`);
      continue;
    }

    await db
      .update(instruments)
      .set({ symbol, assetClass, market, currency })
      .where(eq(instruments.id, inst.id));
    await db.delete(lastPrices).where(eq(lastPrices.instrumentId, inst.id));
    fixed++;
    console.log(
      `  ${inst.symbol}: ${inst.market}/${inst.currency}/${inst.assetClass} -> ` +
        `${market}/${currency}/${assetClass} (symbol ${symbol}); cleared cached price`,
    );
  }

  console.log(`Repaired ${fixed} instrument(s).`);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
