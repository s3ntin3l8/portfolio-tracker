import type {
  AssetClass,
  InstrumentRef,
  MarketDataProvider,
  Quote,
} from "./types.js";

/**
 * Deterministic provider backed by a static price map. Stands in for the live
 * providers (Sectors/iTick, GoldAPI, Antam, NAV feeds) until API keys are wired —
 * same interface, so it swaps out behind the MarketDataService.
 */
export class FixtureProvider implements MarketDataProvider {
  readonly name = "fixture";

  constructor(
    private readonly prices: Record<string, string> = DEFAULT_PRICES,
    private readonly asOf: string = "2026-02-08T00:00:00.000Z",
    private readonly prevCloses: Record<string, string> = DEFAULT_PREV_CLOSES,
  ) {}

  supports(_assetClass: AssetClass, _market: string): boolean {
    return true;
  }

  async getQuote(ref: InstrumentRef): Promise<Quote | null> {
    const price = this.prices[ref.symbol];
    if (price === undefined) return null;
    return {
      price,
      currency: ref.currency,
      asOf: this.asOf,
      previousClose: this.prevCloses[ref.symbol] ?? null,
    };
  }
}

const DEFAULT_PRICES: Record<string, string> = {
  BBCA: "9500",
  TLKM: "3800",
  GOLD: "1150000",
  ORI023: "100000",
  RDPU: "1200",
};

// Prior-session closes for the deterministic symbols, so day-change is testable.
const DEFAULT_PREV_CLOSES: Record<string, string> = {
  BBCA: "9000",
  TLKM: "3900",
  GOLD: "1140000",
};
