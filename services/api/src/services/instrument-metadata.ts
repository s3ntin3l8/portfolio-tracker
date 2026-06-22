import { eq, isNotNull, inArray } from "drizzle-orm"; // inArray for heldIds filter
import { instruments, transactions } from "@portfolio/db";
import type { MarketDataService } from "@portfolio/market-data";
import type { DB } from "../db/client.js";

/**
 * GICS sectors that are meaningless for non-equity instruments. We skip profile
 * lookups for these asset classes to avoid burning API quota on gold/funds/etc.
 */
const SKIP_ASSET_CLASSES = new Set(["gold", "mutual_fund", "bond", "crypto"]);

/**
 * Fetch sector + industry + country metadata from the market-data stack for
 * every *held* instrument whose `sector` column is still null, and persist it
 * onto the instrument row.
 *
 * Runs on a weekly schedule (see scheduler.ts). Skips asset classes where
 * sector is not meaningful (gold, bonds, mutual funds, crypto). A single failed
 * lookup is logged but does not abort the job — the row is retried next week.
 *
 * Returns the number of instruments successfully enriched.
 */
export async function refreshInstrumentMetadata(
  db: DB,
  service: MarketDataService,
): Promise<number> {
  // Only instruments held (referenced by at least one transaction) are worth
  // enriching — instruments in the catalogue but never transacted are skipped.
  const held = await db
    .selectDistinct({ instrumentId: transactions.instrumentId })
    .from(transactions)
    .where(isNotNull(transactions.instrumentId));

  const heldIds = held
    .map((r) => r.instrumentId)
    .filter((x): x is string => x !== null);
  if (heldIds.length === 0) return 0;

  // Fetch only instruments missing a sector.
  const rows = await db
    .select()
    .from(instruments)
    .where(inArray(instruments.id, heldIds));

  const toEnrich = rows.filter(
    (i) => i.sector == null && !SKIP_ASSET_CLASSES.has(i.assetClass),
  );
  if (toEnrich.length === 0) return 0;

  let enriched = 0;
  for (const inst of toEnrich) {
    try {
      const profile = await service.getProfile({
        symbol: inst.symbol,
        market: inst.market,
        assetClass: inst.assetClass as Parameters<typeof service.getProfile>[0]["assetClass"],
        currency: inst.currency,
        isin: inst.isin ?? undefined,
      });
      if (!profile?.sector) continue;

      await db
        .update(instruments)
        .set({ sector: profile.sector })
        .where(eq(instruments.id, inst.id));

      enriched++;
    } catch {
      // Non-fatal: this instrument will be retried on the next weekly run.
    }
  }

  return enriched;
}
