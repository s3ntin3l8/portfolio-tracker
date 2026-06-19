import type { AssetClass, InstrumentRef, MarketDataProvider, Quote } from "./types.js";
import { isIsin, isWkn } from "./types.js";

export interface OpenFigiOptions {
  baseUrl?: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

interface FigiRecord {
  ticker?: string;
  name?: string;
  exchCode?: string;
  securityType?: string;
  securityType2?: string;
  marketSector?: string;
}

/**
 * OpenFIGI — maps an **ISIN** to a ticker + exchange (+ name/type) via the free
 * `/v3/mapping` endpoint. Keyless works at a low rate limit; an `OPENFIGI_API_KEY`
 * raises it. It does **not** quote prices — it only implements `resolveISIN`, so the
 * MarketDataService uses it purely for ISIN-based discovery. `supports` is `false` so
 * the quote/history chain never routes to it.
 */
export class OpenFigiProvider implements MarketDataProvider {
  readonly name = "openfigi";
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly doFetch: typeof fetch;

  constructor(opts: OpenFigiOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "https://api.openfigi.com";
    this.apiKey = opts.apiKey;
    this.doFetch = opts.fetch ?? globalThis.fetch;
  }

  supports(_assetClass: AssetClass, _market: string): boolean {
    return false; // discovery-only; not a price source
  }

  async getQuote(_ref: InstrumentRef): Promise<Quote | null> {
    return null;
  }

  async resolveISIN(
    isin: string,
  ): Promise<{ symbol: string; exchange: string; name?: string; type?: string } | null> {
    if (!isIsin(isin)) return null;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["X-OPENFIGI-APIKEY"] = this.apiKey;

    const res = await this.doFetch(`${this.baseUrl}/v3/mapping`, {
      method: "POST",
      headers,
      body: JSON.stringify([{ idType: "ID_ISIN", idValue: isin.trim().toUpperCase() }]),
    });
    if (!res.ok) return null;

    const payload = (await res.json()) as { data?: FigiRecord[]; error?: string }[];
    const records = payload?.[0]?.data ?? [];
    // Prefer the composite US listing (exchCode "US"): it carries the canonical US ticker,
    // and OpenFIGI sometimes orders foreign venues first where the *local* ticker differs —
    // e.g. Verizon (US92343V1044) lists as "BAC" on German exchanges but "VZ" in the US.
    // Fall back to any record with a ticker (non-US instruments have no US line), then the
    // first record at all.
    const match =
      records.find((r) => r.exchCode === "US" && r.ticker) ??
      records.find((r) => r.ticker) ??
      records[0];
    if (!match?.ticker) return null;

    return {
      symbol: match.ticker,
      exchange: match.exchCode ?? "",
      name: match.name,
      // Surface every type signal, not just securityType2: OpenFIGI labels UCITS ETFs
      // as securityType "ETP" but securityType2 "Mutual Fund", so preferring the latter
      // misclassifies them. assetClassFromType checks etf/etp first, so the combined
      // string resolves ETPs to `etf` while genuine open-end funds stay `mutual_fund`.
      type: [match.securityType, match.securityType2, match.marketSector]
        .filter(Boolean)
        .join(" "),
    };
  }

  async resolveWKN(
    wkn: string,
  ): Promise<{ symbol: string; exchange: string; name?: string; type?: string } | null> {
    if (!isWkn(wkn)) return null;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["X-OPENFIGI-APIKEY"] = this.apiKey;

    const res = await this.doFetch(`${this.baseUrl}/v3/mapping`, {
      method: "POST",
      headers,
      body: JSON.stringify([{ idType: "ID_WERTPAPIER", idValue: wkn.trim().toUpperCase() }]),
    });
    if (!res.ok) return null;

    const payload = (await res.json()) as { data?: FigiRecord[]; error?: string }[];
    const records = payload?.[0]?.data ?? [];
    const match =
      records.find((r) => r.exchCode === "US" && r.ticker) ??
      records.find((r) => r.ticker) ??
      records[0];
    if (!match?.ticker) return null;

    return {
      symbol: match.ticker,
      exchange: match.exchCode ?? "",
      name: match.name,
      type: [match.securityType, match.securityType2, match.marketSector]
        .filter(Boolean)
        .join(" "),
    };
  }
}
