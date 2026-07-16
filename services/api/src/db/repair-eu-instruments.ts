import { and, eq, isNotNull } from "drizzle-orm";
import { instruments, lastPrices } from "@portfolio/db";
import { isIsin, yahooSuffixForMarket } from "@portfolio/market-data";
import type { MarketDataService } from "@portfolio/market-data";
import type { DB } from "./client.js";
import { ensureDb, closeDb } from "./client.js";
import { getMarketData } from "../services/market-data.js";

/**
 * Repair foreign (DKB / Trade Republic) instruments that were stored with the wrong asset
 * class or venue before the import resolution was fixed. Two passes:
 *
 * **Pass 1 — mutual_fund reclassification (historical, original):** UCITS ETFs mislabelled
 * `mutual_fund` (OpenFIGI reports them as securityType "ETP" but securityType2 "Mutual
 * Fund") showed no price because no quote provider covers Xetra mutual_funds (#112/#111).
 * Re-resolves via the live provider chain and upgrades asset class, symbol, and venue.
 *
 * **Pass 2 — US cross-listing collision fix (new):** Non-US ISINs (IE…, DE…, GB…) that
 * were incorrectly pinned to `market=US, currency=USD` due to OpenFIGI's former US-first
 * preference. Re-resolves via the (now domicile-aware) provider chain and re-pins to the
 * correct Xetra/EUR venue. Clears cached prices so the next valuation re-fetches correctly.
 * Example: CSSPX (IE00B5BMR087 = iShares Core S&P 500 UCITS, Xetra SXR8) was priced as
 * Cohen & Steers Global Realty (US-listed CSSPX, ~$59).
 *
 * Idempotent — safe to re-run.
 */
export async function repairEuInstruments(
  db: DB,
  md: MarketDataService,
): Promise<{ pass1Fixed: number; pass2Fixed: number }> {
  // ── Pass 1: mutual_fund reclassification ────────────────────────────────────
  const allMutual = await db
    .select()
    .from(instruments)
    .where(eq(instruments.assetClass, "mutual_fund"));
  // Indonesian reksa dana (ISIN starting "ID") are genuine open-end funds — leave them.
  const mutualCandidates = allMutual.filter((i) => i.isin && !i.isin.startsWith("ID"));

  console.log(
    `\nPass 1: Found ${mutualCandidates.length} foreign mutual_fund instrument(s) to inspect.`,
  );

  let fixed = 0;
  for (const inst of mutualCandidates) {
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
        `${market}/${currency}/${assetClass} (symbol ${inst.symbol} -> ${symbol}); cleared cached price`,
    );
  }

  console.log(`Pass 1: Repaired ${fixed} instrument(s).`);

  // ── Pass 2: US cross-listing collision fix ──────────────────────────────────
  const allUsRows = await db
    .select()
    .from(instruments)
    .where(and(eq(instruments.market, "US"), isNotNull(instruments.isin)));
  // Only those with a non-US ISIN — these were incorrectly pinned to the US market.
  const usCandidates = allUsRows.filter((i) => i.isin && !i.isin.toUpperCase().startsWith("US"));

  console.log(
    `\nPass 2: Found ${usCandidates.length} non-US ISIN instrument(s) mis-pinned to market=US.`,
  );

  let fixed2 = 0;
  for (const inst of usCandidates) {
    const [hit] = await md.search(inst.isin!);

    // Determine the correct market/currency. The resolver is now domicile-aware, so it
    // should return a Xetra listing. Guard defensively: if it still returns "US" (shouldn't
    // happen, but be safe), or resolution fails entirely, fall back to XETRA/EUR.
    const resolvedMarket = hit && hit.market !== "US" ? hit.market : "XETRA";
    const resolvedCurrency = hit && hit.market !== "US" ? hit.currency : "EUR";
    // Adopt the resolved symbol only when it's a real ticker (not another ISIN).
    const resolvedSymbol = hit && !isIsin(hit.symbol) ? hit.symbol : inst.symbol;
    const resolvedAssetClass = hit?.assetClass ?? inst.assetClass;

    if (
      resolvedSymbol === inst.symbol &&
      resolvedAssetClass === inst.assetClass &&
      resolvedMarket === inst.market &&
      resolvedCurrency === inst.currency
    ) {
      console.log(`  ${inst.symbol} (${inst.isin}): already correct — skip`);
      continue;
    }

    await db
      .update(instruments)
      .set({
        symbol: resolvedSymbol,
        assetClass: resolvedAssetClass,
        market: resolvedMarket,
        currency: resolvedCurrency,
      })
      .where(eq(instruments.id, inst.id));
    await db.delete(lastPrices).where(eq(lastPrices.instrumentId, inst.id));
    fixed2++;
    console.log(
      `  ${inst.name} (${inst.isin}): ${inst.market}/${inst.currency} -> ` +
        `${resolvedMarket}/${resolvedCurrency} (symbol ${inst.symbol} -> ${resolvedSymbol}); cleared cached price`,
    );
  }

  console.log(`Pass 2: Repaired ${fixed2} instrument(s).`);
  return { pass1Fixed: fixed, pass2Fixed: fixed2 };
}

// Allow running directly: `tsx src/db/repair-eu-instruments.ts`.
const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const db = await ensureDb();
  const md = await getMarketData();
  await repairEuInstruments(db, md);
  await closeDb();
}
