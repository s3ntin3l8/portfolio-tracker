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
