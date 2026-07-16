import type { Portfolio, ApiClient } from "@portfolio/api-client";
import {
  getServerApi,
  listPortfoliosCached,
  getSelectedPortfolioId,
  type PortfolioWithValue,
  type PortfolioResult,
} from "./_shared.js";

export async function loadPortfoliosList(): Promise<{
  status: "ok" | "unavailable";
  portfolios: Portfolio[];
}> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable", portfolios: [] };
  try {
    const list = await listPortfoliosCached();
    return { status: "ok", portfolios: list };
  } catch {
    return { status: "unavailable", portfolios: [] };
  }
}

export async function loadPortfolios(): Promise<{
  status: "ok" | "unavailable";
  portfolios: PortfolioWithValue[];
}> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable", portfolios: [] };
  try {
    const [list, values] = await Promise.all([listPortfoliosCached(), api.listPortfolioValues()]);
    const valueMap = new Map(values.map((v) => [v.id, v.netWorth]));
    const portfolios = list.map((portfolio) => ({
      portfolio,
      netWorth: valueMap.get(portfolio.id) ?? "0",
    }));
    return { status: "ok", portfolios };
  } catch {
    return { status: "unavailable", portfolios: [] };
  }
}

export async function loadPortfolioList(): Promise<Portfolio[]> {
  const api = await getServerApi();
  if (!api) return [];
  try {
    return await listPortfoliosCached();
  } catch {
    return [];
  }
}

export async function loadPortfolio<T>(
  fn: (api: ApiClient, portfolio: Portfolio) => Promise<T>,
): Promise<PortfolioResult<T>> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const portfolios = await listPortfoliosCached();
    if (portfolios.length === 0) return { status: "empty" };
    const wanted = await getSelectedPortfolioId();
    const portfolio = portfolios.find((p) => p.id === wanted) ?? portfolios[0];
    const data = await fn(api, portfolio);
    return { status: "ok", portfolio, data };
  } catch {
    return { status: "unavailable" };
  }
}
