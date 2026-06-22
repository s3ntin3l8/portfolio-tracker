import type {
  AssetClass,
  Candle,
  DividendEvent,
  InstrumentProfile,
  InstrumentRef,
  InstrumentSearchResult,
  MarketDataProvider,
  Quote,
} from "./types.js";
import {
  assetClassFromType,
  mapExchange,
  normalizeQuoteCurrency,
  yahooSuffixForMarket,
} from "./instrument-mapping.js";
import { isIsin } from "./types.js";

const TROY_OUNCE_GRAMS = 31.1034768;

/**
 * Maps Yahoo Finance's lowercase `topHoldings.sectorWeightings` keys (e.g. `"realestate"`)
 * to proper-case GICS-style names that `normalizeSector` in `@portfolio/core` can fold
 * into canonical labels for consistent cross-instrument aggregation.
 */
const YAHOO_ETF_SECTOR_KEY: Record<string, string> = {
  realestate: "Real Estate",
  technology: "Technology",
  consumer_cyclical: "Consumer Cyclical",
  consumer_defensive: "Consumer Defensive",
  financial_services: "Financial Services",
  communication_services: "Communication Services",
  basic_materials: "Basic Materials",
  utilities: "Utilities",
  industrials: "Industrials",
  healthcare: "Healthcare",
  energy: "Energy",
};

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
   * Cached Yahoo crumb + cookie for the quoteSummary endpoint (valid ~23 hours).
   * The quoteSummary endpoint requires a crumb (fetched via /v1/test/getcrumb) and
   * the corresponding session cookie, unlike the keyless /v8/finance/chart endpoint
   * used by the other methods.
   */
  private crumbCache: { cookies: string; crumb: string; fetchedAt: number } | null = null;
  private readonly CRUMB_TTL_MS = 23 * 60 * 60 * 1000; // 23 hours
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

  private async chartFromDate(symbol: string, fromDate: string): Promise<ChartResult | null> {
    const period1 = Math.floor(new Date(fromDate).getTime() / 1000);
    const period2 = Math.floor(Date.now() / 1000);
    const res = await this.doFetch(
      `${this.baseUrl}/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`,
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
   * Resolve the effective currency + price divisor for an equity/ETF quote.
   *
   * For gold and crypto the currency is already encoded in the symbol pair (e.g. `XAUEUR=X`,
   * `BTC-USD`) — leave those alone. For equity/ETF we trust the provider-reported
   * `meta.currency` (which tells us the listing's real denomination, e.g. `"USD"` for a
   * USD-priced UCITS ETF on Xetra) over `ref.currency` (the instrument's declared/execution
   * currency). We also normalise pence codes: Yahoo returns `"GBp"` for London/Xetra GBP
   * listings priced in pence, which must be ÷100 and relabelled as `"GBP"`.
   *
   * Falls back to `ref.currency` + divisor 1 when `metaCurrency` is absent.
   */
  private resolveCurrency(
    ref: InstrumentRef,
    metaCurrency?: string,
  ): { currency: string; divisor: number } {
    if (ref.assetClass === "gold" || ref.assetClass === "crypto") {
      return { currency: ref.currency, divisor: 1 };
    }
    if (!metaCurrency) return { currency: ref.currency, divisor: 1 };
    return normalizeQuoteCurrency(metaCurrency);
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
    // Adopt the provider's reported quote currency (e.g. "USD" for a USD-priced UCITS ETF on
    // Xetra) instead of the instrument's declared currency ("EUR"). Normalise pence codes
    // (GBp/GBX → GBP, divisor 100). Gold/crypto are handled by toGram/symbol-pair; ref.currency
    // is their correct label and their divisor is 1.
    const { currency, divisor } = this.resolveCurrency(ref, result?.meta?.currency);
    return {
      price: String(toGram(price) / divisor),
      currency,
      asOf,
      previousClose: prev === undefined ? null : String(toGram(prev) / divisor),
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
        assetClass: assetClassFromType(q.quoteType, { symbol, market: info.market }),
        currency: info.currency,
        source: this.name,
      });
    }
    return out;
  }

  async getDividends(ref: InstrumentRef, fromDate?: string): Promise<DividendEvent[]> {
    // Yahoo chart events=dividends is keyless and works for most equities/ETFs.
    if (ref.assetClass === "gold" || ref.assetClass === "crypto") return [];
    const symbol = this.yahooSymbol(ref);
    const res = await this.doFetch(
      `${this.baseUrl}/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1mo&events=dividends`,
      { headers: this.defaultHeaders },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      chart?: {
        result?: [
          {
            events?: {
              dividends?: Record<string, { amount: number; date: number }>;
            };
          },
        ];
      };
    };
    const divs = data.chart?.result?.[0]?.events?.dividends ?? {};
    const fromMs = fromDate ? new Date(fromDate).getTime() : 0;
    const out: DividendEvent[] = [];
    for (const d of Object.values(divs)) {
      if (!d.amount || !d.date) continue;
      const ts = d.date * 1000;
      if (ts < fromMs) continue;
      out.push({
        exDate: new Date(ts).toISOString().slice(0, 10),
        amountPerShare: String(d.amount),
        currency: ref.currency,
      });
    }
    return out.sort((a, b) => a.exDate.localeCompare(b.exDate));
  }

  async getHistory(ref: InstrumentRef, range = "1mo"): Promise<Candle[]> {
    const result = await this.chart(ref, range);
    const timestamps = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    // Gold pairs quote per troy ounce; convert each close to per-gram like the quote path.
    const gramFactor = ref.assetClass === "gold" ? TROY_OUNCE_GRAMS : 1;
    // Adopt the provider's reported quote currency (USD for USD-priced Xetra ETFs, etc.)
    // and apply the pence divisor if needed. Gold/crypto leave currency undefined so callers
    // fall back to instrument.currency (which correctly encodes the pair's denomination).
    const { currency, divisor } = this.resolveCurrency(ref, result?.meta?.currency);
    const stampCurrency = ref.assetClass === "gold" || ref.assetClass === "crypto"
      ? undefined
      : currency;
    const candles: Candle[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      if (close === null || close === undefined) continue;
      const adjusted = gramFactor === 1 ? close / divisor : close / gramFactor;
      candles.push({
        date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
        close: String(adjusted),
        ...(stampCurrency !== undefined ? { currency: stampCurrency } : {}),
      });
    }
    return candles;
  }

  /**
   * Obtain a Yahoo crumb + session cookie pair for the authenticated quoteSummary
   * endpoint. Results are cached for 23 hours; stale entries are refreshed on the
   * next call. All requests go through `this.doFetch` so tests can mock them.
   */
  private async getYahooCrumb(): Promise<{ cookies: string; crumb: string } | null> {
    if (
      this.crumbCache &&
      Date.now() - this.crumbCache.fetchedAt < this.CRUMB_TTL_MS
    ) {
      return this.crumbCache;
    }
    try {
      // Step 1: establish a Yahoo session (get cookie).
      const cookieRes = await this.doFetch("https://fc.yahoo.com/", {
        headers: this.defaultHeaders,
        redirect: "follow",
      });
      const setCookieHeader = cookieRes.headers.get("set-cookie") ?? "";
      // Parse individual cookie values (name=value) from the Set-Cookie header,
      // splitting on commas that precede a new cookie name (not commas inside values).
      const cookies = setCookieHeader
        .split(/,(?=\s*[A-Za-z0-9_-]+=)/)
        .map((c) => c.split(";")[0].trim())
        .filter(Boolean)
        .join("; ");

      // Step 2: fetch the crumb using the session cookie.
      const crumbRes = await this.doFetch(
        "https://query2.finance.yahoo.com/v1/test/getcrumb",
        { headers: { ...this.defaultHeaders, Cookie: cookies } },
      );
      if (!crumbRes.ok) return null;
      const crumb = (await crumbRes.text()).trim();
      // Validate: crumb is a short alphanumeric token — reject empty or multi-word values.
      if (!crumb || crumb.length < 3 || crumb.includes(" ")) return null;

      this.crumbCache = { cookies, crumb, fetchedAt: Date.now() };
      return this.crumbCache;
    } catch {
      return null;
    }
  }

  /** Parse a raw quoteSummary JSON response into an InstrumentProfile (or null). */
  private parseQuoteSummary(
    assetClass: AssetClass,
    data: unknown,
  ): InstrumentProfile | null {
    const typed = data as {
      quoteSummary?: {
        result?: Array<{
          assetProfile?: { sector?: string; industry?: string; country?: string };
          topHoldings?: { sectorWeightings?: Array<Record<string, number>> };
        }> | null;
        error?: unknown;
      };
    };
    const result = typed?.quoteSummary?.result?.[0];
    if (!result) return null;

    if (assetClass === "etf") {
      const weightings = result.topHoldings?.sectorWeightings ?? [];
      const sectorWeights: Record<string, number> = {};
      for (const entry of weightings) {
        for (const [rawKey, v] of Object.entries(entry)) {
          if (!v || v <= 0) continue;
          // Map Yahoo's lowercase key (e.g. "realestate") to a proper-case name
          // that normalizeSector() in @portfolio/core can aggregate consistently.
          const key = YAHOO_ETF_SECTOR_KEY[rawKey] ?? rawKey;
          sectorWeights[key] = v;
        }
      }
      return Object.keys(sectorWeights).length > 0 ? { sectorWeights } : null;
    }

    // Equity / other: return sector, industry, country from assetProfile.
    const ap = result.assetProfile;
    if (!ap) return null;
    const sector = ap.sector && ap.sector !== "N/A" ? ap.sector : null;
    const industry = ap.industry && ap.industry !== "N/A" ? ap.industry : null;
    const country = ap.country && ap.country !== "N/A" ? ap.country : null;
    if (!sector && !industry && !country) return null;
    return { sector, industry, country };
  }

  /**
   * Fetch instrument profile (sector / sector weights) via Yahoo Finance's quoteSummary
   * endpoint. Uses the `assetProfile` module for equities (single GICS sector string) and
   * the `topHoldings` module for ETFs (per-sector fraction map).
   *
   * Requires a Yahoo session crumb (fetched automatically and cached). Falls back to null
   * if the crumb cannot be obtained or the provider returns no data for this instrument.
   */
  async getProfile(ref: InstrumentRef): Promise<InstrumentProfile | null> {
    if (ref.assetClass !== "equity" && ref.assetClass !== "etf") return null;

    const symbol = this.yahooSymbol(ref);
    const module = ref.assetClass === "etf" ? "topHoldings" : "assetProfile";

    try {
      const auth = await this.getYahooCrumb();
      if (!auth) return null;

      const buildUrl = (c: string) =>
        `${this.baseUrl}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${module}&crumb=${encodeURIComponent(c)}`;

      let res = await this.doFetch(buildUrl(auth.crumb), {
        headers: { ...this.defaultHeaders, Cookie: auth.cookies },
      });

      // 401 means the crumb expired — clear and retry once.
      if (res.status === 401) {
        this.crumbCache = null;
        const auth2 = await this.getYahooCrumb();
        if (!auth2) return null;
        res = await this.doFetch(buildUrl(auth2.crumb), {
          headers: { ...this.defaultHeaders, Cookie: auth2.cookies },
        });
      }

      if (!res.ok) return null;
      return this.parseQuoteSummary(ref.assetClass, await res.json());
    } catch {
      return null;
    }
  }

  async getHistoryFrom(ref: InstrumentRef, fromDate: string): Promise<Candle[]> {
    const result = await this.chartFromDate(this.yahooSymbol(ref), fromDate);
    const timestamps = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    const gramFactor = ref.assetClass === "gold" ? TROY_OUNCE_GRAMS : 1;
    const { currency, divisor } = this.resolveCurrency(ref, result?.meta?.currency);
    const stampCurrency = ref.assetClass === "gold" || ref.assetClass === "crypto"
      ? undefined
      : currency;
    const candles: Candle[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      if (close === null || close === undefined) continue;
      const adjusted = gramFactor === 1 ? close / divisor : close / gramFactor;
      candles.push({
        date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
        close: String(adjusted),
        ...(stampCurrency !== undefined ? { currency: stampCurrency } : {}),
      });
    }
    return candles;
  }
}
