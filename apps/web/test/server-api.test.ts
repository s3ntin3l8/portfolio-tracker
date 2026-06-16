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
  h.client = {};
});

describe("getSelectedPortfolioId", () => {
  it("returns the cookie's uuid, or null for 'all'/absent", async () => {
    h.cookies = { pf: "p2" };
    expect(await api.getSelectedPortfolioId()).toBe("p2");
    h.cookies = { pf: "all" };
    expect(await api.getSelectedPortfolioId()).toBeNull();
    h.cookies = {};
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
    });
  });

  it("collapses an unknown/stale id to the aggregate", async () => {
    h.client.listPortfolios = async () => PF;
    h.cookies = { pf: "ghost" };
    const res = await api.resolveSelection();
    expect(res.selectedId).toBeNull();
    expect(res.portfolios).toHaveLength(2);
  });

  it("reports unavailable when not signed in", async () => {
    h.session = null;
    expect(await api.resolveSelection()).toMatchObject({
      status: "unavailable",
      selectedId: null,
    });
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
    expect(getSummary).toHaveBeenCalledWith("p2");
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
    h.client.getNetWorth = async () => ({ portfolioCount: 2, netWorth: "100" });
    expect(await api.loadNetWorth()).toMatchObject({ status: "ok" });

    h.client.getNetWorth = async () => ({ portfolioCount: 0 });
    expect(await api.loadNetWorth()).toMatchObject({ status: "empty" });

    h.client.getNetWorth = async () => {
      throw new Error("x");
    };
    expect(await api.loadNetWorth()).toMatchObject({ status: "unavailable" });
  });

  it("loadNetWorthHistory returns data and [] on failure", async () => {
    h.client.getNetWorthHistory = async (range: string) => [{ date: "2026-01-01", range }];
    expect(await api.loadNetWorthHistory("3m")).toEqual([
      { date: "2026-01-01", range: "3m" },
    ]);
    h.client.getNetWorthHistory = async () => {
      throw new Error("x");
    };
    expect(await api.loadNetWorthHistory()).toEqual([]);
  });

  it("loadPortfolios values each portfolio's net worth", async () => {
    h.client.listPortfolios = async () => PF;
    h.client.getSummary = async (id: string) => ({ netWorth: id === "p1" ? "10" : "20" });
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

    // No selection → aggregate.
    let res = await api.loadIncomeStats();
    expect(res).toMatchObject({ status: "ok" });
    expect(getIncome).toHaveBeenCalled();
    expect(getPortfolioIncome).not.toHaveBeenCalled();

    // A selected portfolio → the scoped endpoint.
    h.cookies = { pf: "p2" };
    res = await api.loadIncomeStats();
    expect(res).toMatchObject({ status: "ok" });
    expect(getPortfolioIncome).toHaveBeenCalledWith("p2");

    h.client.listPortfolios = async () => [];
    expect(await api.loadIncomeStats()).toMatchObject({ status: "empty" });
    h.client.listPortfolios = async () => {
      throw new Error("x");
    };
    expect(await api.loadIncomeStats()).toMatchObject({ status: "unavailable" });
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
