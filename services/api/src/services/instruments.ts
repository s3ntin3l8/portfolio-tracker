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
 * Find an instrument by its (market, symbol) identity, creating it if absent.
 * Instruments are shared reference data (not user-scoped); transactions reference
 * them by id. Used by manual entry and by confirmed screenshot/CSV imports.
 */
export async function findOrCreateInstrument(
  db: DB,
  input: Omit<InstrumentInput, "isin"> & { isin?: string | null },
): Promise<Instrument> {
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
