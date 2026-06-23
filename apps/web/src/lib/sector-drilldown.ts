import { normalizeSector } from "@portfolio/core";

// These helpers are internal to @portfolio/core; re-implement here to avoid
// exporting them from the core package just for the web drill-down UI.
const MARKET_TO_REGION: Record<string, string> = {
  IDX: "ID", BEI: "ID", XETRA: "EU", XFRA: "EU", FSX: "EU", AMS: "EU",
  NYSE: "US", NASDAQ: "US", US: "US", NASDAQ_GS: "US", NASDAQ_GM: "US",
  XAU: "Commodity", AMEX: "US", TSX: "CA", ASX: "AU", SGX: "SG", HKG: "HK", TYO: "JP",
};

export function marketToRegion(market: string): string {
  return MARKET_TO_REGION[market.toUpperCase()] ?? "Other";
}

const COUNTRY_TO_REGION: Record<string, string> = {
  "United States": "US", Canada: "CA",
  Germany: "EU", France: "EU", "United Kingdom": "EU", Italy: "EU", Spain: "EU",
  Netherlands: "EU", Switzerland: "EU", Austria: "EU", Belgium: "EU", Denmark: "EU",
  Finland: "EU", Ireland: "EU", Luxembourg: "EU", Norway: "EU", Poland: "EU",
  Portugal: "EU", Sweden: "EU", Czechia: "EU", Greece: "EU", Hungary: "EU",
  Romania: "EU", Turkey: "EU",
  Japan: "JP", China: "Asia", India: "Asia", "South Korea": "Asia", Taiwan: "Asia",
  "Hong Kong": "HK", Singapore: "SG", Thailand: "Asia", Indonesia: "ID",
  Malaysia: "Asia", Philippines: "Asia", Vietnam: "Asia",
  Australia: "AU", Brazil: "Other", "South Africa": "Other", Mexico: "Other",
  "United Arab Emirates": "Other", "Saudi Arabia": "Other",
};

export function countryToRegion(country: string): string {
  return COUNTRY_TO_REGION[country] ?? "Other";
}

/** Minimal instrument metadata needed for drill-down. */
export interface DrillDownInstrument {
  instrumentId: string;
  instrument: {
    symbol: string;
    assetClass: string;
    market: string;
    sector?: string | null;
    sectorWeights?: Record<string, number> | null;
    countryWeights?: Record<string, number> | null;
  } | null;
  marketValueDisplay: string | null;
}

/** A single slice in the drill-down sub-donut. */
export interface DrillDownSlice {
  key: string;
  name: string;
  value: number;
}

/**
 * Get instruments (or country weights) that contribute to a specific allocation slice.
 *
 * For region drill-down: decomposes ETFs with countryWeights into individual countries
 * that map to the selected region. Falls back to listing venue when no countryWeights.
 *
 * For sector drill-down: decomposes ETFs with sectorWeights into individual sectors.
 *
 * For other dimensions: returns instruments matching the selected key.
 */
export function getDrillDownInstruments(
  holdings: Array<{
    instrumentId: string;
    instrument: {
      symbol: string;
      assetClass: string;
      market: string;
      sector?: string | null;
      sectorWeights?: Record<string, number> | null;
      countryWeights?: Record<string, number> | null;
    } | null;
    marketValueDisplay: string | null;
  }>,
  dimension: "asset_class" | "currency" | "region" | "sector",
  selectedKey: string,
): DrillDownSlice[] {
  const result: DrillDownSlice[] = [];

  for (const h of holdings) {
    if (h.marketValueDisplay == null || h.instrument == null) continue;
    const mv = Number(h.marketValueDisplay);
    if (!Number.isFinite(mv) || mv <= 0) continue;

    const m = h.instrument;

    let contribution = 0;

    switch (dimension) {
      case "asset_class":
        if (m.assetClass === selectedKey) {
          contribution = mv;
          result.push({ key: h.instrumentId, name: m.symbol, value: contribution });
        }
        break;

      case "region":
        // Check if ETF has countryWeights for detailed breakdown
        if (m.assetClass === "etf" && m.countryWeights) {
          let sumW = 0;
          for (const [country, w] of Object.entries(m.countryWeights)) {
            if (countryToRegion(country) === selectedKey && typeof w === "number" && w > 0) {
              contribution = mv * w;
              result.push({ key: country, name: country, value: contribution });
              sumW += w;
            }
          }
          // Remainder (unclassified countries) goes to listing venue region
          if (sumW < 0.9999 && marketToRegion(m.market) === selectedKey) {
            const remainder = mv * (1 - sumW);
            if (remainder > 0) {
              result.push({ key: `${h.instrumentId}-remainder`, name: m.symbol, value: remainder });
            }
          }
        } else {
          // Fallback: use listing venue
          if (marketToRegion(m.market) === selectedKey) {
            contribution = mv;
            result.push({ key: h.instrumentId, name: m.symbol, value: contribution });
          }
        }
        break;

      case "sector":
        // ETFs with sectorWeights: decompose proportionally
        if (m.assetClass === "etf" && m.sectorWeights) {
          let sumW = 0;
          for (const [sector, w] of Object.entries(m.sectorWeights)) {
            if (normalizeSector(sector) === selectedKey && typeof w === "number" && w > 0) {
              contribution = mv * w;
              result.push({ key: sector, name: sector, value: contribution });
              sumW += w;
            }
          }
          // Remainder goes to "Other"
          if (sumW < 0.9999 && selectedKey === "Other") {
            const remainder = mv * (1 - sumW);
            if (remainder > 0) {
              result.push({ key: `${h.instrumentId}-other`, name: m.symbol, value: remainder });
            }
          }
        } else if (m.sector) {
          // Single sector
          if (normalizeSector(m.sector) === selectedKey) {
            contribution = mv;
            result.push({ key: h.instrumentId, name: m.symbol, value: contribution });
          }
        } else if (selectedKey === "uncategorized") {
          contribution = mv;
          result.push({ key: h.instrumentId, name: m.symbol, value: contribution });
        }
        break;
    }
  }

  return result;
}
