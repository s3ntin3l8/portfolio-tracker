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
 * Yahoo Finance provider — a **keyless** IDX equity/ETF fallback. Uses the auth-free
 * chart endpoint (`/v8/finance/chart/<symbol>`) for both quotes and history. IDX
 * tickers map to Yahoo's `.JK` suffix (e.g. BBCA → BBCA.JK); EU/Xetra tickers take
 * `.DE`. When the symbol-based lookup misses and an ISIN is known, the search endpoint
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

  constructor(opts: YahooProviderOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "https://query1.finance.yahoo.com";
    this.doFetch = opts.fetch ?? globalThis.fetch;
  }

  supports(assetClass: AssetClass): boolean {
    return assetClass === "equity" || assetClass === "etf";
  }

  /**
   * Map an instrument to a Yahoo symbol via its market's suffix (IDX → `.JK`,
   * XETRA → `.DE`). Already-qualified symbols pass through; an ISIN stored as the
   * symbol gets no suffix (the ISIN-search fallback resolves it instead).
   */
  private yahooSymbol(ref: InstrumentRef): string {
    if (ref.symbol.includes(".")) return ref.symbol;
    if (isIsin(ref.symbol)) return ref.symbol;
    const suffix = yahooSuffixForMarket(ref.market);
    return suffix ? `${ref.symbol}${suffix}` : ref.symbol;
  }

  private async chartBySymbol(symbol: string, range: string): Promise<ChartResult | null> {
    const res = await this.doFetch(
      `${this.baseUrl}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`,
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
   * Resolve an instrument's ISIN to a Yahoo symbol via the search endpoint, preferring
   * the listing whose venue matches the instrument's market, then its currency, then the
   * first quote. Result (incl. a miss) is memoised per ISIN.
   */
  private async resolveIsinSymbol(ref: InstrumentRef): Promise<string | null> {
    if (!ref.isin) return null;
    const cached = this.isinSymbolCache.get(ref.isin);
    if (cached !== undefined) return cached;

    const res = await this.doFetch(
      `${this.baseUrl}/v1/finance/search?q=${encodeURIComponent(ref.isin)}&quotesCount=10&newsCount=0`,
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
      symbol = (byMarket ?? byCurrency ?? quotes[0])?.symbol ?? null;
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
    return {
      price: String(price),
      currency: ref.currency,
      asOf,
      previousClose: prev === undefined ? null : String(prev),
    };
  }

  async search(query: string): Promise<InstrumentSearchResult[]> {
    // Keyless autocomplete endpoint. Returns cross-market matches; we keep only those
    // whose exchange maps to a currency we recognise (so the form can value them).
    const res = await this.doFetch(
      `${this.baseUrl}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0`,
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
    const candles: Candle[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      if (close === null || close === undefined) continue;
      candles.push({
        date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
        close: String(close),
      });
    }
    return candles;
  }
}
