import type {
  AssetClass,
  Candle,
  DividendEvent,
  InstrumentRef,
  InstrumentSearchResult,
  MarketDataProvider,
  ProviderUsage,
  Quote,
} from "./types.js";
import { assetClassFromType, mapExchange } from "./instrument-mapping.js";

const TROY_OUNCE_GRAMS = 31.1034768;

export interface ProviderOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * Twelve Data provider — IDX equities/ETFs (via the `exchange=IDX` param) and gold
 * (`XAU/<currency>`, converted to a per-gram price). Free tier: ~800 credits/day.
 */
export class TwelveDataProvider implements MarketDataProvider {
  readonly name = "twelvedata";
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(
    private readonly apiKey: string,
    opts: ProviderOptions = {},
  ) {
    this.baseUrl = opts.baseUrl ?? "https://api.twelvedata.com";
    this.doFetch = opts.fetch ?? globalThis.fetch;
  }

  supports(assetClass: AssetClass, market: string): boolean {
    // Only the markets the IDX-shaped `exchange=` query actually resolves; EU venues
    // (e.g. XETRA) are left to EODHD/Yahoo rather than burning a credit on a miss.
    if (assetClass === "equity" || assetClass === "etf")
      return market === "IDX" || market === "US";
    // Gold spot only (XAU); buyback valuation is the Antam provider's job.
    return assetClass === "gold" && market === "XAU";
  }

  private query(ref: InstrumentRef): string {
    if (ref.assetClass === "gold") {
      return `symbol=${encodeURIComponent(`XAU/${ref.currency}`)}`;
    }
    return `symbol=${encodeURIComponent(ref.symbol)}&exchange=${encodeURIComponent(ref.market)}`;
  }

  async getQuote(ref: InstrumentRef): Promise<Quote | null> {
    // The `/quote` endpoint carries `previous_close` alongside the latest `close`,
    // so a single call yields both the price and the day-change baseline.
    const res = await this.doFetch(
      `${this.baseUrl}/quote?${this.query(ref)}&apikey=${this.apiKey}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      close?: string;
      previous_close?: string;
    };
    if (!data.close) return null;

    const toGram = (v: string) =>
      ref.assetClass === "gold"
        ? (Number(v) / TROY_OUNCE_GRAMS).toString()
        : v;
    return {
      price: toGram(data.close),
      currency: ref.currency,
      asOf: new Date().toISOString(),
      previousClose: data.previous_close ? toGram(data.previous_close) : null,
    };
  }

  async search(query: string): Promise<InstrumentSearchResult[]> {
    // `/symbol_search` returns instruments matching a ticker or name across exchanges,
    // each carrying the currency + instrument type we need to prefill the form.
    const res = await this.doFetch(
      `${this.baseUrl}/symbol_search?symbol=${encodeURIComponent(query)}&apikey=${this.apiKey}`,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      data?: {
        symbol?: string;
        instrument_name?: string;
        exchange?: string;
        mic_code?: string;
        currency?: string;
        instrument_type?: string;
      }[];
    };
    const out: InstrumentSearchResult[] = [];
    for (const d of data.data ?? []) {
      if (!d.symbol) continue;
      const info = mapExchange(d.mic_code) ?? mapExchange(d.exchange);
      const currency = d.currency ?? info?.currency;
      if (!currency) continue; // can't price/value it without a currency
      out.push({
        symbol: d.symbol,
        name: d.instrument_name ?? d.symbol,
        market: info?.market ?? d.exchange ?? d.mic_code ?? "",
        assetClass: assetClassFromType(d.instrument_type),
        currency,
        source: this.name,
      });
    }
    return out;
  }

  async getUsage(): Promise<ProviderUsage | null> {
    // `/api_usage` reports credit consumption; it doesn't itself cost credits. Prefer the
    // daily window when the plan exposes it, else fall back to the per-minute counters.
    try {
      const res = await this.doFetch(
        `${this.baseUrl}/api_usage?apikey=${this.apiKey}`,
      );
      if (!res.ok) return null;
      const data = (await res.json()) as {
        current_usage?: number;
        plan_limit?: number;
        daily_usage?: number;
        plan_daily_limit?: number;
      };
      if (data.daily_usage !== undefined || data.plan_daily_limit !== undefined) {
        return {
          window: "day",
          used: data.daily_usage ?? null,
          limit: data.plan_daily_limit ?? null,
        };
      }
      if (data.current_usage === undefined && data.plan_limit === undefined) {
        return null;
      }
      return {
        window: "minute",
        used: data.current_usage ?? null,
        limit: data.plan_limit ?? null,
      };
    } catch {
      return null;
    }
  }

  async getDividends(ref: InstrumentRef, fromDate?: string): Promise<DividendEvent[]> {
    // Twelve Data's `/dividends` endpoint covers IDX + US equities/ETFs.
    if (ref.assetClass === "gold") return [];
    const start =
      fromDate ??
      new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const res = await this.doFetch(
      `${this.baseUrl}/dividends?${this.query(ref)}&start_date=${start}&apikey=${this.apiKey}`,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      dividends?: {
        ex_dividend_date?: string;
        payment_date?: string;
        dividend_amount?: string | number;
      }[];
    };
    return (data.dividends ?? [])
      .filter((d) => d.ex_dividend_date && d.dividend_amount != null)
      .map((d) => ({
        exDate: d.ex_dividend_date as string,
        payDate: d.payment_date ?? null,
        amountPerShare: String(d.dividend_amount),
        currency: ref.currency,
      }));
  }

  async getHistory(ref: InstrumentRef, range = "30"): Promise<Candle[]> {
    const res = await this.doFetch(
      `${this.baseUrl}/time_series?${this.query(ref)}&interval=1day&outputsize=${range}&apikey=${this.apiKey}`,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      values?: { datetime: string; close: string }[];
    };
    const factor = ref.assetClass === "gold" ? TROY_OUNCE_GRAMS : 1;
    return (data.values ?? []).map((v) => ({
      date: v.datetime,
      close: factor === 1 ? v.close : (Number(v.close) / factor).toString(),
    }));
  }
}
