import { and, eq } from "drizzle-orm";
import { instruments } from "@portfolio/db";
import type { InstrumentInput } from "@portfolio/schema";
import type { DB } from "../db/client.js";

type Instrument = typeof instruments.$inferSelect;

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
    if (byIsin) return byIsin;
  }

  const [existing] = await db
    .select()
    .from(instruments)
    .where(
      and(eq(instruments.symbol, input.symbol), eq(instruments.market, input.market)),
    )
    .limit(1);
  if (existing) return existing;

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
