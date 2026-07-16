import type {
  AssetClass,
  Candle,
  DividendEvent,
  InstrumentFundamentals,
  InstrumentProfile,
  InstrumentRef,
  InstrumentSearchResult,
  MarketDataProvider,
  Quote,
} from "./types.js";
import { assetClassFromType, mapExchange } from "./instrument-mapping.js";
import { isIsin, isWkn } from "./types.js";

const MAX_SEARCH_RESULTS = 10;

/** Optional instrumentation, e.g. to count API calls per provider for usage tracking. */
export interface MarketDataServiceOptions {
  /** Fired with the provider name immediately before each provider method invocation. */
  onCall?: (providerName: string) => void;
}

/**
 * Routes quote/history requests to the providers that support the instrument's asset
 * class + market, trying them in registration order until one returns a result. This
 * makes a keyed primary + keyless fallback (e.g. Twelve Data → Yahoo → fixture)
 * resilient: if the primary is rate-limited or 404s, the next supporter is tried.
 */
export class MarketDataService {
  constructor(
    private readonly providers: MarketDataProvider[],
    private readonly opts: MarketDataServiceOptions = {},
  ) {}

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
      try {
        this.opts.onCall?.(provider.name);
        const quote = await provider.getQuote(ref);
        if (quote) return quote;
      } catch {
        // A failing/timing-out provider shouldn't block the fallback chain — try the next.
      }
    }
    return null;
  }

  async getHistory(ref: InstrumentRef, range: string): Promise<Candle[]> {
    for (const provider of this.providersFor(ref.assetClass, ref.market)) {
      if (!provider.getHistory) continue;
      this.opts.onCall?.(provider.name);
      const candles = (await provider.getHistory(ref, range)) ?? [];
      if (candles.length > 0) return candles;
    }
    return [];
  }

  async getHistoryFrom(ref: InstrumentRef, fromDate: string): Promise<Candle[]> {
    for (const provider of this.providersFor(ref.assetClass, ref.market)) {
      if (!provider.getHistoryFrom) continue;
      this.opts.onCall?.(provider.name);
      const candles = (await provider.getHistoryFrom(ref, fromDate)) ?? [];
      if (candles.length > 0) return candles;
    }
    // Fallback: try getHistory with max range if no provider supports getHistoryFrom
    return this.getHistory(ref, "max");
  }

  async getDividends(ref: InstrumentRef, fromDate?: string): Promise<DividendEvent[]> {
    for (const provider of this.providersFor(ref.assetClass, ref.market)) {
      if (!provider.getDividends) continue;
      this.opts.onCall?.(provider.name);
      const events = (await provider.getDividends(ref, fromDate)) ?? [];
      if (events.length > 0) return events;
    }
    return [];
  }

  /**
   * Fetch instrument profile metadata (sector, industry, country). Calls ALL
   * supporting providers and merges their results — different providers return
   * different fields (e.g. EODHD returns sectorWeights, JustETF returns
   * countryWeights), so merging gives a complete picture.
   */
  async getProfile(ref: InstrumentRef): Promise<InstrumentProfile | null> {
    const parts: InstrumentProfile[] = [];
    for (const provider of this.providersFor(ref.assetClass, ref.market)) {
      if (!provider.getProfile) continue;
      try {
        this.opts.onCall?.(provider.name);
        const profile = await provider.getProfile(ref);
        if (profile != null) parts.push(profile);
      } catch {
        // A failing provider shouldn't block the others.
      }
    }
    if (parts.length === 0) return null;
    return Object.assign({}, ...parts);
  }

  /**
   * Fetch fundamental/valuation data (market cap, PE, EPS, dividend yield, analyst
   * recommendations, revenue-vs-earnings, next earnings date) for the instrument detail
   * view. Unlike `getProfile`, this is first-match-wins (not merged) — the returned
   * `currency` labels every monetary field, and merging across providers would risk
   * mixing currencies. Only Yahoo implements it today; kept as a loop for future providers.
   */
  async getFundamentals(ref: InstrumentRef): Promise<InstrumentFundamentals | null> {
    for (const provider of this.providersFor(ref.assetClass, ref.market)) {
      if (!provider.getFundamentals) continue;
      try {
        this.opts.onCall?.(provider.name);
        const fundamentals = await provider.getFundamentals(ref);
        if (fundamentals) return fundamentals;
      } catch {
        // A failing provider shouldn't block the fallback chain — try the next.
      }
    }
    return null;
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
    // Track whether a WKN query resolved anything, so we can fall through to name search.
    let wknResolved = false;
    for (const provider of this.providers) {
      try {
        if (isIsin(q)) {
          if (!provider.resolveISIN) continue;
          this.opts.onCall?.(provider.name);
          const resolved = await provider.resolveISIN(q);
          if (resolved) {
            collected.push(this.fromResolvedIsin(provider, q, resolved));
          }
        } else if (isWkn(q) && provider.resolveWKN) {
          this.opts.onCall?.(provider.name);
          const resolved = await provider.resolveWKN(q);
          if (resolved) {
            collected.push(this.fromResolvedWkn(provider, q, resolved));
            wknResolved = true;
          }
        } else if (!isWkn(q) || !wknResolved) {
          // Fall through to name/ticker search for non-WKN queries, or for alphanumeric
          // queries that looked like WKNs but resolved nothing (leniency).
          if (!provider.search) continue;
          this.opts.onCall?.(provider.name);
          const results = (await provider.search(q)) ?? [];
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
      assetClass: assetClassFromType(resolved.type, {
        symbol: resolved.symbol,
        market: info?.market,
      }),
      currency: info?.currency ?? "USD",
      isin,
      source: provider.name,
    };
  }

  /** Turn a bare WKN resolution (symbol + exchange) into a full search result. */
  private fromResolvedWkn(
    provider: MarketDataProvider,
    wkn: string,
    resolved: { symbol: string; exchange: string; name?: string; type?: string },
  ): InstrumentSearchResult {
    const info = mapExchange(resolved.exchange);
    return {
      symbol: resolved.symbol,
      name: resolved.name ?? resolved.symbol,
      market: info?.market ?? resolved.exchange,
      assetClass: assetClassFromType(resolved.type, {
        symbol: resolved.symbol,
        market: info?.market,
      }),
      currency: info?.currency ?? "USD",
      wkn,
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
  async getQuotes(refs: Array<{ id: string; ref: InstrumentRef }>): Promise<Record<string, Quote>> {
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
