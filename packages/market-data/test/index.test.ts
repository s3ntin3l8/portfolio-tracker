import { describe, it, expect } from "vitest";
import {
  ASSET_CLASSES,
  isAssetClass,
  isIsin,
  FixtureProvider,
  MarketDataService,
  TwelveDataProvider,
  GoldApiProvider,
  AntamProvider,
  NavProvider,
  YahooFinanceProvider,
  OpenFigiProvider,
  EodhdProvider,
  assetClassFromType,
  type InstrumentRef,
  type InstrumentSearchResult,
  type MarketDataProvider,
} from "../src/index.js";

function mockFetch(
  responder: (url: string, init?: RequestInit) => { ok?: boolean; body: unknown },
) {
  return (async (url: string, init?: RequestInit) => {
    const { ok = true, body } = responder(url, init);
    return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

const bbca: InstrumentRef = {
  symbol: "BBCA",
  market: "IDX",
  assetClass: "equity",
  currency: "IDR",
};

describe("asset classes", () => {
  it("lists and narrows asset classes", () => {
    expect(ASSET_CLASSES).toContain("gold");
    expect(isAssetClass("bond")).toBe(true);
    expect(isAssetClass("nope")).toBe(false);
  });
});

describe("FixtureProvider", () => {
  const provider = new FixtureProvider();

  it("quotes known symbols (with previous close) and returns null for unknown", async () => {
    expect(await provider.getQuote(bbca)).toMatchObject({
      price: "9500",
      currency: "IDR",
      previousClose: "9000",
    });
    expect(
      await provider.getQuote({ ...bbca, symbol: "UNKNOWN" }),
    ).toBeNull();
  });

  it("supports any asset class / market", () => {
    expect(provider.supports("gold", "XAU")).toBe(true);
  });

  it("searches its catalogue by symbol, name, or ISIN", async () => {
    expect((await provider.search("bbca"))[0]).toMatchObject({
      symbol: "BBCA",
      name: "Bank Central Asia Tbk",
      assetClass: "equity",
      currency: "IDR",
    });
    expect(await provider.search("telkom")).toHaveLength(1);
    expect(await provider.search("ID1000109507")).toHaveLength(1); // by ISIN
    expect(await provider.search("   ")).toEqual([]);
    expect(await provider.search("nope")).toEqual([]);
  });

  it("resolves a known ISIN and rejects malformed ones", async () => {
    expect(await provider.resolveISIN("ID1000109507")).toMatchObject({
      symbol: "BBCA",
      exchange: "IDX",
    });
    expect(await provider.resolveISIN("not-an-isin")).toBeNull();
    expect(await provider.resolveISIN("US0000000000")).toBeNull(); // valid shape, unknown
  });
});

describe("isIsin", () => {
  it("matches 12-char ISINs and rejects anything else", () => {
    expect(isIsin("US0378331005")).toBe(true);
    expect(isIsin("id1000109507")).toBe(true); // case-insensitive
    expect(isIsin("BBCA")).toBe(false);
    expect(isIsin("US037833100")).toBe(false); // too short
  });
});

describe("MarketDataService", () => {
  it("routes to the first supporting provider", async () => {
    const goldOnly: MarketDataProvider = {
      name: "gold",
      supports: (ac) => ac === "gold",
      getQuote: async (ref) => ({
        price: "1200000",
        currency: ref.currency,
        asOf: "2026-02-08T00:00:00.000Z",
      }),
    };
    const svc = new MarketDataService([goldOnly, new FixtureProvider()]);

    // equity → falls through gold-only to the fixture provider
    expect((await svc.getQuote(bbca))?.price).toBe("9500");
    // gold → the gold provider wins
    const gold = await svc.getQuote({
      symbol: "GOLD",
      market: "XAU",
      assetClass: "gold",
      currency: "IDR",
    });
    expect(gold?.price).toBe("1200000");
  });

  it("batch-quotes by id and drops misses", async () => {
    const svc = new MarketDataService([new FixtureProvider()]);
    const quotes = await svc.getQuotes([
      { id: "i1", ref: bbca },
      { id: "i2", ref: { ...bbca, symbol: "MISSING" } },
    ]);
    expect(quotes.i1.price).toBe("9500");
    expect(quotes.i2).toBeUndefined();
  });

  it("falls through to the next supporting provider when the primary returns null", async () => {
    const primary: MarketDataProvider = {
      name: "primary",
      supports: (ac) => ac === "equity",
      getQuote: async () => null, // rate-limited / not found
      getHistory: async () => [],
    };
    const fallback: MarketDataProvider = {
      name: "fallback",
      supports: (ac) => ac === "equity",
      getQuote: async (ref) => ({
        price: "9999",
        currency: ref.currency,
        asOf: "2026-02-08T00:00:00.000Z",
      }),
      getHistory: async () => [{ date: "2026-02-08", close: "9999" }],
    };
    const svc = new MarketDataService([primary, fallback]);
    expect((await svc.getQuote(bbca))?.price).toBe("9999");
    expect((await svc.getHistory(bbca, "1mo"))[0].close).toBe("9999");
  });

  const result = (over: Partial<InstrumentSearchResult>): InstrumentSearchResult => ({
    symbol: "BBCA",
    name: "Bank Central Asia",
    market: "IDX",
    assetClass: "equity",
    currency: "IDR",
    source: "primary",
    ...over,
  });

  it("merges search results across providers and dedupes by market:symbol (first wins)", async () => {
    const primary: MarketDataProvider = {
      name: "primary",
      supports: () => false,
      getQuote: async () => null,
      search: async () => [result({ name: "Primary BCA" })],
    };
    const secondary: MarketDataProvider = {
      name: "secondary",
      supports: () => false,
      getQuote: async () => null,
      // duplicate BBCA (dropped) + a fresh symbol (kept)
      search: async () => [
        result({ name: "Secondary BCA", source: "secondary" }),
        result({ symbol: "TLKM", name: "Telkom", source: "secondary" }),
      ],
    };
    const svc = new MarketDataService([primary, secondary]);
    const out = await svc.search("b");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ symbol: "BBCA", name: "Primary BCA" }); // first wins
    expect(out[1]).toMatchObject({ symbol: "TLKM", source: "secondary" });
  });

  it("routes ISIN queries to resolveISIN and tolerates a throwing provider", async () => {
    const flaky: MarketDataProvider = {
      name: "flaky",
      supports: () => false,
      getQuote: async () => null,
      resolveISIN: async () => {
        throw new Error("rate limited");
      },
    };
    const figi: MarketDataProvider = {
      name: "figi",
      supports: () => false,
      getQuote: async () => null,
      resolveISIN: async () => ({
        symbol: "AAPL",
        exchange: "US",
        name: "Apple Inc",
        type: "Common Stock",
      }),
      // search must NOT be consulted for an ISIN query
      search: async () => [result({ symbol: "WRONG" })],
    };
    const svc = new MarketDataService([flaky, figi]);
    const out = await svc.search("US0378331005");
    expect(out).toEqual([
      {
        symbol: "AAPL",
        name: "Apple Inc",
        market: "US",
        assetClass: "equity",
        currency: "USD",
        isin: "US0378331005",
        source: "figi",
      },
    ]);
  });

  it("returns [] for a blank query and caps the result count", async () => {
    const many: MarketDataProvider = {
      name: "many",
      supports: () => false,
      getQuote: async () => null,
      search: async () =>
        Array.from({ length: 25 }, (_, i) => result({ symbol: `SYM${i}` })),
    };
    const svc = new MarketDataService([many]);
    expect(await svc.search("  ")).toEqual([]);
    expect(await svc.search("x")).toHaveLength(10);
  });
});

describe("YahooFinanceProvider", () => {
  const chartBody = (price: number) => ({
    chart: {
      result: [
        {
          meta: {
            regularMarketPrice: price,
            currency: "IDR",
            regularMarketTime: 1738972800,
            previousClose: 9000,
          },
          timestamp: [1738972800, 1739059200],
          indicators: { quote: [{ close: [price, null] }] },
        },
      ],
    },
  });

  it("quotes an IDX equity via the .JK chart endpoint", async () => {
    let calledUrl = "";
    const provider = new YahooFinanceProvider({
      fetch: mockFetch((url) => {
        calledUrl = url;
        return { body: chartBody(9500) };
      }),
    });
    const quote = await provider.getQuote(bbca);
    expect(calledUrl).toContain("/v8/finance/chart/BBCA.JK");
    expect(quote).toMatchObject({
      price: "9500",
      currency: "IDR",
      previousClose: "9000",
    });
    expect(quote?.asOf).toBe(new Date(1738972800 * 1000).toISOString());
  });

  it("supports equities/ETFs but not gold", () => {
    const provider = new YahooFinanceProvider();
    expect(provider.supports("equity", "IDX")).toBe(true);
    expect(provider.supports("etf", "IDX")).toBe(true);
    expect(provider.supports("gold", "XAU")).toBe(false);
  });

  it("quotes a Xetra ETF via the .DE suffix, without double-suffixing", async () => {
    let calledUrl = "";
    const provider = new YahooFinanceProvider({
      fetch: mockFetch((url) => {
        calledUrl = url;
        return { body: chartBody(50) };
      }),
    });
    const xetra: InstrumentRef = {
      symbol: "AEMD",
      market: "XETRA",
      assetClass: "etf",
      currency: "EUR",
    };
    expect((await provider.getQuote(xetra))?.price).toBe("50");
    expect(calledUrl).toContain("/v8/finance/chart/AEMD.DE");

    // already-qualified symbol passes through unchanged (no .DE.DE)
    await provider.getQuote({ ...xetra, symbol: "AEMD.DE" });
    expect(calledUrl).toContain("/v8/finance/chart/AEMD.DE");
    expect(calledUrl).not.toContain("AEMD.DE.DE");
  });

  it("returns history candles, skipping null closes", async () => {
    const provider = new YahooFinanceProvider({
      fetch: mockFetch(() => ({ body: chartBody(9500) })),
    });
    const candles = await provider.getHistory(bbca, "1mo");
    expect(candles).toHaveLength(1); // second close is null → skipped
    expect(candles[0]).toMatchObject({ close: "9500" });
  });

  it("returns null on a non-200 and empty history when unavailable", async () => {
    const provider = new YahooFinanceProvider({
      fetch: mockFetch(() => ({ ok: false, body: {} })),
    });
    expect(await provider.getQuote(bbca)).toBeNull();
    expect(await provider.getHistory(bbca, "1mo")).toEqual([]);
  });
});

describe("YahooFinanceProvider ISIN fallback", () => {
  const chartBody = (price: number | null) => ({
    chart: {
      result: [
        {
          meta:
            price === null
              ? {}
              : { regularMarketPrice: price, currency: "EUR", regularMarketTime: 1738972800 },
        },
      ],
    },
  });
  // A stale/unresolvable stored ticker → the direct `.DE` lookup misses, forcing the
  // ISIN search to find the real Yahoo symbol.
  const isinRef: InstrumentRef = {
    symbol: "OLDTICKER",
    market: "XETRA",
    assetClass: "etf",
    currency: "EUR",
    isin: "IE00B4L5Y983",
  };
  // Two cross-listings of the same ISIN: a GBP London line and the EUR Xetra (GER) line.
  const searchBody = {
    quotes: [
      { symbol: "AEMD.L", exchange: "LSE" }, // unknown venue → not market/currency match
      { symbol: "AEMD.DE", exchange: "GER" }, // GER → XETRA / EUR
    ],
  };

  it("resolves the ISIN to the market-matching listing when the direct symbol misses", async () => {
    const urls: string[] = [];
    const provider = new YahooFinanceProvider({
      fetch: mockFetch((url) => {
        urls.push(url);
        if (url.includes("/v1/finance/search")) return { body: searchBody };
        // The first (direct) chart call has no price; the resolved one does.
        return { body: url.includes("AEMD.DE") ? chartBody(50) : chartBody(null) };
      }),
    });
    const quote = await provider.getQuote(isinRef);
    expect(quote).toMatchObject({ price: "50", currency: "EUR" });
    expect(urls.some((u) => u.includes("/v1/finance/search?q=IE00B4L5Y983"))).toBe(true);
    expect(urls.at(-1)).toContain("/v8/finance/chart/AEMD.DE");
  });

  it("memoises the ISIN resolution across calls", async () => {
    let searchCalls = 0;
    const provider = new YahooFinanceProvider({
      fetch: mockFetch((url) => {
        if (url.includes("/v1/finance/search")) {
          searchCalls++;
          return { body: searchBody };
        }
        return { body: url.includes("AEMD.DE") ? chartBody(50) : chartBody(null) };
      }),
    });
    await provider.getQuote(isinRef);
    await provider.getQuote(isinRef);
    expect(searchCalls).toBe(1);
  });

  it("does not search when no ISIN is known", async () => {
    let searched = false;
    const provider = new YahooFinanceProvider({
      fetch: mockFetch((url) => {
        if (url.includes("/v1/finance/search")) searched = true;
        return { body: chartBody(null) };
      }),
    });
    const { isin: _omit, ...noIsin } = isinRef;
    expect(await provider.getQuote(noIsin)).toBeNull();
    expect(searched).toBe(false);
  });

  it("resolves an ISIN-as-symbol without suffixing it", async () => {
    const urls: string[] = [];
    const provider = new YahooFinanceProvider({
      fetch: mockFetch((url) => {
        urls.push(url);
        if (url.includes("/v1/finance/search")) return { body: searchBody };
        return { body: url.includes("AEMD.DE") ? chartBody(50) : chartBody(null) };
      }),
    });
    const quote = await provider.getQuote({ ...isinRef, symbol: "IE00B4L5Y983" });
    expect(quote?.price).toBe("50");
    // the direct attempt is the bare ISIN, never IE00....DE
    expect(urls.some((u) => u.includes("/v8/finance/chart/IE00B4L5Y983?"))).toBe(true);
    expect(urls.some((u) => u.includes("IE00B4L5Y983.DE"))).toBe(false);
  });
});

describe("TwelveDataProvider", () => {
  it("supports IDX/US equities & gold spot, but not EU venues", () => {
    const provider = new TwelveDataProvider("key");
    expect(provider.supports("equity", "IDX")).toBe(true);
    expect(provider.supports("etf", "US")).toBe(true);
    expect(provider.supports("gold", "XAU")).toBe(true);
    expect(provider.supports("etf", "XETRA")).toBe(false);
  });

  it("quotes an IDX equity with the exchange param + previous close", async () => {
    let seenUrl = "";
    const provider = new TwelveDataProvider("key", {
      fetch: mockFetch((url) => {
        seenUrl = url;
        return { body: { close: "9500", previous_close: "9000" } };
      }),
    });
    const quote = await provider.getQuote(bbca);
    expect(quote?.price).toBe("9500");
    expect(quote?.previousClose).toBe("9000");
    expect(seenUrl).toContain("/quote?");
    expect(seenUrl).toContain("symbol=BBCA");
    expect(seenUrl).toContain("exchange=IDX");
  });

  it("converts gold (per-ounce) to a per-gram price, incl. previous close", async () => {
    const provider = new TwelveDataProvider("key", {
      fetch: mockFetch(() => ({
        body: { close: "31103.4768", previous_close: "31103.4768" },
      })),
    });
    const quote = await provider.getQuote({
      symbol: "XAU",
      market: "XAU",
      assetClass: "gold",
      currency: "IDR",
    });
    expect(quote?.price).toBe("1000"); // 31103.4768 / 31.1034768
    expect(quote?.previousClose).toBe("1000");
  });

  it("returns null on a non-ok response", async () => {
    const provider = new TwelveDataProvider("key", {
      fetch: mockFetch(() => ({ ok: false, body: {} })),
    });
    expect(await provider.getQuote(bbca)).toBeNull();
  });

  it("maps history candles (equity passthrough, gold converted)", async () => {
    const eqProvider = new TwelveDataProvider("key", {
      fetch: mockFetch(() => ({
        body: { values: [{ datetime: "2026-02-08", close: "9500" }] },
      })),
    });
    expect(await eqProvider.getHistory(bbca)).toEqual([
      { date: "2026-02-08", close: "9500" },
    ]);

    const goldProvider = new TwelveDataProvider("key", {
      fetch: mockFetch(() => ({
        body: { values: [{ datetime: "2026-02-08", close: "31103.4768" }] },
      })),
    });
    const gold = await goldProvider.getHistory({
      symbol: "XAU",
      market: "XAU",
      assetClass: "gold",
      currency: "IDR",
    });
    expect(gold[0].close).toBe("1000");
  });

  it("returns [] history on a non-ok response", async () => {
    const provider = new TwelveDataProvider("key", {
      fetch: mockFetch(() => ({ ok: false, body: {} })),
    });
    expect(await provider.getHistory(bbca)).toEqual([]);
  });
});

describe("GoldApiProvider", () => {
  it("returns the per-gram gold price and sends the access token", async () => {
    let token: string | undefined;
    const provider = new GoldApiProvider("gold-key", {
      fetch: mockFetch((_url, init) => {
        token = (init?.headers as Record<string, string>)["x-access-token"];
        return { body: { price_gram_24k: 1150000 } };
      }),
    });
    const quote = await provider.getQuote({
      symbol: "GOLD",
      market: "XAU",
      assetClass: "gold",
      currency: "IDR",
    });
    expect(quote?.price).toBe("1150000");
    expect(token).toBe("gold-key");
    expect(provider.supports("gold", "XAU")).toBe(true);
    expect(provider.supports("gold", "ANTAM")).toBe(false); // buyback ≠ spot
    expect(provider.supports("equity", "IDX")).toBe(false);
  });

  const goldRef: InstrumentRef = {
    symbol: "GOLD",
    market: "XAU",
    assetClass: "gold",
    currency: "IDR",
  };

  it("falls back to the per-ounce price when price_gram_24k is absent", async () => {
    const provider = new GoldApiProvider("k", {
      fetch: mockFetch(() => ({ body: { price: 31103.4768 } })),
    });
    expect((await provider.getQuote(goldRef))?.price).toBe("1000");
  });

  it("returns null when no price field is present", async () => {
    const provider = new GoldApiProvider("k", {
      fetch: mockFetch(() => ({ body: {} })),
    });
    expect(await provider.getQuote(goldRef)).toBeNull();
  });
});

describe("AntamProvider", () => {
  const antamRef: InstrumentRef = {
    symbol: "GOLD",
    market: "ANTAM",
    assetClass: "gold",
    currency: "IDR",
  };

  it("supports gold buyback (ANTAM market) but not spot", () => {
    const p = new AntamProvider({ baseUrl: "https://x", fetch: mockFetch(() => ({ body: {} })) });
    expect(p.supports("gold", "ANTAM")).toBe(true);
    expect(p.supports("gold", "XAU")).toBe(false);
    expect(p.supports("equity", "IDX")).toBe(false);
  });

  it("reads the per-gram buyback price (incl. nested under data)", async () => {
    const top = new AntamProvider({
      baseUrl: "https://x",
      fetch: mockFetch(() => ({ body: { buyback: 1120000 } })),
    });
    expect((await top.getQuote(antamRef))?.price).toBe("1120000");

    const nested = new AntamProvider({
      baseUrl: "https://x",
      fetch: mockFetch(() => ({ body: { data: { harga_buyback: 1115000 } } })),
    });
    expect((await nested.getQuote(antamRef))?.price).toBe("1115000");
  });

  it("returns null on an unrecognised shape or a failed request", async () => {
    const bad = new AntamProvider({
      baseUrl: "https://x",
      fetch: mockFetch(() => ({ body: { something: "else" } })),
    });
    expect(await bad.getQuote(antamRef)).toBeNull();

    const down = new AntamProvider({
      baseUrl: "https://x",
      fetch: mockFetch(() => ({ ok: false, body: {} })),
    });
    expect(await down.getQuote(antamRef)).toBeNull();
  });
});

describe("NavProvider", () => {
  const fundRef: InstrumentRef = {
    symbol: "RDPU",
    market: "IDX",
    assetClass: "mutual_fund",
    currency: "IDR",
  };

  it("supports mutual funds only", () => {
    const p = new NavProvider({ baseUrl: "https://x", fetch: mockFetch(() => ({ body: {} })) });
    expect(p.supports("mutual_fund", "IDX")).toBe(true);
    expect(p.supports("equity", "IDX")).toBe(false);
    expect(p.supports("gold", "XAU")).toBe(false);
  });

  it("fetches NAV per unit by fund symbol", async () => {
    let calledUrl = "";
    const p = new NavProvider({
      baseUrl: "https://funds.example/nav/",
      fetch: mockFetch((url) => {
        calledUrl = url;
        return { body: { nav: 1234.56 } };
      }),
    });
    expect((await p.getQuote(fundRef))?.price).toBe("1234.56");
    expect(calledUrl).toBe("https://funds.example/nav/RDPU"); // trailing slash trimmed
  });

  it("returns null when NAV is absent or the request fails", async () => {
    const absent = new NavProvider({
      baseUrl: "https://x",
      fetch: mockFetch(() => ({ body: {} })),
    });
    expect(await absent.getQuote(fundRef)).toBeNull();
  });
});

describe("TwelveDataProvider.search", () => {
  it("maps symbol_search results, deriving market/asset class and skipping currency-less rows", async () => {
    let seenUrl = "";
    const provider = new TwelveDataProvider("key", {
      fetch: mockFetch((url) => {
        seenUrl = url;
        return {
          body: {
            data: [
              {
                symbol: "BBCA",
                instrument_name: "Bank Central Asia",
                exchange: "IDX",
                mic_code: "XIDX",
                currency: "IDR",
                instrument_type: "Common Stock",
              },
              {
                symbol: "QQQ",
                instrument_name: "Invesco QQQ Trust",
                exchange: "NASDAQ",
                currency: "USD",
                instrument_type: "ETF",
              },
              { symbol: "NOPE", instrument_name: "No currency" }, // skipped
            ],
          },
        };
      }),
    });
    const out = await provider.search("ba");
    expect(seenUrl).toContain("/symbol_search?symbol=ba");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      symbol: "BBCA",
      market: "IDX",
      assetClass: "equity",
      currency: "IDR",
      source: "twelvedata",
    });
    expect(out[1]).toMatchObject({ symbol: "QQQ", market: "US", assetClass: "etf" });
  });

  it("returns [] on a non-ok response", async () => {
    const provider = new TwelveDataProvider("key", {
      fetch: mockFetch(() => ({ ok: false, body: {} })),
    });
    expect(await provider.search("x")).toEqual([]);
  });
});

describe("YahooFinanceProvider.search", () => {
  it("strips the .JK suffix for IDX and drops unknown venues", async () => {
    let seenUrl = "";
    const provider = new YahooFinanceProvider({
      fetch: mockFetch((url) => {
        seenUrl = url;
        return {
          body: {
            quotes: [
              {
                symbol: "BBCA.JK",
                longname: "Bank Central Asia Tbk",
                quoteType: "EQUITY",
                exchange: "JKT",
              },
              { symbol: "MYSTERY", quoteType: "EQUITY", exchange: "ZZZ" }, // unknown → skip
            ],
          },
        };
      }),
    });
    const out = await provider.search("bca");
    expect(seenUrl).toContain("/v1/finance/search?q=bca");
    expect(out).toEqual([
      {
        symbol: "BBCA",
        name: "Bank Central Asia Tbk",
        market: "IDX",
        assetClass: "equity",
        currency: "IDR",
        source: "yahoo",
      },
    ]);
  });

  it("returns [] on a non-ok response", async () => {
    const provider = new YahooFinanceProvider({
      fetch: mockFetch(() => ({ ok: false, body: {} })),
    });
    expect(await provider.search("x")).toEqual([]);
  });
});

describe("EodhdProvider", () => {
  const xetra: InstrumentRef = {
    symbol: "AEMD",
    market: "XETRA",
    assetClass: "etf",
    currency: "EUR",
    isin: "IE00B4L5Y983",
  };

  it("supports EU/US equities & ETFs, not gold or unknown venues", () => {
    const p = new EodhdProvider({ apiKey: "k" });
    expect(p.supports("etf", "XETRA")).toBe(true);
    expect(p.supports("equity", "US")).toBe(true);
    expect(p.supports("etf", "IDX")).toBe(false); // not in the EODHD exchange map
    expect(p.supports("gold", "XAU")).toBe(false);
  });

  it("quotes a Xetra ETF via <code>.XETRA real-time and maps the payload", async () => {
    let seenUrl = "";
    let token: string | undefined;
    const p = new EodhdProvider({
      apiKey: "eodhd-key",
      fetch: mockFetch((url) => {
        seenUrl = url;
        token = new URL(url).searchParams.get("api_token") ?? undefined;
        return { body: { close: 50.5, previousClose: 49, timestamp: 1738972800 } };
      }),
    });
    const quote = await p.getQuote(xetra);
    expect(seenUrl).toContain("/real-time/AEMD.XETRA");
    expect(token).toBe("eodhd-key");
    expect(quote).toMatchObject({
      price: "50.5",
      currency: "EUR",
      previousClose: "49",
    });
    expect(quote?.asOf).toBe(new Date(1738972800 * 1000).toISOString());
  });

  it("resolves an ISIN-as-symbol to a ticker via search, preferring the Xetra listing", async () => {
    const urls: string[] = [];
    const p = new EodhdProvider({
      apiKey: "k",
      fetch: mockFetch((url) => {
        urls.push(url);
        if (url.includes("/search/")) {
          return {
            body: [
              { Code: "AEMD", Exchange: "LSE", Currency: "GBP" },
              { Code: "AEMD", Exchange: "XETRA", Currency: "EUR" },
            ],
          };
        }
        return { body: { close: 51 } };
      }),
    });
    const quote = await p.getQuote({ ...xetra, symbol: "IE00B4L5Y983" });
    expect(quote?.price).toBe("51");
    expect(urls.some((u) => u.includes("/search/IE00B4L5Y983"))).toBe(true);
    expect(urls.at(-1)).toContain("/real-time/AEMD.XETRA");
  });

  it("memoises ISIN resolution and returns null on a missing/NA close", async () => {
    let searchCalls = 0;
    const p = new EodhdProvider({
      apiKey: "k",
      fetch: mockFetch((url) => {
        if (url.includes("/search/")) {
          searchCalls++;
          return { body: [{ Code: "AEMD", Exchange: "XETRA", Currency: "EUR" }] };
        }
        return { body: { close: "NA" } };
      }),
    });
    const ref = { ...xetra, symbol: "IE00B4L5Y983" };
    expect(await p.getQuote(ref)).toBeNull(); // close "NA" → null
    await p.getQuote(ref);
    expect(searchCalls).toBe(1); // resolution memoised

    const down = new EodhdProvider({
      apiKey: "k",
      fetch: mockFetch(() => ({ ok: false, body: {} })),
    });
    expect(await down.getQuote(xetra)).toBeNull();
  });
});

describe("OpenFigiProvider", () => {
  it("does not quote (discovery-only)", async () => {
    const p = new OpenFigiProvider({ fetch: mockFetch(() => ({ body: [] })) });
    expect(p.supports("equity", "IDX")).toBe(false);
    expect(await p.getQuote(bbca)).toBeNull();
  });

  it("resolves an ISIN, prefers a record with a ticker, and sends the api key", async () => {
    let apiKey: string | undefined;
    let body: unknown;
    const p = new OpenFigiProvider({
      apiKey: "figi-key",
      fetch: mockFetch((_url, init) => {
        apiKey = (init?.headers as Record<string, string>)["X-OPENFIGI-APIKEY"];
        body = JSON.parse(init?.body as string);
        return {
          body: [
            {
              data: [
                { exchCode: "US", securityType: "Common Stock" }, // no ticker
                { ticker: "AAPL", name: "APPLE INC", exchCode: "US", securityType: "Common Stock" },
              ],
            },
          ],
        };
      }),
    });
    const resolved = await p.resolveISIN("US0378331005");
    expect(resolved).toMatchObject({ symbol: "AAPL", exchange: "US", name: "APPLE INC" });
    expect(apiKey).toBe("figi-key");
    expect(body).toEqual([{ idType: "ID_ISIN", idValue: "US0378331005" }]);
  });

  it("returns null for malformed ISINs, empty data, and failed requests", async () => {
    const ok = new OpenFigiProvider({
      fetch: mockFetch(() => ({ body: [{ data: [] }] })),
    });
    expect(await ok.resolveISIN("not-isin")).toBeNull(); // never calls fetch
    expect(await ok.resolveISIN("US0378331005")).toBeNull(); // empty data
    const down = new OpenFigiProvider({
      fetch: mockFetch(() => ({ ok: false, body: {} })),
    });
    expect(await down.resolveISIN("US0378331005")).toBeNull();
  });

  it("surfaces the ETP type for a UCITS ETF so it classifies as etf, not mutual_fund", async () => {
    // OpenFIGI labels UCITS ETFs securityType "ETP" but securityType2 "Mutual Fund";
    // the resolved type must keep the ETP signal (regression for #112/#111).
    const p = new OpenFigiProvider({
      fetch: mockFetch(() => ({
        body: [
          {
            data: [
              {
                ticker: "AEMD",
                name: "AM CR MSCI EMS ETF EUR DIST",
                exchCode: "GR",
                securityType: "ETP",
                securityType2: "Mutual Fund",
                marketSector: "Equity",
              },
            ],
          },
        ],
      })),
    });
    const resolved = await p.resolveISIN("LU1737652583");
    expect(resolved?.type?.toLowerCase()).toContain("etp");
    expect(assetClassFromType(resolved?.type)).toBe("etf");
  });
});

describe("assetClassFromType", () => {
  it("classifies an OpenFIGI ETP (UCITS ETF) as etf even when tagged 'Mutual Fund'", () => {
    expect(assetClassFromType("ETP Mutual Fund Equity")).toBe("etf");
  });

  it("classifies an exchange-traded reksa dana as etf", () => {
    expect(assetClassFromType("Exchange Traded Reksa Dana")).toBe("etf");
    expect(assetClassFromType("Exchange-Traded Fund")).toBe("etf");
  });

  it("still classifies a genuine open-end fund as mutual_fund", () => {
    expect(assetClassFromType("Open-End Fund Mutual Fund Equity")).toBe("mutual_fund");
    expect(assetClassFromType("Reksa Dana")).toBe("mutual_fund");
  });

  it("defaults unknown/empty types to equity", () => {
    expect(assetClassFromType("Common Stock")).toBe("equity");
    expect(assetClassFromType(null)).toBe("equity");
  });
});

describe("provider usage (getUsage)", () => {
  it("Twelve Data reports the daily window, falling back to per-minute", async () => {
    let seenUrl = "";
    const daily = new TwelveDataProvider("key", {
      fetch: mockFetch((url) => {
        seenUrl = url;
        return {
          body: {
            current_usage: 3,
            plan_limit: 8,
            daily_usage: 120,
            plan_daily_limit: 800,
          },
        };
      }),
    });
    expect(await daily.getUsage()).toEqual({ window: "day", used: 120, limit: 800 });
    expect(seenUrl).toContain("/api_usage?apikey=key");

    const minute = new TwelveDataProvider("key", {
      fetch: mockFetch(() => ({ body: { current_usage: 3, plan_limit: 8 } })),
    });
    expect(await minute.getUsage()).toEqual({ window: "minute", used: 3, limit: 8 });
  });

  it("EODHD reports the daily window and folds in extraLimit", async () => {
    let seenUrl = "";
    const p = new EodhdProvider({
      apiKey: "k",
      fetch: mockFetch((url) => {
        seenUrl = url;
        return { body: { apiRequests: 42, dailyRateLimit: 100000, extraLimit: 500 } };
      }),
    });
    expect(await p.getUsage()).toEqual({ window: "day", used: 42, limit: 100500 });
    expect(seenUrl).toContain("/user?api_token=k");
  });

  it("GoldAPI reports the month's used count against the free-tier limit, via the access-token header", async () => {
    let token: string | undefined;
    const p = new GoldApiProvider("gold-key", {
      fetch: mockFetch((_url, init) => {
        token = (init?.headers as Record<string, string>)["x-access-token"];
        return { body: { requests_month: 73 } };
      }),
    });
    expect(await p.getUsage()).toEqual({ window: "month", used: 73, limit: 100 });
    expect(token).toBe("gold-key");
  });

  it("returns null on an HTTP error or a shape with no usage fields", async () => {
    const down = new TwelveDataProvider("key", {
      fetch: mockFetch(() => ({ ok: false, body: {} })),
    });
    expect(await down.getUsage()).toBeNull();
    const empty = new EodhdProvider({
      apiKey: "k",
      fetch: mockFetch(() => ({ body: { name: "x" } })),
    });
    expect(await empty.getUsage()).toBeNull();
  });
});

describe("MarketDataService onCall hook", () => {
  it("fires with the provider name for each provider it invokes", async () => {
    const calls: string[] = [];
    const primary: MarketDataProvider = {
      name: "primary",
      supports: (ac) => ac === "equity",
      getQuote: async () => null, // miss → service tries the next supporter
    };
    const fallback: MarketDataProvider = {
      name: "fallback",
      supports: (ac) => ac === "equity",
      getQuote: async (ref) => ({
        price: "1",
        currency: ref.currency,
        asOf: "2026-02-08T00:00:00.000Z",
      }),
    };
    const svc = new MarketDataService([primary, fallback], {
      onCall: (name) => calls.push(name),
    });
    await svc.getQuote(bbca);
    expect(calls).toEqual(["primary", "fallback"]);
  });

  it("fires during search for providers that can search/resolve", async () => {
    const calls: string[] = [];
    const searcher: MarketDataProvider = {
      name: "searcher",
      supports: () => false,
      getQuote: async () => null,
      search: async () => [],
    };
    const svc = new MarketDataService([searcher], {
      onCall: (name) => calls.push(name),
    });
    await svc.search("BBCA");
    expect(calls).toEqual(["searcher"]);
  });
});
