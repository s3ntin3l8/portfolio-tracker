import { describe, it, expect } from "vitest";
import { BorseFrankfurtProvider } from "../../src/services/borse-frankfurt.js";

function mockFetch(body: unknown, status = 200) {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

describe("BorseFrankfurtProvider", () => {
  it("signs requests with client-date, x-client-traceid, and x-security headers", async () => {
    let capturedHeaders: Record<string, string> = {};
    const provider = new BorseFrankfurtProvider({
      salt: "testsalt",
      fetch: (async (_url: string, init?: RequestInit) => {
        capturedHeaders = Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>),
        );
        return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => "" };
      }) as unknown as typeof fetch,
    });

    await provider.search("Deutsche Post");

    expect(capturedHeaders).toHaveProperty("client-date");
    expect(capturedHeaders).toHaveProperty("x-client-traceid");
    expect(capturedHeaders).toHaveProperty("x-security");
    // All three are non-empty hex or ISO strings
    expect(capturedHeaders["x-client-traceid"]).toMatch(/^[0-9a-f]{32}$/);
    expect(capturedHeaders["x-security"]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("parses isin, wkn, and name from the equity_search response", async () => {
    const provider = new BorseFrankfurtProvider({
      salt: "testsalt",
      fetch: mockFetch({
        data: [
          { name: "Deutsche Post AG", isin: "DE000A1T8FV0", wkn: "A1T8FV", slug: "DPW" },
          { name: "No Identifiers" }, // should be skipped (no isin or wkn)
        ],
      }),
    });

    const results = await provider.search("Deutsche Post");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      name: "Deutsche Post AG",
      isin: "DE000A1T8FV0",
      wkn: "A1T8FV",
      symbol: "DPW",
      market: "XETRA",
      currency: "EUR",
      source: "borse-frankfurt",
    });
  });

  it("returns [] on a non-OK response", async () => {
    const provider = new BorseFrankfurtProvider({
      salt: "testsalt",
      fetch: (async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
        text: async () => "",
      })) as unknown as typeof fetch,
    });
    expect(await provider.search("anything")).toEqual([]);
  });
});
