import { Decimal } from "decimal.js";
import type { PortfolioSummary } from "./valuation.js";

/**
 * Instrument metadata needed for allocation breakdowns. Intentionally a
 * subset of the full instrument row — only the fields the breakdown uses.
 */
export interface AllocationInstrumentMeta {
  assetClass: string;
  /** IDX, XETRA, XAU, US, NYSE, NASDAQ, … — used to infer a region bucket. */
  market: string;
  /** GICS-style sector for individual stocks, or null when not yet enriched.
   *  For ETFs, use `sectorWeights` instead. */
  sector?: string | null;
  /**
   * Per-sector weights for ETFs (GICS-style sector name → fraction 0–1).
   * When present, the holding's market value is decomposed proportionally
   * across these sectors in `bySector`. The remainder (1 − Σw) is attributed
   * to an "Other" bucket so the slices still reconcile to the holding's value.
   * Null/absent for non-ETF instruments.
   */
  sectorWeights?: Record<string, number> | null;
  /** Timestamp of last enrichment attempt. Null = never attempted. */
  sectorCheckedAt?: Date | string | null;
  /** Human-readable name, used for topHoldings labelling. */
  name?: string;
}

/** A single allocation slice: one category in a dimension breakdown. */
export interface AllocationSlice {
  /** Canonical category identifier (asset-class key, currency code, region name, sector, …). */
  key: string;
  /** Value in the display currency (decimal string). */
  value: string;
  /** Share of total, 0–100, rounded to 4 dp. */
  pct: number;
}

/** An individual holding ranked by portfolio weight. */
export interface TopHolding {
  instrumentId: string;
  name?: string;
  assetClass?: string;
  /** Market value in the display currency (decimal string). */
  value: string;
  /** Share of total, 0–100, rounded to 4 dp. */
  pct: number;
}

/** HHI-derived concentration summary. */
export interface ConcentrationInfo {
  /**
   * Herfindahl-Hirschman Index on the 0–10 000 scale (Σ shareᵢ² where shareᵢ is in
   * percent 0–100). Pure-monopoly = 10 000, ten equal holdings = 1 000.
   */
  hhi: number;
  /** Largest single holding's share, 0–100. */
  top1Pct: number;
  /** Combined share of the five largest holdings, 0–100. */
  top5Pct: number;
  /** Human-readable concentration label. */
  label: "diversified" | "moderate" | "concentrated";
}

/** Full allocation breakdown across four dimensions + concentration analytics. */
export interface AllocationBreakdown {
  byAssetClass: AllocationSlice[];
  byCurrency: AllocationSlice[];
  byRegion: AllocationSlice[];
  bySector: AllocationSlice[];
  topHoldings: TopHolding[];
  concentration: ConcentrationInfo;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Maps an instrument's `market` code to a geographic region bucket. The list
 * is intentionally kept short — new markets fall through to "Other".
 */
const MARKET_TO_REGION: Record<string, string> = {
  IDX: "ID",
  BEI: "ID", // Bursa Efek Indonesia (bonds / fixed-income market)
  XETRA: "EU",
  XFRA: "EU",
  FSX: "EU",
  AMS: "EU",
  NYSE: "US",
  NASDAQ: "US",
  US: "US",
  NASDAQ_GS: "US",
  NASDAQ_GM: "US",
  XAU: "Commodity", // gold / precious metals
  AMEX: "US",
  TSX: "CA",
  ASX: "AU",
  SGX: "SG",
  HKG: "HK",
  TYO: "JP",
};

/**
 * Maps an ISO 4217 currency to a rough geographic region, used to attribute
 * cash balances in the region breakdown when no instrument market is available.
 */
const CURRENCY_TO_REGION: Record<string, string> = {
  IDR: "ID",
  EUR: "EU",
  USD: "US",
  GBP: "EU",
  CHF: "EU",
  NOK: "EU",
  SEK: "EU",
  DKK: "EU",
  CAD: "CA",
  AUD: "AU",
  SGD: "SG",
  HKD: "HK",
  JPY: "JP",
  CNY: "Asia",
};

export function marketToRegion(market: string): string {
  return MARKET_TO_REGION[market.toUpperCase()] ?? "Other";
}

function currencyToRegion(currency: string): string {
  return CURRENCY_TO_REGION[currency.toUpperCase()] ?? "Other";
}

function add(map: Map<string, Decimal>, key: string, val: Decimal): void {
  map.set(key, (map.get(key) ?? new Decimal(0)).add(val));
}

function toPct(slice: Decimal, total: Decimal): number {
  if (total.isZero()) return 0;
  return slice.div(total).mul(100).toDecimalPlaces(4).toNumber();
}

function sortedSlices(map: Map<string, Decimal>, total: Decimal): AllocationSlice[] {
  return [...map.entries()]
    .map(([key, val]) => ({ key, value: val.toString(), pct: toPct(val, total) }))
    .sort((a, b) => b.pct - a.pct);
}

/**
 * Canonical sector name aliases. EODHD's stock `General.Sector` taxonomy and
 * its ETF `Sector_Weights` taxonomy use slightly different names for the same
 * sectors (e.g. "Financial Services" in ETF data vs "Financials" in stock data).
 * This map folds the variants onto a single canonical label so sectors from
 * different instruments compare and aggregate correctly.
 */
const SECTOR_ALIAS_MAP: Record<string, string> = {
  "Financial Services": "Financials",
  "Consumer Defensive": "Consumer Staples",
  "Consumer Cyclical": "Consumer Discretionary",
  "Communication Services": "Communication",
  "Basic Materials": "Materials",
  "Real Estate": "Real Estate", // keep as-is but ensure consistent casing
  Utilities: "Utilities",
  Industrials: "Industrials",
  Healthcare: "Health Care",
  "Health Care": "Health Care",
};

/** Return the canonical GICS-style sector name, collapsing known provider aliases. */
export function normalizeSector(name: string): string {
  return SECTOR_ALIAS_MAP[name] ?? name;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Break down an already-valued `PortfolioSummary` into allocation slices along
 * four dimensions: asset class, currency, region, and sector. Also computes a
 * ranked top-holdings list and concentration metrics.
 *
 * Accepts both a `Map<id, meta>` (as returned by `valuePortfolio`) and a plain
 * `Record<id, meta>` (tests / ad-hoc callers) to mirror the `computeTrades` API.
 *
 * All monetary outputs are decimal strings in the portfolio's `displayCurrency`.
 *
 * ## Cash handling
 * Cash is included as its own `"cash"` asset-class slice and is attributed to the
 * region breakdown by its currency (e.g. IDR → "ID", EUR → "EU"). Cash is excluded
 * from the sector breakdown (no GICS sector applies to uninvested cash).
 *
 * ## Unpriced holdings
 * Holdings with `marketValueDisplay === null` are excluded from the breakdown.
 * Their cost basis is already captured in `exposureByCurrency` only when priced,
 * so the denominator is consistent with the numerators.
 *
 * ## Total denominator
 * The denominator for all percentages is the sum of `exposureByCurrency` values
 * — the total priced asset value in the display currency (holdings + cash, before
 * netting liabilities).
 */
export function allocationBreakdown(
  summary: PortfolioSummary,
  instruments: Map<string, AllocationInstrumentMeta> | Record<string, AllocationInstrumentMeta>,
): AllocationBreakdown {
  const meta = (id: string): AllocationInstrumentMeta | undefined =>
    instruments instanceof Map ? instruments.get(id) : instruments[id];

  // Total portfolio value denominator (display currency).
  const total = Object.values(summary.exposureByCurrency).reduce(
    (acc, v) => acc.add(v),
    new Decimal(0),
  );

  // --- Holdings pass ----------------------------------------------------
  const byAssetClass = new Map<string, Decimal>();
  const byRegion = new Map<string, Decimal>();
  const bySector = new Map<string, Decimal>();

  // Per-currency sum of priced holdings (display currency), used to derive the
  // per-currency cash component below.
  const holdingsByCcy = new Map<string, Decimal>();

  let holdingsTotal = new Decimal(0);

  const pricedHoldings: Array<{
    instrumentId: string;
    name: string | undefined;
    assetClass: string | undefined;
    mv: Decimal;
  }> = [];

  for (const h of summary.holdings) {
    if (h.marketValueDisplay == null) continue;
    const mv = new Decimal(h.marketValueDisplay);
    const m = meta(h.instrumentId);

    add(byAssetClass, m?.assetClass ?? "unknown", mv);
    add(byRegion, marketToRegion(m?.market ?? ""), mv);

    // Sector: ETFs decompose proportionally across their constituent weights;
    // stocks use the single sector field; uncategorized when neither is set.
    if (m?.sectorWeights && Object.keys(m.sectorWeights).length > 0) {
      let sumW = 0;
      for (const [sector, w] of Object.entries(m.sectorWeights)) {
        if (w > 0) {
          add(bySector, normalizeSector(sector), mv.mul(w));
          sumW += w;
        }
      }
      // Remainder (cash / unclassified within the ETF) goes to "Other".
      if (sumW < 0.9999) {
        add(bySector, "Other", mv.mul(1 - sumW));
      }
    } else if (m?.sector) {
      add(bySector, normalizeSector(m.sector), mv);
    } else {
      add(bySector, "uncategorized", mv);
    }

    if (h.currency != null) {
      add(holdingsByCcy, h.currency, mv);
    }

    holdingsTotal = holdingsTotal.add(mv);
    pricedHoldings.push({ instrumentId: h.instrumentId, name: m?.name, assetClass: m?.assetClass, mv });
  }

  // --- Cash pass -------------------------------------------------------
  // Cash display value by currency = exposureByCurrency[ccy] − priced holdings in ccy.
  // This avoids re-running FX conversion; the arithmetic is exact in display units.
  let cashTotal = new Decimal(0);
  for (const [ccy, exposureDisplay] of Object.entries(summary.exposureByCurrency)) {
    const holdingsInCcy = holdingsByCcy.get(ccy) ?? new Decimal(0);
    const cashInCcy = new Decimal(exposureDisplay).sub(holdingsInCcy);
    if (cashInCcy.gt(0)) {
      add(byRegion, currencyToRegion(ccy), cashInCcy);
      cashTotal = cashTotal.add(cashInCcy);
    }
  }
  if (cashTotal.gt(0)) {
    add(byAssetClass, "cash", cashTotal);
  }

  // --- Currency breakdown -----------------------------------------------
  // Directly from exposureByCurrency — the most accurate representation already
  // computed by summarizePortfolio/aggregatePortfolios.
  const byCurrencyMap = new Map<string, Decimal>(
    Object.entries(summary.exposureByCurrency)
      .filter(([, v]) => new Decimal(v).gt(0))
      .map(([k, v]) => [k, new Decimal(v)]),
  );

  // --- Top holdings -----------------------------------------------------
  // Ranked by display-currency market value, capped at 20 for UI.
  const topHoldings: TopHolding[] = pricedHoldings
    .sort((a, b) => b.mv.comparedTo(a.mv))
    .slice(0, 20)
    .map((h) => ({
      instrumentId: h.instrumentId,
      name: h.name,
      assetClass: h.assetClass,
      value: h.mv.toString(),
      pct: toPct(h.mv, total),
    }));

  return {
    byAssetClass: sortedSlices(byAssetClass, total),
    byCurrency: sortedSlices(byCurrencyMap, total),
    byRegion: sortedSlices(byRegion, total),
    bySector: sortedSlices(bySector, total),
    topHoldings,
    concentration: concentration(topHoldings),
  };
}

/**
 * Compute HHI-based concentration metrics for a ranked holdings list.
 * Accepts the `topHoldings` array from `allocationBreakdown` (pcts in 0–100).
 */
export function concentration(holdings: TopHolding[]): ConcentrationInfo {
  // HHI = Σ sᵢ² where sᵢ is the share in percent (0–100). Range: 0–10 000.
  const hhi = Math.round(holdings.reduce((acc, h) => acc + h.pct * h.pct, 0));
  const top1Pct = holdings[0]?.pct ?? 0;
  const top5Pct = holdings.slice(0, 5).reduce((a, h) => a + h.pct, 0);

  let label: ConcentrationInfo["label"];
  if (hhi < 1500) label = "diversified";
  else if (hhi < 2500) label = "moderate";
  else label = "concentrated";

  return { hhi, top1Pct, top5Pct, label };
}
