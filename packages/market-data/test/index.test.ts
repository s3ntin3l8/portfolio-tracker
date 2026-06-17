import { describe, it, expect } from "vitest";
import {
  ASSET_CLASSES,
  isAssetClass,
  isIsin,
  FixtureProvider,
  MarketDataService,
  TwelveDataProvider,
  GoldApiProvider,
  BuybackProvider,
  NavProvider,
  YahooFinanceProvider,
  OpenFigiProvider,
  EodhdProvider,
  CoinGeckoProvider,
  assetClassFromType,
  mapExchange,
  resolveCryptoIsin,
  PRICEABLE_FOREIGN_MARKETS,
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

  it("returns null for all symbols (no fixture prices configured)", async () => {
    expect(await provider.getQuote(bbca)).toBeNull();
    expect(await provider.getQuote({ ...bbca, symbol: "UNKNOWN" })).toBeNull();
  });

  it("supports any asset class / market", () => {
    expect(provider.supports("gold", "XAU")).toBe(true);
  });

  it("returns null for gold spot (no fixture gold price — prefer no data over a stale value)", async () => {
    const goldRef = {
      symbol: "GOLD",
      market: "XAU",
      assetClass: "gold",
    } as const;
    expect(await provider.getQuote({ ...goldRef, currency: "IDR" })).toBeNull();
    expect(await provider.getQuote({ ...goldRef, currency: "EUR" })).toBeNull();
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

describe("mapExchange", () => {
  it("maps EU/EEA venues to their trading currency (case-insensitive)", () => {
    expect(mapExchange("AMS")).toMatchObject({ currency: "EUR" }); // Euronext Amsterdam
    expect(mapExchange("par")).toMatchObject({ currency: "EUR" }); // Euronext Paris
    expect(mapExchange("MIL")).toMatchObject({ currency: "EUR" }); // Borsa Italiana
    expect(mapExchange("MCE")).toMatchObject({ currency: "EUR" }); // BME Madrid
    expect(mapExchange("STU")).toMatchObject({ currency: "EUR" }); // Börse Stuttgart
    expect(mapExchange("EBS")).toMatchObject({ currency: "CHF" }); // SIX Swiss
    expect(mapExchange("GER")).toMatchObject({ market: "XETRA", currency: "EUR" });
  });

  it("leaves London (LSE) unmapped — its listings mix currencies", () => {
    expect(mapExchange("LSE")).toBeUndefined();
    expect(mapExchange(undefined)).toBeUndefined();
  });
});

describe("resolveCryptoIsin", () => {
  it("extracts the ticker from Trade Republic synthetic crypto ISINs", () => {
    expect(resolveCryptoIsin("XF000BTC0017")).toEqual({
      symbol: "BTC",
      market: "CRYPTO",
      assetClass: "crypto",
    });
    expect(resolveCryptoIsin("XF000ETH0019")).toEqual({
      symbol: "ETH",
      market: "CRYPTO",
      assetClass: "crypto",
    });
    expect(resolveCryptoIsin("xf000eth0019")).toMatchObject({ symbol: "ETH" }); // case-insensitive
  });

  it("returns undefined for a normal ISIN or empty input", () => {
    expect(resolveCryptoIsin("US7561091049")).toBeUndefined(); // Realty Income
    expect(resolveCryptoIsin("IE00BK5BQT80")).toBeUndefined(); // a UCITS ETF
    expect(resolveCryptoIsin(null)).toBeUndefined();
    expect(resolveCryptoIsin("")).toBeUndefined();
  });
});

describe("PRICEABLE_FOREIGN_MARKETS", () => {
  it("covers the venues we adopt over the broker's Xetra default, and excludes EU venues", () => {
    expect(PRICEABLE_FOREIGN_MARKETS.has("US")).toBe(true);
    expect(PRICEABLE_FOREIGN_MARKETS.has("CRYPTO")).toBe(true);
    expect(PRICEABLE_FOREIGN_MARKETS.has("XETRA")).toBe(false);
    expect(PRICEABLE_FOREIGN_MARKETS.has("PAR")).toBe(false);
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
    const fixture = new FixtureProvider({ BBCA: "9500" });
    const svc = new MarketDataService([goldOnly, fixture]);

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
    const svc = new MarketDataService([new FixtureProvider({ BBCA: "9500" })]);
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
      search: async () => Array.from({ length: 25 }, (_, i) => result({ symbol: `SYM${i}` })),
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

  it("supports equities/ETFs and gold spot, but not buyback gold", () => {
    const provider = new YahooFinanceProvider();
    expect(provider.supports("equity", "IDX")).toBe(true);
    expect(provider.supports("etf", "IDX")).toBe(true);
    expect(provider.supports("gold", "XAU")).toBe(true);
    // Spot only — the Antam/Galeri24 buyback markets belong to their own providers.
    expect(provider.supports("gold", "ANTAM")).toBe(false);
    expect(provider.supports("gold", "GALERI24")).toBe(false);
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

  it("sends a browser User-Agent on chart and search requests", async () => {
    const seenHeaders: Array<Record<string, string>> = [];
    const provider = new YahooFinanceProvider({
      fetch: mockFetch((_url, init) => {
        if (init?.headers) {
          seenHeaders.push(init.headers as Record<string, string>);
        }
        return { body: chartBody(9500) };
      }),
    });
    await provider.getQuote(bbca);
    expect(seenHeaders.length).toBeGreaterThan(0);
    expect(seenHeaders[0]["User-Agent"]).toMatch(/Mozilla/);
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

  // A EUR holding whose only same-currency line is a Börse Stuttgart (STU) cross-listing,
  // alongside a USD London (LSE) line. Resolution must pick the EUR line by currency, not
  // the wrong-currency London one.
  it("prefers the currency-matching EU listing over a USD London cross-listing", async () => {
    const searchEuVsLondon = {
      quotes: [
        { symbol: "VWRA.L", exchange: "LSE" }, // USD London line (unmapped) — must be skipped
        { symbol: "IE00BK5BQT80.SG", exchange: "STU" }, // STU → EUR — the match
      ],
    };
    const urls: string[] = [];
    const provider = new YahooFinanceProvider({
      fetch: mockFetch((url) => {
        urls.push(url);
        if (url.includes("/v1/finance/search")) return { body: searchEuVsLondon };
        return { body: url.includes("IE00BK5BQT80.SG") ? chartBody(110) : chartBody(null) };
      }),
    });
    const quote = await provider.getQuote(isinRef);
    expect(quote).toMatchObject({ price: "110", currency: "EUR" });
    expect(urls.at(-1)).toContain("/v8/finance/chart/IE00BK5BQT80.SG");
  });

  // When the only cross-listing is one we can't tie to the holding's market or currency
  // (e.g. a lone USD London line for a EUR holding), resolution returns no symbol rather
  // than pricing it and stamping the wrong currency — so getQuote yields null.
  it("returns null instead of pricing a wrong-currency-only cross-listing", async () => {
    const provider = new YahooFinanceProvider({
      fetch: mockFetch((url) => {
        if (url.includes("/v1/finance/search")) {
          return { body: { quotes: [{ symbol: "VWRA.L", exchange: "LSE" }] } };
        }
        return { body: chartBody(null) }; // direct symbol misses
      }),
    });
    expect(await provider.getQuote(isinRef)).toBeNull();
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
    expect(await eqProvider.getHistory(bbca)).toEqual([{ date: "2026-02-08", close: "9500" }]);

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

describe("BuybackProvider", () => {
  const antamRef: InstrumentRef = {
    symbol: "GOLD",
    market: "ANTAM",
    assetClass: "gold",
    currency: "IDR",
  };
  const galeri24Ref: InstrumentRef = {
    symbol: "GOLD",
    market: "GALERI24",
    assetClass: "gold",
    currency: "IDR",
  };

  it("supports only its own gold buyback market, not spot or other brands", () => {
    const antam = new BuybackProvider({
      name: "antam",
      market: "ANTAM",
      baseUrl: "https://x",
      fetch: mockFetch(() => ({ body: {} })),
    });
    expect(antam.supports("gold", "ANTAM")).toBe(true);
    expect(antam.supports("gold", "GALERI24")).toBe(false); // a different brand
    expect(antam.supports("gold", "XAU")).toBe(false); // buyback ≠ spot
    expect(antam.supports("equity", "IDX")).toBe(false);

    const galeri24 = new BuybackProvider({
      name: "galeri24",
      market: "GALERI24",
      baseUrl: "https://x",
      fetch: mockFetch(() => ({ body: {} })),
    });
    expect(galeri24.supports("gold", "GALERI24")).toBe(true);
    expect(galeri24.supports("gold", "ANTAM")).toBe(false);
  });

  it("reads the per-gram buyback price (incl. nested under data)", async () => {
    const top = new BuybackProvider({
      name: "antam",
      market: "ANTAM",
      baseUrl: "https://x",
      fetch: mockFetch(() => ({ body: { buyback: 1120000 } })),
    });
    expect((await top.getQuote(antamRef))?.price).toBe("1120000");

    const nested = new BuybackProvider({
      name: "galeri24",
      market: "GALERI24",
      baseUrl: "https://x",
      fetch: mockFetch(() => ({ body: { data: { harga_buyback: 2549000 } } })),
    });
    expect((await nested.getQuote(galeri24Ref))?.price).toBe("2549000");
  });

  it("returns null on an unrecognised shape or a failed request", async () => {
    const bad = new BuybackProvider({
      name: "antam",
      market: "ANTAM",
      baseUrl: "https://x",
      fetch: mockFetch(() => ({ body: { something: "else" } })),
    });
    expect(await bad.getQuote(antamRef)).toBeNull();

    const down = new BuybackProvider({
      name: "antam",
      market: "ANTAM",
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

  it("prefers the composite US listing's ticker when foreign venues are returned first", async () => {
    // OpenFIGI returns Verizon (US92343V1044) German-venue-first, where it trades as "BAC";
    // the resolver must skip past those to the US line carrying the canonical "VZ".
    const p = new OpenFigiProvider({
      fetch: mockFetch(() => ({
        body: [
          {
            data: [
              { ticker: "BAC", name: "VERIZON COMMUNICATIONS INC", exchCode: "GR" },
              { ticker: "BAC", name: "VERIZON COMMUNICATIONS INC", exchCode: "GF" },
              { ticker: "VZ", name: "VERIZON COMMUNICATIONS INC", exchCode: "US" },
            ],
          },
        ],
      })),
    });
    const resolved = await p.resolveISIN("US92343V1044");
    expect(resolved).toMatchObject({ symbol: "VZ", exchange: "US" });
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

  it("CoinGecko reports the month's credit usage via the /key endpoint, keyed by the demo header", async () => {
    let seenUrl = "";
    let header: string | undefined;
    const p = new CoinGeckoProvider({
      apiKey: "demo-key",
      fetch: mockFetch((url, init) => {
        seenUrl = url;
        header = (init?.headers as Record<string, string> | undefined)?.["x-cg-demo-api-key"];
        return {
          body: { monthly_call_credit: 10000, current_total_monthly_calls: 104 },
        };
      }),
    });
    expect(await p.getUsage()).toEqual({ window: "month", used: 104, limit: 10000 });
    expect(seenUrl).toContain("/key");
    expect(header).toBe("demo-key");
  });

  it("CoinGecko has no live usage when keyless (falls back to the local counter)", async () => {
    let called = false;
    const p = new CoinGeckoProvider({
      fetch: mockFetch(() => {
        called = true;
        return { body: {} };
      }),
    });
    expect(await p.getUsage()).toBeNull();
    expect(called).toBe(false); // no key → no /key request at all
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

describe("YahooFinanceProvider crypto", () => {
  it("supports crypto and quotes via the <TICKER>-<CURRENCY> pair", async () => {
    let calledUrl = "";
    const provider = new YahooFinanceProvider({
      fetch: mockFetch((url) => {
        calledUrl = url;
        return {
          body: {
            chart: {
              result: [
                {
                  meta: {
                    regularMarketPrice: 65000,
                    currency: "USD",
                    regularMarketTime: 1738972800,
                    previousClose: 64000,
                  },
                },
              ],
            },
          },
        };
      }),
    });
    expect(provider.supports("crypto", "CRYPTO")).toBe(true);
    const btc: InstrumentRef = {
      symbol: "BTC",
      market: "CRYPTO",
      assetClass: "crypto",
      currency: "USD",
    };
    const quote = await provider.getQuote(btc);
    expect(calledUrl).toContain("/v8/finance/chart/BTC-USD");
    expect(quote).toMatchObject({ price: "65000", currency: "USD", previousClose: "64000" });
  });
});

describe("YahooFinanceProvider gold spot", () => {
  const TROY_OUNCE_GRAMS = 31.1034768;
  const xauIdr: InstrumentRef = {
    symbol: "XAU",
    market: "XAU",
    assetClass: "gold",
    currency: "IDR",
  };

  it("quotes the XAU<CCY>=X pair, converting per-ounce to per-gram", async () => {
    let calledUrl = "";
    // Per-troy-ounce price/baseline in IDR; the provider returns per-gram.
    const perOunce = 40_000_000;
    const prevOunce = 39_000_000;
    const provider = new YahooFinanceProvider({
      fetch: mockFetch((url) => {
        calledUrl = url;
        return {
          body: {
            chart: {
              result: [
                {
                  meta: {
                    regularMarketPrice: perOunce,
                    currency: "IDR",
                    regularMarketTime: 1738972800,
                    previousClose: prevOunce,
                  },
                },
              ],
            },
          },
        };
      }),
    });
    const quote = await provider.getQuote(xauIdr);
    expect(calledUrl).toContain(`/v8/finance/chart/${encodeURIComponent("XAUIDR=X")}`);
    expect(quote?.currency).toBe("IDR");
    expect(quote?.price).toBe(String(perOunce / TROY_OUNCE_GRAMS));
    expect(quote?.previousClose).toBe(String(prevOunce / TROY_OUNCE_GRAMS));
  });

  it("maps a USD gold ref to the XAUUSD=X pair", async () => {
    let calledUrl = "";
    const provider = new YahooFinanceProvider({
      fetch: mockFetch((url) => {
        calledUrl = url;
        return { body: { chart: { result: [{ meta: { regularMarketPrice: 2600 } }] } } };
      }),
    });
    await provider.getQuote({ ...xauIdr, currency: "USD" });
    expect(calledUrl).toContain(`/v8/finance/chart/${encodeURIComponent("XAUUSD=X")}`);
  });

  it("converts history closes to per-gram", async () => {
    const provider = new YahooFinanceProvider({
      fetch: mockFetch(() => ({
        body: {
          chart: {
            result: [
              {
                timestamp: [1738972800, 1739059200],
                indicators: { quote: [{ close: [40_000_000, 41_000_000] }] },
              },
            ],
          },
        },
      })),
    });
    const candles = await provider.getHistory(xauIdr, "1mo");
    expect(candles).toEqual([
      {
        date: new Date(1738972800 * 1000).toISOString().slice(0, 10),
        close: String(40_000_000 / TROY_OUNCE_GRAMS),
      },
      {
        date: new Date(1739059200 * 1000).toISOString().slice(0, 10),
        close: String(41_000_000 / TROY_OUNCE_GRAMS),
      },
    ]);
  });
});

describe("CoinGeckoProvider", () => {
  const btc: InstrumentRef = {
    symbol: "BTC",
    market: "CRYPTO",
    assetClass: "crypto",
    currency: "USD",
  };
  const searchBody = {
    coins: [
      { id: "binance-peg-bitcoin", symbol: "BTCB", name: "Binance-Peg BTC" },
      { id: "bitcoin", symbol: "BTC", name: "Bitcoin" },
    ],
  };

  it("supports crypto and gold spot (XAU), not other asset classes or markets", () => {
    const p = new CoinGeckoProvider();
    expect(p.supports("crypto", "CRYPTO")).toBe(true);
    expect(p.supports("gold", "XAU")).toBe(true);
    expect(p.supports("gold", "ANTAM")).toBe(false); // buyback ≠ spot
    expect(p.supports("equity", "IDX")).toBe(false);
  });

  it("resolves the ticker to a coin id and quotes with a previous close", async () => {
    const urls: string[] = [];
    const p = new CoinGeckoProvider({
      fetch: mockFetch((url) => {
        urls.push(url);
        if (url.includes("/search")) return { body: searchBody };
        return {
          body: {
            bitcoin: { usd: 65000, usd_24h_change: 4, last_updated_at: 1738972800 },
          },
        };
      }),
    });
    const quote = await p.getQuote(btc);
    // picks the exact-symbol match (bitcoin), not the peg coin listed first
    expect(urls.some((u) => u.includes("ids=bitcoin&vs_currencies=usd"))).toBe(true);
    expect(quote?.price).toBe("65000");
    expect(quote?.currency).toBe("USD");
    // previousClose = 65000 / (1 + 4/100) = 62500
    expect(quote?.previousClose).toBe("62500");
    expect(quote?.asOf).toBe(new Date(1738972800 * 1000).toISOString());
  });

  it("honours the instrument currency via vs_currency", async () => {
    let priceUrl = "";
    const p = new CoinGeckoProvider({
      fetch: mockFetch((url) => {
        if (url.includes("/search")) return { body: searchBody };
        priceUrl = url;
        return { body: { bitcoin: { idr: 1_000_000_000 } } };
      }),
    });
    const quote = await p.getQuote({ ...btc, currency: "IDR" });
    expect(priceUrl).toContain("vs_currencies=idr");
    expect(quote?.price).toBe("1000000000");
    expect(quote?.previousClose).toBeNull(); // no 24h change in the payload
  });

  it("memoises the ticker→id resolution across calls", async () => {
    let searchCalls = 0;
    const p = new CoinGeckoProvider({
      fetch: mockFetch((url) => {
        if (url.includes("/search")) {
          searchCalls++;
          return { body: searchBody };
        }
        return { body: { bitcoin: { usd: 65000 } } };
      }),
    });
    await p.getQuote(btc);
    await p.getQuote(btc);
    expect(searchCalls).toBe(1);
  });

  it("maps market_chart prices to candles, translating the range to days", async () => {
    let historyUrl = "";
    const p = new CoinGeckoProvider({
      fetch: mockFetch((url) => {
        if (url.includes("/search")) return { body: searchBody };
        historyUrl = url;
        return {
          body: {
            prices: [
              [1738972800000, 64000],
              [1739059200000, 65000],
            ],
          },
        };
      }),
    });
    const candles = await p.getHistory(btc, "1y");
    expect(historyUrl).toContain("/coins/bitcoin/market_chart");
    expect(historyUrl).toContain("days=365");
    expect(candles).toHaveLength(2);
    expect(candles[0]).toMatchObject({
      date: new Date(1738972800000).toISOString().slice(0, 10),
      close: "64000",
    });
  });

  it("discovers crypto by ticker/name as CRYPTO/USD results", async () => {
    const p = new CoinGeckoProvider({
      fetch: mockFetch(() => ({ body: searchBody })),
    });
    const results = await p.search("btc");
    expect(results).toContainEqual({
      symbol: "BTC",
      name: "Bitcoin",
      market: "CRYPTO",
      assetClass: "crypto",
      currency: "USD",
      source: "coingecko",
    });
  });

  it("returns null/empty when the coin can't be resolved or the API errors", async () => {
    const unknown = new CoinGeckoProvider({
      fetch: mockFetch(() => ({ body: { coins: [] } })),
    });
    expect(await unknown.getQuote(btc)).toBeNull();
    expect(await unknown.getHistory(btc, "1y")).toEqual([]);

    const down = new CoinGeckoProvider({
      fetch: mockFetch(() => ({ ok: false, body: {} })),
    });
    expect(await down.search("btc")).toEqual([]);
  });

  it("sends the demo api-key header when configured", async () => {
    let header: string | undefined;
    const p = new CoinGeckoProvider({
      apiKey: "demo-key",
      fetch: mockFetch((_url, init) => {
        header = (init?.headers as Record<string, string> | undefined)?.["x-cg-demo-api-key"];
        return { body: { coins: [] } };
      }),
    });
    await p.search("btc");
    expect(header).toBe("demo-key");
  });
});

describe("CoinGeckoProvider gold spot (PAXG)", () => {
  const TROY_OUNCE_GRAMS = 31.1034768;
  const goldEur: InstrumentRef = {
    symbol: "GOLD",
    market: "XAU",
    assetClass: "gold",
    currency: "EUR",
  };

  it("quotes gold via pax-gold without a search call, converting oz→g", async () => {
    const urls: string[] = [];
    const perOz = 3719.8;
    const p = new CoinGeckoProvider({
      fetch: mockFetch((url) => {
        urls.push(url);
        return {
          body: {
            "pax-gold": {
              eur: perOz,
              eur_24h_change: 2,
              last_updated_at: 1738972800,
            },
          },
        };
      }),
    });
    const quote = await p.getQuote(goldEur);
    // No search call — coin id is a fixed constant, not resolved from the symbol
    expect(urls.every((u) => !u.includes("/search"))).toBe(true);
    expect(urls.some((u) => u.includes("ids=pax-gold"))).toBe(true);
    expect(urls.some((u) => u.includes("vs_currencies=eur"))).toBe(true);
    // Price is per-gram, not per-ounce
    const perGram = perOz / TROY_OUNCE_GRAMS;
    expect(quote?.price).toBe(String(perGram));
    expect(quote?.currency).toBe("EUR");
    // previousClose = perGram / (1 + 2/100)
    expect(quote?.previousClose).toBe(String(perGram / (1 + 2 / 100)));
    expect(quote?.asOf).toBe(new Date(1738972800 * 1000).toISOString());
  });

  it("prices gold in any currency via vs_currency (IDR, USD, EUR)", async () => {
    const perOzIdr = 76_667_539;
    let priceUrl = "";
    const p = new CoinGeckoProvider({
      fetch: mockFetch((url) => {
        priceUrl = url;
        return { body: { "pax-gold": { idr: perOzIdr } } };
      }),
    });
    const quote = await p.getQuote({ ...goldEur, currency: "IDR" });
    expect(priceUrl).toContain("vs_currencies=idr");
    expect(quote?.price).toBe(String(perOzIdr / TROY_OUNCE_GRAMS));
    expect(quote?.currency).toBe("IDR");
  });

  it("converts history closes from per-oz to per-gram", async () => {
    const p = new CoinGeckoProvider({
      fetch: mockFetch(() => ({
        body: {
          prices: [
            [1738972800000, 3700],
            [1739059200000, 3720],
          ],
        },
      })),
    });
    const candles = await p.getHistory(goldEur, "1mo");
    expect(candles).toHaveLength(2);
    expect(candles[0].close).toBe(String(3700 / TROY_OUNCE_GRAMS));
    expect(candles[1].close).toBe(String(3720 / TROY_OUNCE_GRAMS));
  });

  it("returns null when the pax-gold row is absent from the response", async () => {
    const p = new CoinGeckoProvider({
      fetch: mockFetch(() => ({ body: {} })),
    });
    expect(await p.getQuote(goldEur)).toBeNull();
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
