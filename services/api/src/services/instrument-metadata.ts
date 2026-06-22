import { eq, isNotNull, inArray } from "drizzle-orm";
import { instruments, transactions } from "@portfolio/db";
import type { MarketDataService } from "@portfolio/market-data";
import type { DB } from "../db/client.js";

/**
 * GICS sectors that are meaningless for non-equity instruments. We skip profile
 * lookups for these asset classes to avoid burning API quota on gold/funds/etc.
 */
export const SKIP_ASSET_CLASSES = new Set(["gold", "mutual_fund", "bond", "crypto"]);

/** Stale threshold: re-attempt after 30 days even when a prior attempt returned nothing. */
const STALE_DAYS = 30;

/**
 * Predicate: should this instrument be (re-)enriched on the next sweep?
 *
 * An instrument needs enrichment when:
 * - It has never been attempted (`sectorCheckedAt == null`), OR
 * - The last attempt is older than STALE_DAYS (the provider may have added data since).
 *
 * Instruments in SKIP_ASSET_CLASSES are excluded — sector data is not meaningful
 * for gold, mutual funds, bonds, and crypto.
 *
 * Accepts either a raw DB row (with `sectorCheckedAt`) or a meta object with
 * an optional `sectorCheckedAt` field, so tests can call it without a DB round-trip.
 */
export function needsSectorEnrichment(
  instruments: ReadonlyArray<{ assetClass: string; sectorCheckedAt?: Date | string | null }>,
): boolean {
  const staleCutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);
  return instruments.some((i) => {
    if (SKIP_ASSET_CLASSES.has(i.assetClass)) return false;
    if (i.sectorCheckedAt == null) return true;
    const checkedAt = i.sectorCheckedAt instanceof Date
      ? i.sectorCheckedAt
      : new Date(i.sectorCheckedAt);
    return checkedAt < staleCutoff;
  });
}

/**
 * Fetch sector metadata from the market-data stack for every *held* instrument
 * that has never been attempted or whose last attempt is older than STALE_DAYS,
 * and persist it onto the instrument row.
 *
 * - **Stocks (equity):** writes `sector` (single GICS string).
 * - **ETFs:** writes `sectorWeights` (per-sector fraction map).
 *
 * `sectorCheckedAt` is **always** stamped on every attempt, even when the provider
 * returns nothing — this prevents the job from re-querying instruments indefinitely
 * when the provider has no sector data for them. They will be retried after STALE_DAYS.
 *
 * When `opts.force` is true, all held non-skip instruments are re-enriched regardless
 * of `sectorCheckedAt`. Useful after fixing a broken provider configuration.
 *
 * Runs on a weekly schedule (see scheduler.ts) and is also triggered on-demand by
 * the self-heal hook in the allocation endpoints. Skips asset classes where sector
 * is not meaningful. Per-instrument errors are logged but do not abort the batch.
 *
 * Returns the number of instruments successfully enriched.
 */
export async function refreshInstrumentMetadata(
  db: DB,
  service: MarketDataService,
  opts: { force?: boolean } = {},
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

  const rows = await db
    .select()
    .from(instruments)
    .where(inArray(instruments.id, heldIds));

  const staleCutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);
  const toEnrich = rows.filter((i) => {
    if (SKIP_ASSET_CLASSES.has(i.assetClass)) return false;
    if (opts.force) return true; // force: ignore sectorCheckedAt
    if (i.sectorCheckedAt == null) return true;
    return new Date(i.sectorCheckedAt) < staleCutoff;
  });
  if (toEnrich.length === 0) return 0;

  let enriched = 0;
  let skipped = 0;
  for (const inst of toEnrich) {
    try {
      const profile = await service.getProfile({
        symbol: inst.symbol,
        market: inst.market,
        assetClass: inst.assetClass as Parameters<typeof service.getProfile>[0]["assetClass"],
        currency: inst.currency,
        isin: inst.isin ?? undefined,
      });

      const now = new Date();

      if (inst.assetClass === "etf" && profile?.sectorWeights) {
        // ETF: write per-sector weight map; clear any stale single-sector value.
        await db
          .update(instruments)
          .set({ sectorWeights: profile.sectorWeights, sector: null, sectorCheckedAt: now })
          .where(eq(instruments.id, inst.id));
        enriched++;
      } else if (inst.assetClass !== "etf" && profile?.sector) {
        // Stock/equity: write single GICS sector.
        await db
          .update(instruments)
          .set({ sector: profile.sector, sectorCheckedAt: now })
          .where(eq(instruments.id, inst.id));
        enriched++;
      } else {
        // Provider returned nothing useful — stamp the attempt so we don't retry
        // until STALE_DAYS have passed, and note it for the run summary.
        await db
          .update(instruments)
          .set({ sectorCheckedAt: now })
          .where(eq(instruments.id, inst.id));
        skipped++;
        console.warn(
          `[instrument-metadata] no sector data for ${inst.symbol} (${inst.market}, ${inst.assetClass}) — provider returned null; will retry after ${STALE_DAYS} days`,
        );
      }
    } catch (err) {
      // Non-fatal: log the error. We deliberately do NOT stamp sectorCheckedAt on
      // exception so a transient network error doesn't suppress the instrument for
      // 30 days — it will be retried on the next scheduled run.
      console.warn(
        `[instrument-metadata] getProfile failed for ${inst.symbol} (${inst.market}, ${inst.assetClass}):`,
        err,
      );
    }
  }

  console.info(
    `[instrument-metadata] batch complete — enriched: ${enriched}, no-data: ${skipped}, total attempted: ${toEnrich.length}`,
  );
  return enriched;
}
