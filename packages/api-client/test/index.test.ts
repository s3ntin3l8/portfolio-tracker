import { describe, it, expect, vi } from "vitest";
import { createApiClient, ApiError } from "../src/index.js";

function mockFetch(
  responder: (url: string, init: RequestInit) => { status: number; body: unknown },
) {
  return vi.fn(async (url: string, init: RequestInit) => {
    const { status, body } = responder(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  });
}

describe("createApiClient", () => {
  it("sends the bearer token and base URL, and parses the response", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = mockFetch((url, init) => {
      seen = { url, init };
      return { status: 200, body: [{ id: "p1", name: "BCA" }] };
    });
    const client = createApiClient({
      baseUrl: "http://api.test",
      getToken: () => "tok",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const portfolios = await client.listPortfolios();
    expect(portfolios).toEqual([{ id: "p1", name: "BCA" }]);
    expect(seen?.url).toBe("http://api.test/portfolios");
    expect((seen?.init.headers as Record<string, string>).authorization).toBe(
      "Bearer tok",
    );
  });

  it("serializes bodies on writes", async () => {
    let sentBody: string | undefined;
    const fetchImpl = mockFetch((_url, init) => {
      sentBody = init.body as string;
      return { status: 201, body: { id: "p2", name: "Stockbit" } };
    });
    const client = createApiClient({
      baseUrl: "http://api.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await client.createPortfolio({
      name: "Stockbit",
      baseCurrency: "IDR",
      portfolioType: "standard",
    });
    expect(JSON.parse(sentBody!)).toMatchObject({ name: "Stockbit" });
  });

  it("posts a base64 image + mimeType to the screenshot import endpoint", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = mockFetch((url, init) => {
      seen = { url, init };
      return { status: 201, body: { importId: "imp1", drafts: [], errors: [] } };
    });
    const client = createApiClient({
      baseUrl: "http://api.test",
      getToken: () => "tok",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.importScreenshot("port1", "ZmFrZQ==", "image/jpeg");
    expect(result).toMatchObject({ importId: "imp1" });
    expect(seen?.url).toBe("http://api.test/portfolios/port1/imports/screenshot");
    expect(JSON.parse(seen?.init.body as string)).toEqual({
      image: "ZmFrZQ==",
      mimeType: "image/jpeg",
    });
  });

  it("defaults the screenshot mimeType to image/png", async () => {
    let sentBody: string | undefined;
    const fetchImpl = mockFetch((_url, init) => {
      sentBody = init.body as string;
      return { status: 201, body: { importId: "imp2", drafts: [], errors: [] } };
    });
    const client = createApiClient({
      baseUrl: "http://api.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await client.importScreenshot("port1", "ZmFrZQ==");
    expect(JSON.parse(sentBody!).mimeType).toBe("image/png");
  });

  it("throws ApiError on non-2xx", async () => {
    const fetchImpl = mockFetch(() => ({ status: 404, body: { error: "x" } }));
    const client = createApiClient({
      baseUrl: "http://api.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.getHoldings("nope")).rejects.toBeInstanceOf(ApiError);
  });
});

// Exhaustive method → (verb, path, body) mapping. Each case drives one client call
// through the mocked fetch and asserts the request it emits.
describe("createApiClient request methods", () => {
  type C = ReturnType<typeof createApiClient>;
  interface Case {
    name: string;
    call: (c: C) => Promise<unknown>;
    method: string;
    url: string;
    body?: unknown;
  }

  const base = "http://api.test";
  const txInput = {
    type: "buy" as const,
    instrumentId: "i1",
    quantity: "10",
    price: "100",
    fees: "0",
    currency: "IDR",
    executedAt: "2026-01-01T00:00:00.000Z",
    source: "manual" as const,
  };

  const cases: Case[] = [
    { name: "me", call: (c) => c.me(), method: "GET", url: "/me" },
    { name: "updateMe", call: (c) => c.updateMe({ name: "B" }), method: "PATCH", url: "/me", body: { name: "B" } },
    { name: "getNetWorth", call: (c) => c.getNetWorth(), method: "GET", url: "/networth" },
    { name: "getNetWorthHistory default", call: (c) => c.getNetWorthHistory(), method: "GET", url: "/networth/history?range=1y" },
    { name: "getNetWorthHistory range", call: (c) => c.getNetWorthHistory("3m"), method: "GET", url: "/networth/history?range=3m" },
    { name: "getPortfolioHistory", call: (c) => c.getPortfolioHistory("p1", "6m"), method: "GET", url: "/portfolios/p1/history?range=6m" },
    { name: "listPortfolios", call: (c) => c.listPortfolios(), method: "GET", url: "/portfolios" },
    { name: "createPortfolio", call: (c) => c.createPortfolio({ name: "X", baseCurrency: "IDR", portfolioType: "standard" }), method: "POST", url: "/portfolios", body: { name: "X", baseCurrency: "IDR", portfolioType: "standard" } },
    { name: "updatePortfolio", call: (c) => c.updatePortfolio("p1", { name: "Y" }), method: "PATCH", url: "/portfolios/p1", body: { name: "Y" } },
    { name: "listTransactions", call: (c) => c.listTransactions("p1"), method: "GET", url: "/portfolios/p1/transactions" },
    { name: "createTransaction", call: (c) => c.createTransaction("p1", txInput), method: "POST", url: "/portfolios/p1/transactions", body: txInput },
    { name: "updateTransaction", call: (c) => c.updateTransaction("p1", "t1", txInput), method: "PATCH", url: "/portfolios/p1/transactions/t1", body: txInput },
    { name: "bulkDeleteTransactions", call: (c) => c.bulkDeleteTransactions("p1", ["a", "b"]), method: "POST", url: "/portfolios/p1/transactions/bulk-delete", body: { ids: ["a", "b"] } },
    { name: "getQuote", call: (c) => c.getQuote({ symbol: "BBCA", market: "IDX", assetClass: "equity", currency: "IDR" }), method: "GET", url: "/quotes?symbol=BBCA&market=IDX&assetClass=equity&currency=IDR" },
    { name: "searchInstruments q", call: (c) => c.searchInstruments("bca"), method: "GET", url: "/instruments?q=bca" },
    { name: "searchInstruments none", call: (c) => c.searchInstruments(), method: "GET", url: "/instruments" },
    { name: "lookupInstruments", call: (c) => c.lookupInstruments("apple inc"), method: "GET", url: "/instruments/lookup?q=apple%20inc" },
    { name: "getInstrument", call: (c) => c.getInstrument("i1"), method: "GET", url: "/instruments/i1" },
    { name: "getInstrumentHistory", call: (c) => c.getInstrumentHistory("i1", "1m"), method: "GET", url: "/instruments/i1/history?range=1m" },
    { name: "createInstrument", call: (c) => c.createInstrument({ symbol: "BBCA", market: "IDX", assetClass: "equity", unit: "shares", currency: "IDR", name: "BCA", isin: null }), method: "POST", url: "/instruments", body: { symbol: "BBCA", market: "IDX", assetClass: "equity", unit: "shares", currency: "IDR", name: "BCA", isin: null } },
    { name: "createCorporateAction", call: (c) => c.createCorporateAction({ instrumentId: "i1", type: "split", ratio: "2", exDate: "2026-01-01" }), method: "POST", url: "/corporate-actions", body: { instrumentId: "i1", type: "split", ratio: "2", exDate: "2026-01-01" } },
    { name: "listCorporateActions", call: (c) => c.listCorporateActions("i1"), method: "GET", url: "/instruments/i1/corporate-actions" },
    { name: "getHoldings", call: (c) => c.getHoldings("p1"), method: "GET", url: "/portfolios/p1/holdings" },
    { name: "getSummary", call: (c) => c.getSummary("p1"), method: "GET", url: "/portfolios/p1/summary" },
    { name: "getPerformance", call: (c) => c.getPerformance("p1"), method: "GET", url: "/portfolios/p1/performance" },
    { name: "importCsv default auto", call: (c) => c.importCsv("p1", "x"), method: "POST", url: "/portfolios/p1/imports/csv", body: { content: "x", format: "auto" } },
    { name: "importCsv dkb", call: (c) => c.importCsv("p1", "x", "dkb"), method: "POST", url: "/portfolios/p1/imports/csv", body: { content: "x", format: "dkb" } },
    { name: "confirmImport", call: (c) => c.confirmImport("imp1", []), method: "POST", url: "/imports/imp1/confirm", body: { transactions: [] } },
  ];

  it.each(cases)("$name → $method $url", async ({ call, method, url, body }) => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = mockFetch((u, init) => {
      seen = { url: u, init };
      return { status: 200, body: {} };
    });
    const client = createApiClient({
      baseUrl: base,
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await call(client);
    expect(seen?.init.method).toBe(method);
    expect(seen?.url).toBe(`${base}${url}`);
    if (body === undefined) {
      expect(seen?.init.body).toBeUndefined();
    } else {
      expect(JSON.parse(seen?.init.body as string)).toEqual(body);
    }
  });

  it("returns undefined for 204 responses (delete methods)", async () => {
    const fetchImpl = mockFetch((url, init) => {
      void url;
      void init;
      return { status: 204, body: undefined };
    });
    const client = createApiClient({
      baseUrl: base,
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.deletePortfolio("p1")).resolves.toBeUndefined();
    await expect(client.deleteTransaction("p1", "t1")).resolves.toBeUndefined();
  });

  it("omits the Authorization header when no token is configured", async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = mockFetch((_url, init) => {
      seen = init;
      return { status: 200, body: [] };
    });
    const client = createApiClient({
      baseUrl: base,
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await client.listPortfolios();
    expect((seen?.headers as Record<string, string>).authorization).toBeUndefined();
  });
});
