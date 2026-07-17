import { describe, it, expect, vi } from "vitest";
import {
  createApiClient,
  ApiError,
  apiErrorCode,
  accountMismatchFromError,
  duplicatesFromError,
  visionProviderErrorFromError,
} from "../src/index.js";

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
    expect((seen?.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
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

  it("sets a JSON content-type only when a body is sent", async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = mockFetch((_url, init) => {
      seen = init;
      return { status: 204, body: undefined };
    });
    const client = createApiClient({
      baseUrl: "http://api.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    // Bodyless DELETE must NOT advertise application/json, or Fastify rejects the
    // empty body with FST_ERR_CTP_EMPTY_JSON_BODY → 400.
    await client.deletePortfolio("p1");
    expect((seen?.headers as Record<string, string>)["content-type"]).toBeUndefined();
    expect(seen?.body).toBeUndefined();

    // A write still carries the header so the server parses it.
    await client.createPortfolio({ name: "Stockbit", baseCurrency: "IDR" });
    expect((seen?.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("sends a File to the screenshot import endpoint as multipart FormData", async () => {
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

    const file = new Blob(["fake-image"], { type: "image/jpeg" });
    const result = await client.importScreenshot(file);
    expect(result).toMatchObject({ importId: "imp1" });
    expect(seen?.url).toBe("http://api.test/imports/screenshot");
    // Body must be FormData, NOT a JSON string.
    expect(seen?.init.body).toBeInstanceOf(FormData);
    // FormData uploads must NOT set a content-type header — the browser/fetch runtime
    // sets it with the multipart boundary automatically.
    expect((seen?.init.headers as Record<string, string>)["content-type"]).toBeUndefined();
  });

  it("omits the JSON content-type and sends FormData for screenshot uploads", async () => {
    let sentBody: unknown;
    const fetchImpl = mockFetch((_url, init) => {
      sentBody = init.body;
      return { status: 201, body: { importId: "imp2", drafts: [], errors: [] } };
    });
    const client = createApiClient({
      baseUrl: "http://api.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const file = new File(["data"], "screenshot.png", { type: "image/png" });
    await client.importScreenshot(file);
    // Both File and Blob inputs must produce a FormData body, not JSON.
    expect(sentBody).toBeInstanceOf(FormData);
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

describe("apiErrorCode", () => {
  it("extracts the error code from an ApiError body", () => {
    expect(apiErrorCode(new ApiError(503, JSON.stringify({ error: "pytr_not_available" })))).toBe(
      "pytr_not_available",
    );
  });

  it("returns null for non-ApiErrors", () => {
    expect(apiErrorCode(new Error("boom"))).toBeNull();
    expect(apiErrorCode(undefined)).toBeNull();
  });

  it("returns null when the body is not JSON or has no string error field", () => {
    expect(apiErrorCode(new ApiError(500, "Internal Server Error"))).toBeNull();
    expect(apiErrorCode(new ApiError(400, JSON.stringify({ error: 42 })))).toBeNull();
  });
});

describe("accountMismatchFromError", () => {
  it("returns null for non-ApiErrors", () => {
    expect(accountMismatchFromError(new Error("boom"))).toBeNull();
    expect(accountMismatchFromError(null)).toBeNull();
  });

  it("returns null for ApiErrors with status other than 409", () => {
    expect(
      accountMismatchFromError(new ApiError(400, JSON.stringify({ error: "account_mismatch" }))),
    ).toBeNull();
  });

  it("returns null when body is not JSON or error key doesn't match", () => {
    expect(accountMismatchFromError(new ApiError(409, "not-json"))).toBeNull();
    expect(
      accountMismatchFromError(
        new ApiError(409, JSON.stringify({ error: "duplicate_transactions" })),
      ),
    ).toBeNull();
  });

  it("returns the mismatch payload (minus the error key) on a valid 409", () => {
    const body = {
      error: "account_mismatch",
      existingOwner: "alice",
      incomingOwner: "bob",
    };
    const result = accountMismatchFromError(new ApiError(409, JSON.stringify(body)));
    expect(result).toEqual({ existingOwner: "alice", incomingOwner: "bob" });
    expect(result).not.toHaveProperty("error");
  });
});

describe("duplicatesFromError", () => {
  it("returns null for non-ApiErrors and non-409 status", () => {
    expect(duplicatesFromError(new Error("boom"))).toBeNull();
    expect(
      duplicatesFromError(new ApiError(400, JSON.stringify({ error: "duplicate_transactions" }))),
    ).toBeNull();
  });

  it("returns null when body is not JSON or error key doesn't match", () => {
    expect(duplicatesFromError(new ApiError(409, "not-json"))).toBeNull();
    expect(
      duplicatesFromError(new ApiError(409, JSON.stringify({ error: "account_mismatch" }))),
    ).toBeNull();
  });

  it("returns the duplicate conflict with count and duplicates on a valid 409", () => {
    const body = {
      error: "duplicate_transactions",
      count: 2,
      duplicates: [
        {
          name: "BBCA",
          action: "buy",
          quantity: "100",
          executedAt: "2026-01-01",
          matchedSource: "csv",
          matchedExecutedAt: "2026-01-01",
        },
      ],
    };
    const result = duplicatesFromError(new ApiError(409, JSON.stringify(body)));
    expect(result).toMatchObject({ count: 2 });
    expect(result?.duplicates).toHaveLength(1);
    expect(result?.duplicates[0].name).toBe("BBCA");
  });

  it("defaults count to 0 and duplicates to [] when fields are missing", () => {
    const body = { error: "duplicate_transactions" };
    const result = duplicatesFromError(new ApiError(409, JSON.stringify(body)));
    expect(result).toEqual({ count: 0, duplicates: [] });
  });
});

describe("visionProviderErrorFromError", () => {
  it("returns null for non-ApiErrors and non-502 status", () => {
    expect(visionProviderErrorFromError(new Error("boom"))).toBeNull();
    expect(
      visionProviderErrorFromError(
        new ApiError(500, JSON.stringify({ error: "screenshot_parse_failed" })),
      ),
    ).toBeNull();
  });

  it("returns null when body is not JSON or error key doesn't match", () => {
    expect(visionProviderErrorFromError(new ApiError(502, "not-json"))).toBeNull();
    expect(
      visionProviderErrorFromError(new ApiError(502, JSON.stringify({ error: "other" }))),
    ).toBeNull();
  });

  it("extracts provider + providerStatus from a valid 502", () => {
    const err = new ApiError(
      502,
      JSON.stringify({
        error: "screenshot_parse_failed",
        reason: "provider_error",
        provider: "claude",
        providerStatus: 429,
      }),
    );
    expect(visionProviderErrorFromError(err)).toEqual({ provider: "claude", providerStatus: 429 });
  });

  it("defaults provider/providerStatus to null when absent or wrong type", () => {
    const err = new ApiError(502, JSON.stringify({ error: "screenshot_parse_failed" }));
    expect(visionProviderErrorFromError(err)).toEqual({ provider: null, providerStatus: null });
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
    {
      name: "updateMe",
      call: (c) => c.updateMe({ name: "B" }),
      method: "PATCH",
      url: "/me",
      body: { name: "B" },
    },
    { name: "getNetWorth", call: (c) => c.getNetWorth(), method: "GET", url: "/networth" },
    {
      name: "getNetWorth total_paid",
      call: (c) => c.getNetWorth("total_paid"),
      method: "GET",
      url: "/networth?costBasis=total_paid",
    },
    {
      name: "getNetWorthHistory default",
      call: (c) => c.getNetWorthHistory(),
      method: "GET",
      url: "/networth/history?range=1y",
    },
    {
      name: "getNetWorthHistory range",
      call: (c) => c.getNetWorthHistory("3m"),
      method: "GET",
      url: "/networth/history?range=3m",
    },
    {
      name: "getPortfolioHistory",
      call: (c) => c.getPortfolioHistory("p1", "6m"),
      method: "GET",
      url: "/portfolios/p1/history?range=6m",
    },
    { name: "listPortfolios", call: (c) => c.listPortfolios(), method: "GET", url: "/portfolios" },
    {
      name: "createPortfolio",
      call: (c) => c.createPortfolio({ name: "X", baseCurrency: "IDR", accountHolderId: null }),
      method: "POST",
      url: "/portfolios",
      body: { name: "X", baseCurrency: "IDR", accountHolderId: null },
    },
    {
      name: "updatePortfolio",
      call: (c) => c.updatePortfolio("p1", { name: "Y" }),
      method: "PATCH",
      url: "/portfolios/p1",
      body: { name: "Y" },
    },
    {
      name: "listAccountHolders",
      call: (c) => c.listAccountHolders(),
      method: "GET",
      url: "/account-holders",
    },
    {
      name: "createAccountHolder",
      call: (c) => c.createAccountHolder({ name: "Kid", type: "child", birthYear: 2017 }),
      method: "POST",
      url: "/account-holders",
      body: { name: "Kid", type: "child", birthYear: 2017 },
    },
    {
      name: "updateAccountHolder",
      call: (c) => c.updateAccountHolder("h1", { name: "Kid R." }),
      method: "PATCH",
      url: "/account-holders/h1",
      body: { name: "Kid R." },
    },
    {
      name: "deleteAccountHolder",
      call: (c) => c.deleteAccountHolder("h1"),
      method: "DELETE",
      url: "/account-holders/h1",
    },
    {
      name: "listTransactions",
      call: (c) => c.listTransactions("p1"),
      method: "GET",
      url: "/portfolios/p1/transactions",
    },
    {
      name: "createTransaction",
      call: (c) => c.createTransaction("p1", txInput),
      method: "POST",
      url: "/portfolios/p1/transactions",
      body: txInput,
    },
    {
      name: "updateTransaction",
      call: (c) => c.updateTransaction("p1", "t1", txInput),
      method: "PATCH",
      url: "/portfolios/p1/transactions/t1",
      body: txInput,
    },
    {
      name: "bulkDeleteTransactions",
      call: (c) => c.bulkDeleteTransactions("p1", ["a", "b"]),
      method: "POST",
      url: "/portfolios/p1/transactions/bulk-delete",
      body: { ids: ["a", "b"] },
    },
    {
      name: "getQuote",
      call: (c) =>
        c.getQuote({ symbol: "BBCA", market: "IDX", assetClass: "equity", currency: "IDR" }),
      method: "GET",
      url: "/quotes?symbol=BBCA&market=IDX&assetClass=equity&currency=IDR",
    },
    {
      name: "searchInstruments q",
      call: (c) => c.searchInstruments("bca"),
      method: "GET",
      url: "/instruments?q=bca",
    },
    {
      name: "searchInstruments none",
      call: (c) => c.searchInstruments(),
      method: "GET",
      url: "/instruments",
    },
    {
      name: "lookupInstruments",
      call: (c) => c.lookupInstruments("apple inc"),
      method: "GET",
      url: "/instruments/lookup?q=apple%20inc",
    },
    {
      name: "getInstrument",
      call: (c) => c.getInstrument("i1"),
      method: "GET",
      url: "/instruments/i1",
    },
    {
      name: "getInstrumentHistory",
      call: (c) => c.getInstrumentHistory("i1", "1m"),
      method: "GET",
      url: "/instruments/i1/history?range=1m",
    },
    {
      name: "createInstrument",
      call: (c) =>
        c.createInstrument({
          symbol: "BBCA",
          market: "IDX",
          assetClass: "equity",
          unit: "shares",
          currency: "IDR",
          name: "BCA",
          isin: null,
        }),
      method: "POST",
      url: "/instruments",
      body: {
        symbol: "BBCA",
        market: "IDX",
        assetClass: "equity",
        unit: "shares",
        currency: "IDR",
        name: "BCA",
        isin: null,
      },
    },
    {
      name: "createCorporateAction",
      call: (c) =>
        c.createCorporateAction({
          instrumentId: "i1",
          type: "split",
          ratio: "2",
          exDate: "2026-01-01",
        }),
      method: "POST",
      url: "/corporate-actions",
      body: { instrumentId: "i1", type: "split", ratio: "2", exDate: "2026-01-01" },
    },
    {
      name: "listCorporateActions",
      call: (c) => c.listCorporateActions("i1"),
      method: "GET",
      url: "/instruments/i1/corporate-actions",
    },
    {
      name: "getHoldings",
      call: (c) => c.getHoldings("p1"),
      method: "GET",
      url: "/portfolios/p1/holdings",
    },
    {
      name: "getSummary",
      call: (c) => c.getSummary("p1"),
      method: "GET",
      url: "/portfolios/p1/summary",
    },
    {
      name: "getSummary total_paid",
      call: (c) => c.getSummary("p1", "total_paid"),
      method: "GET",
      url: "/portfolios/p1/summary?costBasis=total_paid",
    },
    {
      name: "getPerformance",
      call: (c) => c.getPerformance("p1"),
      method: "GET",
      url: "/portfolios/p1/performance",
    },
    {
      name: "importCsv default auto",
      call: (c) => c.importCsv("x"),
      method: "POST",
      url: "/imports/csv",
      body: { content: "x", format: "auto" },
    },
    {
      name: "importCsv with filename",
      call: (c) => c.importCsv("x", "orig.csv"),
      method: "POST",
      url: "/imports/csv",
      body: { content: "x", filename: "orig.csv", format: "auto" },
    },
    {
      name: "importCsv dkb",
      call: (c) => c.importCsv("x", undefined, "dkb"),
      method: "POST",
      url: "/imports/csv",
      body: { content: "x", format: "dkb" },
    },
    {
      name: "confirmImport",
      call: (c) => c.confirmImport("imp1", []),
      method: "POST",
      url: "/imports/imp1/confirm",
      body: {
        transactions: [],
        contracts: [],
        acknowledgeAccountMismatch: false,
        acknowledgeDuplicates: false,
      },
    },
    { name: "getImport", call: (c) => c.getImport("imp1"), method: "GET", url: "/imports/imp1" },
    {
      name: "listTransactionsByIds",
      call: (c) => c.listTransactionsByIds("p1", ["t1", "t2"]),
      method: "GET",
      url: "/portfolios/p1/transactions?ids=t1%2Ct2",
    },
    {
      name: "listTransactionsByIds with convertTo",
      call: (c) => c.listTransactionsByIds("p1", ["t1"], "IDR"),
      method: "GET",
      url: "/portfolios/p1/transactions?ids=t1&convertTo=IDR",
    },
    {
      name: "listNetworthTransactionsByIds",
      call: (c) => c.listNetworthTransactionsByIds(["t1", "t2"]),
      method: "GET",
      url: "/networth/transactions?ids=t1%2Ct2",
    },
    {
      name: "getNetworthAnomalies",
      call: (c) => c.getNetworthAnomalies(),
      method: "GET",
      url: "/networth/anomalies",
    },
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

  // ── triggerAdminJob force option ──────────────────────────────────────────

  it("triggerAdminJob: sends no body when force is not set", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = mockFetch((u, init) => {
      seen = { url: u, init };
      return { status: 200, body: { queued: true, name: "refresh-prices" } };
    });
    const client = createApiClient({
      baseUrl: base,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await client.triggerAdminJob("refresh-prices");
    expect(seen?.init.method).toBe("POST");
    expect(seen?.url).toBe(`${base}/admin/jobs/refresh-prices/trigger`);
    expect(seen?.init.body).toBeUndefined();
  });

  it("triggerAdminJob: sends { force: true } body when force option is set", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = mockFetch((u, init) => {
      seen = { url: u, init };
      return {
        status: 200,
        body: { queued: true, name: "refresh-instrument-metadata", force: true },
      };
    });
    const client = createApiClient({
      baseUrl: base,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await client.triggerAdminJob("refresh-instrument-metadata", { force: true });
    expect(seen?.init.method).toBe("POST");
    expect(JSON.parse(seen?.init.body as string)).toEqual({ force: true });
  });
});
