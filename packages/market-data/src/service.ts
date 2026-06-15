import type {
  AssetClass,
  Candle,
  InstrumentRef,
  InstrumentSearchResult,
  MarketDataProvider,
  Quote,
} from "./types.js";
import { assetClassFromType, mapExchange } from "./instrument-mapping.js";
import { isIsin } from "./types.js";

const MAX_SEARCH_RESULTS = 10;

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

  /**
   * Discover instruments by free-text ticker/name, or resolve a 12-char ISIN. Fans out
   * across **all** providers that can search/resolve (search is not `supports`-gated),
   * merges the results, and dedupes by ISIN (else `market:symbol`) keeping the first
   * provider in registration order — so a keyed primary's richer metadata wins over a
   * keyless fallback's. A failing provider is skipped, never fatal.
   */
  async search(query: string): Promise<InstrumentSearchResult[]> {
    const q = query.trim();
    if (!q) return [];

    const collected: InstrumentSearchResult[] = [];
    for (const provider of this.providers) {
      try {
        if (isIsin(q)) {
          const resolved = await provider.resolveISIN?.(q);
          if (resolved) {
            collected.push(this.fromResolvedIsin(provider, q, resolved));
          }
        } else {
          const results = (await provider.search?.(q)) ?? [];
          collected.push(...results);
        }
      } catch {
        // A provider that errors or times out shouldn't sink the whole lookup.
      }
    }

    return this.dedupe(collected).slice(0, MAX_SEARCH_RESULTS);
  }

  /** Turn a bare ISIN resolution (symbol + exchange) into a full search result. */
  private fromResolvedIsin(
    provider: MarketDataProvider,
    isin: string,
    resolved: { symbol: string; exchange: string; name?: string; type?: string },
  ): InstrumentSearchResult {
    const info = mapExchange(resolved.exchange);
    return {
      symbol: resolved.symbol,
      name: resolved.name ?? resolved.symbol,
      market: info?.market ?? resolved.exchange,
      assetClass: assetClassFromType(resolved.type),
      currency: info?.currency ?? "USD",
      isin,
      source: provider.name,
    };
  }

  private dedupe(results: InstrumentSearchResult[]): InstrumentSearchResult[] {
    const seen = new Set<string>();
    const out: InstrumentSearchResult[] = [];
    for (const r of results) {
      const key = r.isin ? `isin:${r.isin}` : `${r.market}:${r.symbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
    return out;
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
