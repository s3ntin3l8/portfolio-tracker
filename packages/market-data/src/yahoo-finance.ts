import type {
  AssetClass,
  Candle,
  InstrumentRef,
  InstrumentSearchResult,
  MarketDataProvider,
  Quote,
} from "./types.js";
import { assetClassFromType, mapExchange } from "./instrument-mapping.js";

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
 * tickers map to Yahoo's `.JK` suffix (e.g. BBCA → BBCA.JK). Unofficial endpoint, so
 * it's a resilience layer behind a keyed primary (Twelve Data), not the sole source.
 */
export class YahooFinanceProvider implements MarketDataProvider {
  readonly name = "yahoo";
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(opts: YahooProviderOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "https://query1.finance.yahoo.com";
    this.doFetch = opts.fetch ?? globalThis.fetch;
  }

  supports(assetClass: AssetClass): boolean {
    return assetClass === "equity" || assetClass === "etf";
  }

  /** Map an instrument to a Yahoo symbol: IDX tickers take the `.JK` suffix. */
  private yahooSymbol(ref: InstrumentRef): string {
    if (ref.symbol.includes(".")) return ref.symbol;
    if (ref.market === "IDX") return `${ref.symbol}.JK`;
    return ref.symbol;
  }

  private async chart(ref: InstrumentRef, range: string): Promise<ChartResult | null> {
    const symbol = encodeURIComponent(this.yahooSymbol(ref));
    const res = await this.doFetch(
      `${this.baseUrl}/v8/finance/chart/${symbol}?range=${range}&interval=1d`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      chart?: { result?: ChartResult[] | null; error?: unknown };
    };
    return data.chart?.result?.[0] ?? null;
  }

  async getQuote(ref: InstrumentRef): Promise<Quote | null> {
    const result = await this.chart(ref, "1d");
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
