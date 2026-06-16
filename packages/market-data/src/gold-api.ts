import type {
  AssetClass,
  InstrumentRef,
  MarketDataProvider,
  ProviderUsage,
  Quote,
} from "./types.js";
import type { ProviderOptions } from "./twelve-data.js";

const TROY_OUNCE_GRAMS = 31.1034768;

/**
 * GoldAPI.io provider — spot gold priced per gram in the requested currency
 * (e.g. XAU→IDR/gram). Free tier, keyed via the `x-access-token` header.
 */
export class GoldApiProvider implements MarketDataProvider {
  readonly name = "goldapi";
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(
    private readonly apiKey: string,
    opts: ProviderOptions = {},
  ) {
    this.baseUrl = opts.baseUrl ?? "https://www.goldapi.io/api";
    this.doFetch = opts.fetch ?? globalThis.fetch;
  }

  supports(assetClass: AssetClass, market: string): boolean {
    // Spot only (XAU); gold *holdings* are valued at the Antam buyback instead.
    return assetClass === "gold" && market === "XAU";
  }

  async getQuote(ref: InstrumentRef): Promise<Quote | null> {
    const res = await this.doFetch(`${this.baseUrl}/XAU/${ref.currency}`, {
      headers: { "x-access-token": this.apiKey },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      price_gram_24k?: number;
      price?: number;
    };
    const perGram =
      data.price_gram_24k ??
      (data.price !== undefined ? data.price / TROY_OUNCE_GRAMS : undefined);
    if (perGram === undefined) return null;
    return {
      price: String(perGram),
      currency: ref.currency,
      asOf: new Date().toISOString(),
    };
  }

  async getUsage(): Promise<ProviderUsage | null> {
    // `/stat` reports the month's request count. GoldAPI doesn't return the plan cap, so
    // we surface the used count only (limit: null).
    try {
      const res = await this.doFetch(`${this.baseUrl}/stat`, {
        headers: { "x-access-token": this.apiKey },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { requests_month?: number };
      if (data.requests_month === undefined) return null;
      return { window: "month", used: data.requests_month, limit: null };
    } catch {
      return null;
    }
  }
}
