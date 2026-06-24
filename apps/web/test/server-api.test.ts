import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted shared state: set the auth env *before* server-api.ts is imported (its
// `authConfigured` is a module-level constant), and expose mutable session/cookie/client
// hooks the mocks below read on each call.
const h = vi.hoisted(() => {
  process.env.AUTH_SECRET = "test-secret";
  process.env.AUTHENTIK_ISSUER = "https://auth.test/o/p/";
  return {
    session: null as null | { accessToken?: string },
    cookies: {} as Record<string, string>,
    // `never[]` params so any concretely-typed stub (e.g. `(id: string) => …`) assigns.
    client: {} as Record<string, (...args: never[]) => unknown>,
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      h.cookies[name] !== undefined ? { value: h.cookies[name] } : undefined,
  }),
}));
vi.mock("@/auth", () => ({ auth: async () => h.session }));
vi.mock("@portfolio/api-client", () => ({ createApiClient: () => h.client }));

import * as api from "../src/lib/server-api";

const PF = [
  { id: "p1", name: "Main", baseCurrency: "IDR" },
  { id: "p2", name: "DKB", baseCurrency: "EUR" },
];

beforeEach(() => {
  h.session = { accessToken: "tok" }; // signed in by default
  h.cookies = {};
  h.client = {
    // resolveSelection() now always calls listAccountHolders — default to empty list.
    listAccountHolders: async () => [],
  };
});

describe("getSelectedPortfolioId", () => {
  it("returns the cookie's uuid, or null for 'all'/absent/holder scope", async () => {
    h.cookies = { pf: "p2" };
    expect(await api.getSelectedPortfolioId()).toBe("p2");
    h.cookies = { pf: "all" };
    expect(await api.getSelectedPortfolioId()).toBeNull();
    h.cookies = {};
    expect(await api.getSelectedPortfolioId()).toBeNull();
    // Holder scope also returns null (it's not a portfolio selection).
    h.cookies = { pf: "holder:h1" };
    expect(await api.getSelectedPortfolioId()).toBeNull();
  });
});

describe("resolveSelection", () => {
  it("validates the cookie against the live list", async () => {
    h.client.listPortfolios = async () => PF;
    h.cookies = { pf: "p2" };
    expect(await api.resolveSelection()).toMatchObject({
      status: "ok",
      selectedId: "p2",
      selectedHolderId: null,
    });
  });

  it("collapses an unknown/stale id to the aggregate", async () => {
    h.client.listPortfolios = async () => PF;
    h.cookies = { pf: "ghost" };
    const res = await api.resolveSelection();
    expect(res.selectedId).toBeNull();
    expect(res.portfolios).toHaveLength(2);
  });

  it("resolves a holder scope and validates against qualifying holders (≥2 portfolios)", async () => {
    // p1 and p2 both belong to holder h1 → h1 qualifies (≥2 portfolios).
    const pfWithHolders = [
      { id: "p1", name: "A", baseCurrency: "IDR", accountHolderId: "h1" },
      { id: "p2", name: "B", baseCurrency: "EUR", accountHolderId: "h1" },
    ];
    h.client.listPortfolios = async () => pfWithHolders;
    h.client.listAccountHolders = async () => [{ id: "h1", name: "Self" }];
    h.cookies = { pf: "holder:h1" };
    const res = await api.resolveSelection();
    expect(res.selectedId).toBeNull();
    expect(res.selectedHolderId).toBe("h1");
  });

  it("collapses a stale holder cookie to aggregate when holder no longer qualifies", async () => {
    // Only one portfolio for h2 → h2 doesn't qualify (< 2 portfolios).
    h.client.listPortfolios = async () => [
      { id: "p1", name: "A", baseCurrency: "IDR", accountHolderId: "h2" },
    ];
    h.client.listAccountHolders = async () => [{ id: "h2", name: "Child" }];
    h.cookies = { pf: "holder:h2" };
    const res = await api.resolveSelection();
    expect(res.selectedId).toBeNull();
    expect(res.selectedHolderId).toBeNull();
  });

  it("reports unavailable when not signed in", async () => {
    h.session = null;
    expect(await api.resolveSelection()).toMatchObject({
      status: "unavailable",
      selectedId: null,
      selectedHolderId: null,
    });
  });
});

describe("loadTransactionsAcrossPortfolios (holder scope)", () => {
  it("filters to the holder's portfolios when holder scope is active", async () => {
    const pfWithHolders = [
      { id: "p1", name: "Self-A", baseCurrency: "IDR", accountHolderId: "h1" },
      { id: "p2", name: "Self-B", baseCurrency: "EUR", accountHolderId: "h1" },
      { id: "p3", name: "Other",  baseCurrency: "IDR", accountHolderId: "h2" },
    ];
    h.client.listPortfolios = async () => pfWithHolders;
    h.client.listTransactions = async (id: string) =>
      id === "p1"
        ? [{ id: "t1", portfolioId: "p1", type: "buy" }]
        : id === "p2"
          ? [{ id: "t2", portfolioId: "p2", type: "sell" }]
          : [{ id: "t3", portfolioId: "p3", type: "buy" }];
    h.cookies = { pf: "holder:h1" };

    const res = await api.loadTransactionsAcrossPortfolios();
    expect(res.status).toBe("ok");
    // Only p1 and p2 transactions — p3 belongs to h2, not h1.
    expect(res.transactions).toHaveLength(2);
    expect(res.transactions.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
  });
});

describe("loadHoldings", () => {
  it("uses the networth aggregate when no portfolio is selected", async () => {
    h.client.listPortfolios = async () => PF;
    const getNetWorth = vi.fn(async () => ({
      holdings: [{ instrumentId: "i1", quantity: "1" }],
      displayCurrency: "IDR",
    }));
    h.client.getNetWorth = getNetWorth;
    h.client.getSummary = vi.fn();

    const res = await api.loadHoldings();
    expect(res).toMatchObject({ status: "ok", displayCurrency: "IDR" });
    expect(res.holdings).toHaveLength(1);
    expect(getNetWorth).toHaveBeenCalled();
    expect(h.client.getSummary).not.toHaveBeenCalled();
  });

  it("uses the per-portfolio summary when one is selected", async () => {
    h.client.listPortfolios = async () => PF;
    h.cookies = { pf: "p2" };
    const getSummary = vi.fn(async (id: string) => ({
      holdings: [{ instrumentId: "x", quantity: "2" }],
      displayCurrency: "EUR",
      _id: id,
    }));
    h.client.getSummary = getSummary;
    h.client.getNetWorth = vi.fn();

    const res = await api.loadHoldings();
    expect(res).toMatchObject({ status: "ok", displayCurrency: "EUR" });
    expect(getSummary).toHaveBeenCalledWith("p2", undefined);
    expect(h.client.getNetWorth).not.toHaveBeenCalled();
  });

  it("is empty with no portfolios and unavailable on error / signed out", async () => {
    h.client.listPortfolios = async () => [];
    expect(await api.loadHoldings()).toMatchObject({ status: "empty" });

    h.client.listPortfolios = async () => {
      throw new Error("boom");
    };
    expect(await api.loadHoldings()).toMatchObject({ status: "unavailable" });

    h.session = null;
    expect(await api.loadHoldings()).toMatchObject({ status: "unavailable" });
  });
});

describe("loadTransactionsAcrossPortfolios", () => {
  it("merges every portfolio's transactions and tags the portfolio name", async () => {
    h.client.listPortfolios = async () => PF;
    h.client.listTransactions = async (id: string) =>
      id === "p1"
        ? [{ id: "t1", portfolioId: "p1", type: "buy" }]
        : [{ id: "t2", portfolioId: "p2", type: "sell" }];

    const res = await api.loadTransactionsAcrossPortfolios();
    expect(res.status).toBe("ok");
    expect(res.transactions).toHaveLength(2);
    expect(res.transactions.find((t) => t.id === "t1")?.portfolioName).toBe("Main");
    expect(res.transactions.find((t) => t.id === "t2")?.portfolioName).toBe("DKB");
  });

  it("is empty with no portfolios and unavailable on error", async () => {
    h.client.listPortfolios = async () => [];
    expect(await api.loadTransactionsAcrossPortfolios()).toMatchObject({
      status: "empty",
    });

    h.client.listPortfolios = async () => {
      throw new Error("x");
    };
    expect(await api.loadTransactionsAcrossPortfolios()).toMatchObject({
      status: "unavailable",
    });
  });
});

describe("loadPortfolio", () => {
  it("honors the selected portfolio, else falls back to the first", async () => {
    h.client.listPortfolios = async () => PF;
    h.cookies = { pf: "p2" };
    const selected = await api.loadPortfolio(async (_c, p) => p.id);
    expect(selected).toMatchObject({ status: "ok", data: "p2" });

    h.cookies = { pf: "ghost" }; // unknown → first
    const fallback = await api.loadPortfolio(async (_c, p) => p.id);
    expect(fallback).toMatchObject({ status: "ok", data: "p1" });
  });

  it("is empty with no portfolios and unavailable when signed out", async () => {
    h.client.listPortfolios = async () => [];
    expect(await api.loadPortfolio(async () => 1)).toMatchObject({
      status: "empty",
    });
    h.session = null;
    expect(await api.loadPortfolio(async () => 1)).toMatchObject({
      status: "unavailable",
    });
  });
});

describe("aggregate + misc loaders", () => {
  it("loadNetWorth folds ok / empty / unavailable", async () => {
    h.client.listPortfolios = async () => PF;
    h.client.getNetWorth = async () => ({ portfolioCount: 2, netWorth: "100" });
    expect(await api.loadNetWorth()).toMatchObject({ status: "ok" });

    h.client.listPortfolios = async () => [];
    expect(await api.loadNetWorth()).toMatchObject({ status: "empty" });

    h.client.listPortfolios = async () => {
      throw new Error("x");
    };
    expect(await api.loadNetWorth()).toMatchObject({ status: "unavailable" });
  });

  it("loadNetWorth uses the aggregate when no portfolio is selected", async () => {
    h.client.listPortfolios = async () => PF;
    const getNetWorth = vi.fn(async () => ({ portfolioCount: 2, netWorth: "200", xirr: 0.05 }));
    h.client.getNetWorth = getNetWorth;
    h.client.getSummary = vi.fn();
    h.client.getPerformance = vi.fn();

    const res = await api.loadNetWorth();
    expect(res.status).toBe("ok");
    expect(getNetWorth).toHaveBeenCalled();
    expect(h.client.getSummary).not.toHaveBeenCalled();
    expect(h.client.getPerformance).not.toHaveBeenCalled();
  });

  it("loadNetWorth uses getSummary+getPerformance when a portfolio is selected", async () => {
    h.client.listPortfolios = async () => PF;
    h.cookies = { pf: "p2" };
    const getSummary = vi.fn(async () => ({
      holdings: [],
      displayCurrency: "EUR",
      netWorth: "500",
      totalCost: "400",
      totalMarketValue: "500",
      totalUnrealizedPnL: "100",
      totalRealizedPnL: "0",
      totalIncome: "10",
      totalDayChange: "5",
      cash: {},
      exposureByCurrency: {},
    }));
    const getPerformance = vi.fn(async () => ({ xirr: 0.12, netWorth: "500", asOf: "2026-01-01" }));
    h.client.getSummary = getSummary;
    h.client.getPerformance = getPerformance;
    h.client.getNetWorth = vi.fn();

    const res = await api.loadNetWorth();
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.xirr).toBe(0.12);
      expect(res.data.portfolioCount).toBe(1);
      expect(res.data.asOf).toBe("2026-01-01");
    }
    expect(getSummary).toHaveBeenCalledWith("p2", undefined);
    expect(getPerformance).toHaveBeenCalledWith("p2");
    expect(h.client.getNetWorth).not.toHaveBeenCalled();
  });

  it("loadNetWorthHistory uses the aggregate when no portfolio is selected", async () => {
    h.client.listPortfolios = async () => PF;
    const getNetWorthHistory = vi.fn(async (range: string) => [{ date: "2026-01-01", netWorth: range }]);
    h.client.getNetWorthHistory = getNetWorthHistory;
    h.client.getPortfolioHistory = vi.fn();

    expect(await api.loadNetWorthHistory("3m")).toEqual([{ date: "2026-01-01", netWorth: "3m" }]);
    expect(getNetWorthHistory).toHaveBeenCalledWith("3m", undefined);
    expect(h.client.getPortfolioHistory).not.toHaveBeenCalled();
  });

  it("loadNetWorthHistory uses getPortfolioHistory when a portfolio is selected", async () => {
    h.client.listPortfolios = async () => PF;
    h.cookies = { pf: "p2" };
    const getPortfolioHistory = vi.fn(async (id: string, range: string) => [{ date: "2026-01-01", netWorth: `${id}/${range}` }]);
    h.client.getPortfolioHistory = getPortfolioHistory;
    h.client.getNetWorthHistory = vi.fn();

    expect(await api.loadNetWorthHistory("1m")).toEqual([{ date: "2026-01-01", netWorth: "p2/1m" }]);
    expect(getPortfolioHistory).toHaveBeenCalledWith("p2", "1m");
    expect(h.client.getNetWorthHistory).not.toHaveBeenCalled();
  });

  it("loadNetWorthHistory returns [] on failure", async () => {
    h.client.listPortfolios = async () => {
      throw new Error("x");
    };
    expect(await api.loadNetWorthHistory()).toEqual([]);
  });

  it("loadPortfolios values each portfolio's net worth", async () => {
    h.client.listPortfolios = async () => PF;
    h.client.listPortfolioValues = async () => [
      { id: "p1", netWorth: "10" },
      { id: "p2", netWorth: "20" },
    ];
    const res = await api.loadPortfolios();
    expect(res.status).toBe("ok");
    expect(res.portfolios.map((p) => p.netWorth)).toEqual(["10", "20"]);

    h.client.listPortfolios = async () => {
      throw new Error("x");
    };
    expect(await api.loadPortfolios()).toMatchObject({ status: "unavailable" });
  });

  it("loadIncomeStats uses the aggregate, or the per-portfolio twin when selected", async () => {
    h.client.listPortfolios = async () => PF;
    const getIncome = vi.fn(async () => ({ displayCurrency: "IDR", ttm: "12" }));
    const getPortfolioIncome = vi.fn(async (id: string) => ({
      displayCurrency: "EUR",
      ttm: "3",
      _id: id,
    }));
    h.client.getIncome = getIncome;
    h.client.getPortfolioIncome = getPortfolioIncome;

    // No selection → aggregate (no holderId).
    let res = await api.loadIncomeStats();
    expect(res).toMatchObject({ status: "ok" });
    expect(getIncome).toHaveBeenCalledWith(undefined);
    expect(getPortfolioIncome).not.toHaveBeenCalled();

    // Holder scope cookie → passes holderId to getIncome.
    // resolveHolderScope validates: need ≥2 portfolios owned by the holder.
    h.client.listPortfolios = async () => [
      { id: "p1", name: "A", baseCurrency: "IDR", accountHolderId: "holder-abc" },
      { id: "p2", name: "B", baseCurrency: "EUR", accountHolderId: "holder-abc" },
    ];
    h.cookies = { pf: "holder:holder-abc" };
    getIncome.mockClear();
    res = await api.loadIncomeStats();
    expect(res).toMatchObject({ status: "ok" });
    expect(getIncome).toHaveBeenCalledWith("holder-abc");
    expect(getPortfolioIncome).not.toHaveBeenCalled();
    // Restore PF for the next assertion.
    h.client.listPortfolios = async () => PF;

    // A selected portfolio cookie → portfolio path wins.
    h.cookies = { pf: "p2" };
    getIncome.mockClear();
    res = await api.loadIncomeStats();
    expect(res).toMatchObject({ status: "ok" });
    expect(getPortfolioIncome).toHaveBeenCalledWith("p2");
    expect(getIncome).not.toHaveBeenCalled();

    h.cookies = {};
    h.client.listPortfolios = async () => [];
    expect(await api.loadIncomeStats()).toMatchObject({ status: "empty" });
    h.client.listPortfolios = async () => {
      throw new Error("x");
    };
    expect(await api.loadIncomeStats()).toMatchObject({ status: "unavailable" });
  });

  it("loadContributions reads holder scope from the cookie; portfolio cookie wins", async () => {
    h.client.listPortfolios = async () => PF;
    const getContributions = vi.fn(async () => ({ displayCurrency: "IDR", netContributed: "500" }));
    const getPortfolioContributions = vi.fn(async (id: string) => ({
      displayCurrency: "EUR",
      netContributed: "100",
      _id: id,
    }));
    h.client.getContributions = getContributions;
    h.client.getPortfolioContributions = getPortfolioContributions;

    // No selection → aggregate with undefined holderId.
    let res = await api.loadContributions();
    expect(res).toMatchObject({ status: "ok" });
    expect(getContributions).toHaveBeenCalledWith(undefined);

    // Holder scope cookie → aggregate with holderId.
    // resolveHolderScope validates: need ≥2 portfolios owned by the holder.
    h.client.listPortfolios = async () => [
      { id: "p1", name: "A", baseCurrency: "IDR", accountHolderId: "holder-xyz" },
      { id: "p2", name: "B", baseCurrency: "EUR", accountHolderId: "holder-xyz" },
    ];
    h.cookies = { pf: "holder:holder-xyz" };
    getContributions.mockClear();
    res = await api.loadContributions();
    expect(res).toMatchObject({ status: "ok" });
    expect(getContributions).toHaveBeenCalledWith("holder-xyz");
    // Restore PF for the next assertion.
    h.client.listPortfolios = async () => PF;

    // Portfolio selected cookie → per-portfolio path, no holderId.
    h.cookies = { pf: "p1" };
    getContributions.mockClear();
    res = await api.loadContributions();
    expect(res).toMatchObject({ status: "ok" });
    expect(getPortfolioContributions).toHaveBeenCalledWith("p1");
    expect(getContributions).not.toHaveBeenCalled();

    h.cookies = {};
  });

  it("loadInstrument returns the detail bundle or null on error", async () => {
    h.client.getInstrument = async () => ({ id: "i1" });
    h.client.getInstrumentHistory = async () => [{ t: 1 }];
    h.client.listCorporateActions = async () => [];
    expect(await api.loadInstrument("i1")).toMatchObject({
      instrument: { id: "i1" },
    });

    h.client.getInstrument = async () => {
      throw new Error("x");
    };
    expect(await api.loadInstrument("i1")).toBeNull();
  });

  it("loadMe returns the user or null", async () => {
    h.client.me = async () => ({ id: "u1", authSub: "sub" });
    expect(await api.loadMe()).toMatchObject({ id: "u1" });
    h.session = null;
    expect(await api.loadMe()).toBeNull();
  });
});

describe("loadAdminStorageProviders", () => {
  it("returns ok with storage config on success", async () => {
    h.client.getAdminStorageProviders = async () => ({
      activeProvider: "s3",
      s3: { endpoint: "", region: "eu-central-1", bucket: "test", hasSecret: false },
      folder: { path: "./.storage" },
      encryptionEnabled: false,
    });
    const res = await api.loadAdminStorageProviders();
    expect(res).toMatchObject({ status: "ok" });
    expect((res as { status: "ok"; storage: unknown }).storage).toHaveProperty(
      "activeProvider",
      "s3",
    );
  });

  it("returns unavailable when the API throws", async () => {
    h.client.getAdminStorageProviders = async () => {
      throw new Error("forbidden");
    };
    expect(await api.loadAdminStorageProviders()).toMatchObject({
      status: "unavailable",
    });
  });

  it("returns unavailable when not signed in", async () => {
    h.session = null;
    expect(await api.loadAdminStorageProviders()).toMatchObject({
      status: "unavailable",
    });
  });
});

describe("getServerApi when auth is not configured", () => {
  it("returns unavailable even with a session", async () => {
    vi.resetModules();
    delete process.env.AUTH_SECRET;
    const fresh = await import("../src/lib/server-api");
    h.session = { accessToken: "tok" };
    expect(await fresh.loadMe()).toBeNull();
    // restore for any later imports
    process.env.AUTH_SECRET = "test-secret";
  });
});
