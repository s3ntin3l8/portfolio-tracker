import { describe, it, expect } from "vitest";
import {
  ASSET_CLASSES,
  isAssetClass,
  FixtureProvider,
  MarketDataService,
  TwelveDataProvider,
  GoldApiProvider,
  AntamProvider,
  NavProvider,
  YahooFinanceProvider,
  type InstrumentRef,
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

  it("quotes known symbols and returns null for unknown", async () => {
    expect(await provider.getQuote(bbca)).toMatchObject({
      price: "9500",
      currency: "IDR",
    });
    expect(
      await provider.getQuote({ ...bbca, symbol: "UNKNOWN" }),
    ).toBeNull();
  });

  it("supports any asset class / market", () => {
    expect(provider.supports("gold", "XAU")).toBe(true);
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
});

describe("YahooFinanceProvider", () => {
  const chartBody = (price: number) => ({
    chart: {
      result: [
        {
          meta: { regularMarketPrice: price, currency: "IDR", regularMarketTime: 1738972800 },
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
    expect(quote).toMatchObject({ price: "9500", currency: "IDR" });
    expect(quote?.asOf).toBe(new Date(1738972800 * 1000).toISOString());
  });

  it("supports equities/ETFs but not gold", () => {
    const provider = new YahooFinanceProvider();
    expect(provider.supports("equity", "IDX")).toBe(true);
    expect(provider.supports("etf", "IDX")).toBe(true);
    expect(provider.supports("gold", "XAU")).toBe(false);
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

describe("TwelveDataProvider", () => {
  it("quotes an IDX equity with the exchange param", async () => {
    let seenUrl = "";
    const provider = new TwelveDataProvider("key", {
      fetch: mockFetch((url) => {
        seenUrl = url;
        return { body: { price: "9500" } };
      }),
    });
    const quote = await provider.getQuote(bbca);
    expect(quote?.price).toBe("9500");
    expect(seenUrl).toContain("symbol=BBCA");
    expect(seenUrl).toContain("exchange=IDX");
  });

  it("converts gold (per-ounce) to a per-gram price", async () => {
    const provider = new TwelveDataProvider("key", {
      fetch: mockFetch(() => ({ body: { price: "31103.4768" } })),
    });
    const quote = await provider.getQuote({
      symbol: "XAU",
      market: "XAU",
      assetClass: "gold",
      currency: "IDR",
    });
    expect(quote?.price).toBe("1000"); // 31103.4768 / 31.1034768
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
