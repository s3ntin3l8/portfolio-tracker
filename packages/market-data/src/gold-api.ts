import type {
  AssetClass,
  InstrumentRef,
  MarketDataProvider,
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

  supports(assetClass: AssetClass): boolean {
    return assetClass === "gold";
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
}
