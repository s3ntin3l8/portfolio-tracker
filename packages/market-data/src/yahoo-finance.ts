import type {
  AssetClass,
  Candle,
  InstrumentRef,
  InstrumentSearchResult,
  MarketDataProvider,
  Quote,
} from "./types.js";
import {
  assetClassFromType,
  mapExchange,
  yahooSuffixForMarket,
} from "./instrument-mapping.js";
import { isIsin } from "./types.js";

const TROY_OUNCE_GRAMS = 31.1034768;

export interface YahooProviderOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface ChartResult {
  meta?: {
    regularMarketPrice?: number;
    currency?: string;
    regularMarketTime?: number;
    previousClose?: number;
    chartPreviousClose?: number;
  };
  timestamp?: number[];
  indicators?: { quote?: { close?: (number | null)[] }[] };
}

/**
 * Yahoo Finance provider — a **keyless** IDX equity/ETF fallback (and crypto fallback
 * behind CoinGecko). Uses the auth-free chart endpoint (`/v8/finance/chart/<symbol>`)
 * for both quotes and history. IDX tickers map to Yahoo's `.JK` suffix (e.g. BBCA →
 * BBCA.JK); EU/Xetra tickers take `.DE`; crypto trades as `<TICKER>-<CURRENCY>` (BTC-USD);
 * gold spot trades as the currency pair `XAU<CURRENCY>=X` (per troy ounce, converted to a
 * per-gram price). When the symbol-based lookup misses and an ISIN is known, the search endpoint
 * resolves the ISIN to a Yahoo symbol (preferring the listing matching the instrument's
 * market/currency). Unofficial endpoint, so it's a resilience layer behind a keyed
 * primary (Twelve Data / EODHD), not the sole source.
 */
export class YahooFinanceProvider implements MarketDataProvider {
  readonly name = "yahoo";
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  /** Memoised ISIN → Yahoo symbol resolution (caches misses as `null`). */
  private readonly isinSymbolCache = new Map<string, string | null>();
  /**
   * Yahoo's unofficial chart/search endpoints return 429 ("Too Many Requests") for
   * requests that lack a browser-like User-Agent. Sending one brings it back to normal
   * behaviour (still gated only by IP-level rate limits, not the header itself).
   */
  private readonly defaultHeaders: Record<string, string>;

  constructor(opts: YahooProviderOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "https://query1.finance.yahoo.com";
    this.doFetch = opts.fetch ?? globalThis.fetch;
    this.defaultHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };
  }

  supports(assetClass: AssetClass, market: string): boolean {
    // Gold spot only (XAU); physical-gold holdings are valued at the Antam/Galeri24
    // buyback markets by their own providers, never here.
    if (assetClass === "gold") return market === "XAU";
    return assetClass === "equity" || assetClass === "etf" || assetClass === "crypto";
  }

  /**
   * Map an instrument to a Yahoo symbol via its market's suffix (IDX → `.JK`,
   * XETRA → `.DE`). Already-qualified symbols pass through; an ISIN stored as the
   * symbol gets no suffix (the ISIN-search fallback resolves it instead).
   */
  private yahooSymbol(ref: InstrumentRef): string {
    // Gold spot trades as the currency pair `XAU<CURRENCY>=X` (e.g. XAUUSD=X, XAUIDR=X),
    // priced per troy ounce in that currency — converted to per-gram in getQuote/getHistory.
    if (ref.assetClass === "gold") return `XAU${ref.currency}=X`;
    // Crypto trades as a `<TICKER>-<CURRENCY>` pair on Yahoo (e.g. BTC-USD, BTC-IDR).
    if (ref.assetClass === "crypto") return `${ref.symbol}-${ref.currency}`;
    if (ref.symbol.includes(".")) return ref.symbol;
    if (isIsin(ref.symbol)) return ref.symbol;
    const suffix = yahooSuffixForMarket(ref.market);
    return suffix ? `${ref.symbol}${suffix}` : ref.symbol;
  }

  private async chartBySymbol(symbol: string, range: string): Promise<ChartResult | null> {
    const res = await this.doFetch(
      `${this.baseUrl}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`,
      { headers: this.defaultHeaders },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      chart?: { result?: ChartResult[] | null; error?: unknown };
    };
    return data.chart?.result?.[0] ?? null;
  }

  private chart(ref: InstrumentRef, range: string): Promise<ChartResult | null> {
    return this.chartBySymbol(this.yahooSymbol(ref), range);
  }

  /**
   * Resolve an instrument's ISIN to a Yahoo symbol via the search endpoint, preferring the
   * listing whose venue matches the instrument's market, then its currency. A listing we
   * can't tie to the market or currency is rejected (no blind "first quote" fallback): the
   * quote stamps the result with `ref.currency`, so pricing an unrelated cross-listing — e.g.
   * a USD London line for a EUR holding — would silently store a wrong-currency value. Result
   * (incl. a miss) is memoised per ISIN.
   */
  private async resolveIsinSymbol(ref: InstrumentRef): Promise<string | null> {
    if (!ref.isin) return null;
    const cached = this.isinSymbolCache.get(ref.isin);
    if (cached !== undefined) return cached;

    const res = await this.doFetch(
      `${this.baseUrl}/v1/finance/search?q=${encodeURIComponent(ref.isin)}&quotesCount=10&newsCount=0`,
      { headers: this.defaultHeaders },
    );
    let symbol: string | null = null;
    if (res.ok) {
      const data = (await res.json()) as {
        quotes?: { symbol?: string; exchange?: string }[];
      };
      const quotes = (data.quotes ?? []).filter(
        (q): q is { symbol: string; exchange?: string } => Boolean(q.symbol),
      );
      const byMarket = quotes.find((q) => mapExchange(q.exchange)?.market === ref.market);
      const byCurrency = quotes.find(
        (q) => mapExchange(q.exchange)?.currency === ref.currency,
      );
      symbol = (byMarket ?? byCurrency)?.symbol ?? null;
    }
    this.isinSymbolCache.set(ref.isin, symbol);
    return symbol;
  }

  async getQuote(ref: InstrumentRef): Promise<Quote | null> {
    let result = await this.chart(ref, "1d");
    if ((result?.meta?.regularMarketPrice ?? null) === null && ref.isin) {
      const resolved = await this.resolveIsinSymbol(ref);
      if (resolved) result = await this.chartBySymbol(resolved, "1d");
    }
    const price = result?.meta?.regularMarketPrice;
    if (price === undefined || price === null) return null;
    const asOf = result?.meta?.regularMarketTime
      ? new Date(result.meta.regularMarketTime * 1000).toISOString()
      : new Date().toISOString();
    const prev = result?.meta?.previousClose ?? result?.meta?.chartPreviousClose;
    // Gold pairs quote per troy ounce; the rest of the app values gold per gram.
    const toGram = (v: number) =>
      ref.assetClass === "gold" ? v / TROY_OUNCE_GRAMS : v;
    return {
      price: String(toGram(price)),
      currency: ref.currency,
      asOf,
      previousClose: prev === undefined ? null : String(toGram(prev)),
    };
  }

  async search(query: string): Promise<InstrumentSearchResult[]> {
    // Keyless autocomplete endpoint. Returns cross-market matches; we keep only those
    // whose exchange maps to a currency we recognise (so the form can value them).
    const res = await this.doFetch(
      `${this.baseUrl}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0`,
      { headers: this.defaultHeaders },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      quotes?: {
        symbol?: string;
        shortname?: string;
        longname?: string;
        quoteType?: string;
        exchange?: string;
      }[];
    };
    const out: InstrumentSearchResult[] = [];
    for (const q of data.quotes ?? []) {
      if (!q.symbol) continue;
      const info = mapExchange(q.exchange);
      if (!info) continue; // unknown venue → no reliable currency, skip
      // IDX tickers come back as `BBCA.JK`; store the bare symbol (quotes re-add .JK).
      const symbol =
        info.market === "IDX" ? q.symbol.replace(/\.JK$/i, "") : q.symbol;
      out.push({
        symbol,
        name: q.longname ?? q.shortname ?? symbol,
        market: info.market,
        assetClass: assetClassFromType(q.quoteType),
        currency: info.currency,
        source: this.name,
      });
    }
    return out;
  }

  async getHistory(ref: InstrumentRef, range = "1mo"): Promise<Candle[]> {
    const result = await this.chart(ref, range);
    const timestamps = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    // Gold pairs quote per troy ounce; convert each close to per-gram like the quote path.
    const factor = ref.assetClass === "gold" ? TROY_OUNCE_GRAMS : 1;
    const candles: Candle[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      if (close === null || close === undefined) continue;
      candles.push({
        date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
        close: factor === 1 ? String(close) : String(close / factor),
      });
    }
    return candles;
  }
}
