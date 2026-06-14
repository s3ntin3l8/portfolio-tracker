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

    await client.createPortfolio({ name: "Stockbit", baseCurrency: "IDR" });
    expect(JSON.parse(sentBody!)).toMatchObject({ name: "Stockbit" });
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
