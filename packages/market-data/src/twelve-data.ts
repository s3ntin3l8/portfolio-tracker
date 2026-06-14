import type {
  AssetClass,
  Candle,
  InstrumentRef,
  MarketDataProvider,
  Quote,
} from "./types.js";

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

  supports(assetClass: AssetClass): boolean {
    return assetClass === "equity" || assetClass === "etf" || assetClass === "gold";
  }

  private query(ref: InstrumentRef): string {
    if (ref.assetClass === "gold") {
      return `symbol=${encodeURIComponent(`XAU/${ref.currency}`)}`;
    }
    return `symbol=${encodeURIComponent(ref.symbol)}&exchange=${encodeURIComponent(ref.market)}`;
  }

  async getQuote(ref: InstrumentRef): Promise<Quote | null> {
    const res = await this.doFetch(
      `${this.baseUrl}/price?${this.query(ref)}&apikey=${this.apiKey}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { price?: string };
    if (!data.price) return null;

    const price =
      ref.assetClass === "gold"
        ? (Number(data.price) / TROY_OUNCE_GRAMS).toString()
        : data.price;
    return { price, currency: ref.currency, asOf: new Date().toISOString() };
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
