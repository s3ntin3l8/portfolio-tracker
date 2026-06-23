import type { HoldingValuation } from "@portfolio/api-client";
import { marketToRegion } from "@portfolio/core";

export type DrillDownDimension = "sector" | "region" | "currency" | "asset_class";

export interface DrillDownInstrument {
  key: string;
  name: string;
  value: number;
}

/**
 * Compute per-instrument breakdown for a given dimension + selected key.
 *
 * - **sector**: ETF decomposed by `sectorWeights[key] × mv`; equity filtered by `sector === key`
 * - **region**: `marketToRegion(instrument.market) === key` → `mv`
 * - **currency**: `instrument.currency === key` → `mv`
 * - **asset_class**: `instrument.assetClass === key` → `mv`
 *
 * Cash holdings (null instrument) are always excluded.
 */
export function getDrillDownInstruments(
  holdings: HoldingValuation[],
  dimension: DrillDownDimension,
  selectedKey: string,
): DrillDownInstrument[] {
  const result: DrillDownInstrument[] = [];

  for (const h of holdings) {
    if (!h.instrument || !h.marketValueDisplay) continue;
    const mv = Number(h.marketValueDisplay);
    if (!Number.isFinite(mv) || mv <= 0) continue;

    let contribution = 0;

    switch (dimension) {
      case "sector":
        if (h.instrument.assetClass === "etf" && h.instrument.sectorWeights) {
          const w = h.instrument.sectorWeights[selectedKey];
          if (typeof w === "number" && w > 0) {
            contribution = mv * w;
          }
        } else if (h.instrument.sector === selectedKey) {
          contribution = mv;
        }
        break;
      case "region":
        if (marketToRegion(h.instrument.market) === selectedKey) {
          contribution = mv;
        }
        break;
      case "currency":
        if (h.instrument.currency === selectedKey) {
          contribution = mv;
        }
        break;
      case "asset_class":
        if (h.instrument.assetClass === selectedKey) {
          contribution = mv;
        }
        break;
    }

    if (contribution > 0) {
      result.push({ key: h.instrumentId, name: h.instrument.symbol, value: contribution });
    }
  }

  return result.sort((a, b) => b.value - a.value);
}
