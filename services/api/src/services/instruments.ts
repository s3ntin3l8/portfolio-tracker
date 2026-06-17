import { and, eq } from "drizzle-orm";
import { instruments } from "@portfolio/db";
import { isIsin, PRICEABLE_FOREIGN_MARKETS } from "@portfolio/market-data";
import type { InstrumentInput } from "@portfolio/schema";
import type { DB } from "../db/client.js";

type Instrument = typeof instruments.$inferSelect;

/**
 * Fields an existing instrument should adopt from a fresh `input` when the input is
 * strictly better — so a row created before ISIN/asset-class resolution worked (e.g. an
 * ISIN stored as the symbol, or a UCITS ETF mislabelled `mutual_fund`) self-heals on the
 * next import instead of staying stuck. Only upgrades; never downgrades.
 */
function instrumentUpgrade(
  existing: Instrument,
  input: Omit<InstrumentInput, "isin"> & { isin?: string | null },
): Partial<Pick<Instrument, "symbol" | "assetClass" | "market" | "currency">> {
  const set: Partial<Pick<Instrument, "symbol" | "assetClass" | "market" | "currency">> = {};
  // Replace an ISIN-as-symbol with a real ticker (but never the reverse).
  if (isIsin(existing.symbol) && !isIsin(input.symbol)) set.symbol = input.symbol;
  // Refine the generic defaults (`equity`, `mutual_fund`) to a more specific class —
  // notably `mutual_fund` → `etf` — but don't clobber a specific class with the default.
  if (
    input.assetClass !== existing.assetClass &&
    input.assetClass !== "equity" &&
    (existing.assetClass === "equity" || existing.assetClass === "mutual_fund")
  )
    set.assetClass = input.assetClass;
  // Re-pin a row stuck on the EU-broker default (Xetra/EUR) to its real tradeable venue when a
  // fresh import resolves one our providers price directly (US stocks, crypto). Mirrors the
  // import adoption guard; only upgrades off the default, so real EUR funds are never touched.
  if (
    existing.market === "XETRA" &&
    existing.currency === "EUR" &&
    PRICEABLE_FOREIGN_MARKETS.has(input.market)
  ) {
    set.market = input.market;
    set.currency = input.currency;
  }
  return set;
}

/** Apply an upgrade if non-empty, returning the (possibly updated) row. */
async function healInstrument(
  db: DB,
  existing: Instrument,
  input: Omit<InstrumentInput, "isin"> & { isin?: string | null },
): Promise<Instrument> {
  const set = instrumentUpgrade(existing, input);
  if (Object.keys(set).length === 0) return existing;
  const [updated] = await db
    .update(instruments)
    .set(set)
    .where(eq(instruments.id, existing.id))
    .returning();
  return updated ?? existing;
}

/**
 * Default market for an asset class when the caller doesn't specify one. Gold
 * holdings use the Antam buyback market (valued at the buyback price); XAU spot is
 * reserved for the live ticker.
 */
export function marketForAssetClass(assetClass: string): string {
  return assetClass === "gold" ? "ANTAM" : "IDX";
}

/**
 * Default market for a security imported from a German broker (DKB depot). These trade
 * on Xetra in EUR; we don't rely on `marketForAssetClass` (which defaults to IDX) so the
 * Indonesian default stays untouched.
 */
export function marketForEuInstrument(_assetClass?: string | null): string {
  return "XETRA";
}

/**
 * Find an instrument by its ISIN (when given) or its (market, symbol) identity, creating
 * it if absent. Matching ISIN first means rows that reference the same security by ISIN
 * but a different symbol (e.g. a DKB buy resolved to a ticker and its later dividend) map
 * to a single instrument. Instruments are shared reference data (not user-scoped).
 */
export async function findOrCreateInstrument(
  db: DB,
  input: Omit<InstrumentInput, "isin"> & { isin?: string | null },
): Promise<Instrument> {
  if (input.isin) {
    const [byIsin] = await db
      .select()
      .from(instruments)
      .where(eq(instruments.isin, input.isin))
      .limit(1);
    if (byIsin) return healInstrument(db, byIsin, input);
  }

  const [existing] = await db
    .select()
    .from(instruments)
    .where(
      and(eq(instruments.symbol, input.symbol), eq(instruments.market, input.market)),
    )
    .limit(1);
  if (existing) return healInstrument(db, existing, input);

  const [created] = await db
    .insert(instruments)
    .values({
      symbol: input.symbol,
      market: input.market,
      assetClass: input.assetClass,
      unit: input.unit,
      currency: input.currency,
      name: input.name,
      isin: input.isin ?? null,
    })
    .returning();
  return created;
}
