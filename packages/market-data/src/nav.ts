import type {
  AssetClass,
  InstrumentRef,
  MarketDataProvider,
  Quote,
} from "./types.js";
import type { ProviderOptions } from "./twelve-data.js";

/**
 * Daily NAV (net asset value) per unit for Indonesian mutual funds (reksa dana),
 * in IDR. No official free API: reads a configurable JSON endpoint keyed by the
 * fund symbol/code (e.g. a Bibit/OJK NAB source), parsing a `nav` per-unit field.
 * Returns `null` on any failure so the chain falls through. Asset class:
 * `mutual_fund` (market-agnostic — funds aren't exchange-listed).
 */
export class NavProvider implements MarketDataProvider {
  readonly name = "nav";
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(opts: ProviderOptions & { baseUrl: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.doFetch = opts.fetch ?? globalThis.fetch;
  }

  supports(assetClass: AssetClass): boolean {
    return assetClass === "mutual_fund";
  }

  async getQuote(ref: InstrumentRef): Promise<Quote | null> {
    try {
      const res = await this.doFetch(
        `${this.baseUrl}/${encodeURIComponent(ref.symbol)}`,
      );
      if (!res.ok) return null;
      const nav = extractNav(await res.json());
      if (nav === undefined) return null;
      return {
        price: String(nav),
        currency: ref.currency,
        asOf: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }
}

function extractNav(data: unknown): number | undefined {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["nav", "nab", "navPerUnit", "nav_per_unit"]) {
      const v = obj[key];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    if (obj.data !== undefined && obj.data !== data) {
      return extractNav(obj.data);
    }
  }
  return undefined;
}
