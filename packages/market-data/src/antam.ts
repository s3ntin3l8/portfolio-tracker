import type {
  AssetClass,
  InstrumentRef,
  MarketDataProvider,
  Quote,
} from "./types.js";
import type { ProviderOptions } from "./twelve-data.js";

/**
 * Antam / Pegadaian gold **buyback** price (IDR per gram) — values physical and
 * savings gold (Pegadaian Tabungan Emas), distinct from XAU spot which drives the
 * ticker. No official API: reads a configurable JSON endpoint and parses a
 * buyback-per-gram field, returning `null` on any failure so the provider chain
 * falls through (to spot or a manual reconciliation backstop). Market: `ANTAM`.
 */
export class AntamProvider implements MarketDataProvider {
  readonly name = "antam";
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(opts: ProviderOptions & { baseUrl: string }) {
    this.baseUrl = opts.baseUrl;
    this.doFetch = opts.fetch ?? globalThis.fetch;
  }

  supports(assetClass: AssetClass, market: string): boolean {
    return assetClass === "gold" && market === "ANTAM";
  }

  async getQuote(ref: InstrumentRef): Promise<Quote | null> {
    try {
      const res = await this.doFetch(this.baseUrl);
      if (!res.ok) return null;
      const buyback = extractBuyback(await res.json());
      if (buyback === undefined) return null;
      return {
        price: String(buyback),
        currency: ref.currency,
        asOf: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }
}

// Accept a few likely shapes from unofficial harga-emas sources: a top-level
// buyback field, or one nested under `data`.
function extractBuyback(data: unknown): number | undefined {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["buyback", "buy_back", "hargaBuyback", "harga_buyback"]) {
      const v = obj[key];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    if (obj.data !== undefined && obj.data !== data) {
      return extractBuyback(obj.data);
    }
  }
  return undefined;
}
