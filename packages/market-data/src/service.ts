import type {
  AssetClass,
  Candle,
  InstrumentRef,
  MarketDataProvider,
  Quote,
} from "./types.js";

/**
 * Routes quote/history requests to the providers that support the instrument's asset
 * class + market, trying them in registration order until one returns a result. This
 * makes a keyed primary + keyless fallback (e.g. Twelve Data → Yahoo → fixture)
 * resilient: if the primary is rate-limited or 404s, the next supporter is tried.
 */
export class MarketDataService {
  constructor(private readonly providers: MarketDataProvider[]) {}

  /** First provider supporting the asset class/market (registration order). */
  providerFor(assetClass: AssetClass, market: string): MarketDataProvider | null {
    return this.providers.find((p) => p.supports(assetClass, market)) ?? null;
  }

  /** All providers supporting the asset class/market, in registration order. */
  private providersFor(assetClass: AssetClass, market: string): MarketDataProvider[] {
    return this.providers.filter((p) => p.supports(assetClass, market));
  }

  async getQuote(ref: InstrumentRef): Promise<Quote | null> {
    for (const provider of this.providersFor(ref.assetClass, ref.market)) {
      const quote = await provider.getQuote(ref);
      if (quote) return quote;
    }
    return null;
  }

  async getHistory(ref: InstrumentRef, range: string): Promise<Candle[]> {
    for (const provider of this.providersFor(ref.assetClass, ref.market)) {
      const candles = (await provider.getHistory?.(ref, range)) ?? [];
      if (candles.length > 0) return candles;
    }
    return [];
  }

  /** Quote several instruments, keyed by an id you supply (e.g. instrument id). */
  async getQuotes(
    refs: Array<{ id: string; ref: InstrumentRef }>,
  ): Promise<Record<string, Quote>> {
    const out: Record<string, Quote> = {};
    await Promise.all(
      refs.map(async ({ id, ref }) => {
        const quote = await this.getQuote(ref);
        if (quote) out[id] = quote;
      }),
    );
    return out;
  }
}
