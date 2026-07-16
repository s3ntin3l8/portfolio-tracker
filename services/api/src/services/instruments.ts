import { and, eq } from "drizzle-orm";
import { instruments } from "@portfolio/db";
import { isIsin, isKnownMarket, PRICEABLE_FOREIGN_MARKETS } from "@portfolio/market-data";
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
  input: Omit<InstrumentInput, "isin" | "wkn"> & { isin?: string | null; wkn?: string | null },
): Partial<Pick<Instrument, "symbol" | "assetClass" | "market" | "currency" | "isin" | "wkn">> {
  const set: Partial<
    Pick<Instrument, "symbol" | "assetClass" | "market" | "currency" | "isin" | "wkn">
  > = {};
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
  // Re-pin a row stuck on the EU-broker default (Xetra/EUR) OR on an unrecognised market
  // (e.g. a legacy row with market "PE" from a raw provider exchange code) to its real
  // tradeable venue when a fresh import resolves one our providers price directly (US stocks,
  // crypto). The input-side guard on PRICEABLE_FOREIGN_MARKETS is intentional: if ISIN
  // resolution failed on re-import, input.market is XETRA — dropping the guard would trade
  // one bad market for another. Real EUR funds are never touched (their resolved market stays
  // XETRA/EUR, which is not in PRICEABLE_FOREIGN_MARKETS).
  if (
    (existing.market === "XETRA" && existing.currency === "EUR") ||
    !isKnownMarket(existing.market)
  ) {
    if (PRICEABLE_FOREIGN_MARKETS.has(input.market)) {
      set.market = input.market;
      set.currency = input.currency;
    }
  }
  // Back-fill missing ISIN/WKN when the input carries one.
  if (!existing.isin && input.isin) set.isin = input.isin;
  if (!existing.wkn && input.wkn) set.wkn = input.wkn;
  return set;
}

/** Apply an upgrade if non-empty, returning the (possibly updated) row. */
async function healInstrument(
  db: DB,
  existing: Instrument,
  input: Omit<InstrumentInput, "isin" | "wkn"> & { isin?: string | null; wkn?: string | null },
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
 * Optional dependencies for `findOrCreateInstrument`.
 *
 * @param resolveMarket - Best-effort callback: given an ISIN, returns the canonical
 *   `{ market, currency }` from an external registry (OpenFIGI). Called only when the
 *   input carries an ISIN whose market is not a recognised internal code. Failures and
 *   `null` results are silently ignored so a missing/rate-limited response never blocks
 *   an import.
 */
export interface FindOrCreateOpts {
  resolveMarket?: (isin: string) => Promise<{ market: string; currency: string } | null>;
}

/**
 * Find an instrument by ISIN, then WKN, then (market, symbol) identity, creating it if
 * absent. ISIN and WKN matches also back-fill the missing identifier on existing rows so
 * imports that arrive in any order converge to a single fully-identified row.
 *
 * Pass `opts.resolveMarket` to enable create-time market correction: when the input
 * carries an ISIN with an unrecognised market, the resolver is queried and its result
 * (if it returns a known market) replaces the input market and currency for both the
 * identity lookup and the new-row insert.
 */
export async function findOrCreateInstrument(
  db: DB,
  input: Omit<InstrumentInput, "isin" | "wkn"> & { isin?: string | null; wkn?: string | null },
  opts?: FindOrCreateOpts,
): Promise<Instrument> {
  if (input.isin) {
    const [byIsin] = await db
      .select()
      .from(instruments)
      .where(eq(instruments.isin, input.isin))
      .limit(1);
    if (byIsin) return healInstrument(db, byIsin, input);
  }

  if (input.wkn) {
    const [byWkn] = await db
      .select()
      .from(instruments)
      .where(eq(instruments.wkn, input.wkn))
      .limit(1);
    if (byWkn) return healInstrument(db, byWkn, input);
  }

  // Correct an unrecognised market before the (symbol, market) identity lookup and
  // the new-row insert. Gated on having an ISIN + an unrecognised market. The resolver
  // is only wired in non-test builds (it's not passed in PGlite tests), and its failures
  // are silently caught so a rate-limit or network error never blocks a confirm.
  let market = input.market;
  let currency = input.currency;
  if (opts?.resolveMarket && input.isin && !isKnownMarket(market)) {
    try {
      const r = await opts.resolveMarket(input.isin);
      if (r && isKnownMarket(r.market)) {
        market = r.market;
        currency = r.currency;
      }
    } catch {
      // best-effort; keep import-provided market
    }
  }

  const [existing] = await db
    .select()
    .from(instruments)
    .where(and(eq(instruments.symbol, input.symbol), eq(instruments.market, market)))
    .limit(1);
  if (existing) return healInstrument(db, existing, input);

  const [created] = await db
    .insert(instruments)
    .values({
      symbol: input.symbol,
      market,
      assetClass: input.assetClass,
      unit: input.unit,
      currency,
      name: input.name,
      isin: input.isin ?? null,
      wkn: input.wkn ?? null,
    })
    .returning();
  return created;
}

/**
 * Update a subset of an instrument's editable fields. Rejects with "conflict" when
 * an ISIN or WKN would collide with another existing row.
 */
export async function updateInstrument(
  db: DB,
  id: string,
  patch: {
    isin?: string | null;
    wkn?: string | null;
    symbol?: string;
    name?: string;
    assetClass?: string;
    market?: string;
  },
): Promise<Instrument | "conflict" | "not_found"> {
  const [existing] = await db.select().from(instruments).where(eq(instruments.id, id)).limit(1);
  if (!existing) return "not_found";

  // Guard uniqueness manually so we can return a typed error instead of a DB exception.
  if (patch.isin && patch.isin !== existing.isin) {
    const [clash] = await db
      .select()
      .from(instruments)
      .where(and(eq(instruments.isin, patch.isin)))
      .limit(1);
    if (clash && clash.id !== id) return "conflict";
  }
  if (patch.wkn && patch.wkn !== existing.wkn) {
    const [clash] = await db
      .select()
      .from(instruments)
      .where(and(eq(instruments.wkn, patch.wkn)))
      .limit(1);
    if (clash && clash.id !== id) return "conflict";
  }

  const set: Record<string, unknown> = {};
  if ("isin" in patch) set.isin = patch.isin ?? null;
  if ("wkn" in patch) set.wkn = patch.wkn ?? null;
  if (patch.symbol !== undefined) set.symbol = patch.symbol;
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.assetClass !== undefined) set.assetClass = patch.assetClass;
  if (patch.market !== undefined) set.market = patch.market;

  if (Object.keys(set).length === 0) return existing;

  const [updated] = await db.update(instruments).set(set).where(eq(instruments.id, id)).returning();
  return updated ?? existing;
}
