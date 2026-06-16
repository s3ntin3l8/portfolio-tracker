import type {
  AssetClass,
  Candle,
  InstrumentRef,
  InstrumentSearchResult,
  MarketDataProvider,
  Quote,
} from "./types.js";

export interface CoinGeckoOptions {
  baseUrl?: string;
  /** Free Demo API key — keyless works at a lower rate limit, a key raises it. */
  apiKey?: string;
  fetch?: typeof fetch;
}

/** Our internal market for crypto holdings; CoinGecko serves any currency on it. */
export const CRYPTO_MARKET = "CRYPTO";

interface CoinGeckoSearchCoin {
  id?: string;
  symbol?: string;
  name?: string;
}

/** Map a history `range` token (or a bare day count) to CoinGecko's `days` param. */
function rangeToDays(range: string): string {
  const tokens: Record<string, string> = {
    "1d": "1",
    "5d": "5",
    "1mo": "30",
    "3mo": "90",
    "6mo": "180",
    "1y": "365",
    "2y": "730",
    "5y": "1825",
    max: "max",
  };
  if (tokens[range]) return tokens[range];
  // Already a number (TwelveData-style outputsize) or unknown → pass through, default 365.
  return /^\d+$/.test(range) ? range : "365";
}

/**
 * CoinGecko provider — the crypto price/history source. The free public API works
 * keyless (low rate limit); a Demo `COINGECKO_API_KEY` (sent as `x-cg-demo-api-key`)
 * raises it. Instruments store the **ticker** (e.g. `BTC`) as their symbol; CoinGecko's
 * price/history endpoints key on a coin *id* (e.g. `bitcoin`), so we resolve ticker → id
 * via `/search` and memoise it (mirroring Yahoo's ISIN→symbol cache). Prices are returned
 * in the instrument's own `currency` via `vs_currency`, so an IDR-denominated coin needs
 * no FX hop.
 */
export class CoinGeckoProvider implements MarketDataProvider {
  readonly name = "coingecko";
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly doFetch: typeof fetch;
  /** Memoised ticker → coin-id resolution (caches misses as `null`). */
  private readonly idCache = new Map<string, string | null>();

  constructor(opts: CoinGeckoOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "https://api.coingecko.com/api/v3";
    this.apiKey = opts.apiKey;
    this.doFetch = opts.fetch ?? globalThis.fetch;
  }

  supports(assetClass: AssetClass): boolean {
    return assetClass === "crypto";
  }

  private fetchJson(path: string): Promise<Response> {
    const headers = this.apiKey ? { "x-cg-demo-api-key": this.apiKey } : undefined;
    return this.doFetch(`${this.baseUrl}${path}`, headers ? { headers } : undefined);
  }

  /** Resolve a ticker (BTC) to a CoinGecko coin id (bitcoin) via `/search`, memoised. */
  private async resolveId(symbol: string): Promise<string | null> {
    const ticker = symbol.trim().toLowerCase();
    if (!ticker) return null;
    const cached = this.idCache.get(ticker);
    if (cached !== undefined) return cached;

    let id: string | null = null;
    const res = await this.fetchJson(`/search?query=${encodeURIComponent(ticker)}`);
    if (res.ok) {
      const data = (await res.json()) as { coins?: CoinGeckoSearchCoin[] };
      // `/search` ranks by market-cap; take the first exact symbol match so "BTC" → bitcoin
      // rather than a low-cap coin that merely contains the query in its name.
      const match = (data.coins ?? []).find((c) => c.symbol?.toLowerCase() === ticker);
      id = match?.id ?? null;
    }
    this.idCache.set(ticker, id);
    return id;
  }

  async getQuote(ref: InstrumentRef): Promise<Quote | null> {
    const id = await this.resolveId(ref.symbol);
    if (!id) return null;
    const vs = ref.currency.toLowerCase();
    const res = await this.fetchJson(
      `/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=${encodeURIComponent(vs)}` +
        `&include_24hr_change=true&include_last_updated_at=true`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as Record<
      string,
      Record<string, number> & { last_updated_at?: number }
    >;
    const row = data[id];
    const price = row?.[vs];
    if (price === undefined || price === null) return null;

    const change = row[`${vs}_24h_change`];
    const previousClose =
      typeof change === "number" && Number.isFinite(change)
        ? String(price / (1 + change / 100))
        : null;
    const asOf = row.last_updated_at
      ? new Date(row.last_updated_at * 1000).toISOString()
      : new Date().toISOString();
    return { price: String(price), currency: ref.currency, asOf, previousClose };
  }

  async getHistory(ref: InstrumentRef, range = "1y"): Promise<Candle[]> {
    const id = await this.resolveId(ref.symbol);
    if (!id) return [];
    const vs = ref.currency.toLowerCase();
    const res = await this.fetchJson(
      `/coins/${encodeURIComponent(id)}/market_chart?vs_currency=${encodeURIComponent(vs)}` +
        `&days=${rangeToDays(range)}&interval=daily`,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { prices?: [number, number][] };
    return (data.prices ?? [])
      .filter(([, close]) => close !== null && close !== undefined)
      .map(([ms, close]) => ({
        date: new Date(ms).toISOString().slice(0, 10),
        close: String(close),
      }));
  }

  async search(query: string): Promise<InstrumentSearchResult[]> {
    const res = await this.fetchJson(`/search?query=${encodeURIComponent(query)}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { coins?: CoinGeckoSearchCoin[] };
    const out: InstrumentSearchResult[] = [];
    for (const c of data.coins ?? []) {
      if (!c.symbol) continue;
      out.push({
        // Store the ticker; quotes/history resolve it back to the coin id at call time.
        symbol: c.symbol.toUpperCase(),
        name: c.name ?? c.symbol.toUpperCase(),
        market: CRYPTO_MARKET,
        assetClass: "crypto",
        // Crypto is conventionally USD-denominated; the form lets the user switch to IDR.
        currency: "USD",
        source: this.name,
      });
    }
    return out;
  }
}
